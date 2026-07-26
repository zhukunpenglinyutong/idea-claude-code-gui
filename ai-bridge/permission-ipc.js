/**
 * File-system IPC primitives for permission communication with Java process.
 * Handles request/response file exchange for permissions, questions, and plan approval.
 */
import { writeFileSync, readFileSync, existsSync, unlinkSync, readdirSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// ========== Debug logging ==========
export function debugLog(tag, message, data = null) {
  const timestamp = new Date().toISOString();
  const dataStr = data ? ` | Data: ${JSON.stringify(data)}` : '';
  console.error(`[${timestamp}][PERM_DEBUG][${tag}] ${message}${dataStr}`);
}

export function errorClass(error) {
  return error?.constructor?.name || 'UnknownError';
}

export function describeInputForLog(input) {
  const inputObject = input && typeof input === 'object' ? input : {};
  const questions = Array.isArray(inputObject.questions) ? inputObject.questions : [];
  const allowedPrompts = Array.isArray(inputObject.allowedPrompts) ? inputObject.allowedPrompts : [];
  const plan = typeof inputObject.plan === 'string' ? inputObject.plan : '';

  return {
    keyCount: Object.keys(inputObject).length,
    questionCount: questions.length,
    allowedPromptCount: allowedPrompts.length,
    planLength: plan.length,
  };
}

export function describeAnswersForLog(answers) {
  const answerObject = answers && typeof answers === 'object' ? answers : {};
  return { answerCount: Object.keys(answerObject).length };
}

export function describeContentForLog(content) {
  return { byteLength: Buffer.byteLength(String(content ?? ''), 'utf8') };
}

// Strict-parse the Java -> Node permission response. Only an explicit
// boolean `true` counts as allow; any other shape (string "true", numeric 1,
// missing field, malformed JSON) denies. Prevents a corrupted or partially
// written response file from being read as an accidental allow.
export function parsePermissionAllowResponse(content) {
  try {
    const responseData = JSON.parse(content);
    return responseData?.allow === true;
  } catch {
    return false;
  }
}

// ========== IPC directory and session config ==========
export const PERMISSION_DIR = process.env.CLAUDE_PERMISSION_DIR
  ? process.env.CLAUDE_PERMISSION_DIR
  : join(tmpdir(), 'claude-permission');

export const SESSION_ID = process.env.CLAUDE_SESSION_ID || 'default';

export const DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS = 300;
export const MIN_PERMISSION_DIALOG_TIMEOUT_SECONDS = 30;
export const MAX_PERMISSION_DIALOG_TIMEOUT_SECONDS = 3600;
// Must match PermissionDialogTimeoutSettings.PERMISSION_SAFETY_NET_BUFFER_SECONDS
// in the Java plugin. Only used as a fallback when CLAUDE_PERMISSION_SAFETY_NET_MS
// is absent from the env; the Java side normally supplies the resolved value.
export const SAFETY_NET_BUFFER_SECONDS = 60;

const MIN_PERMISSION_REQUEST_SAFETY_NET_MS = (
  MIN_PERMISSION_DIALOG_TIMEOUT_SECONDS + SAFETY_NET_BUFFER_SECONDS
) * 1000;
const DEFAULT_PERMISSION_REQUEST_SAFETY_NET_MS = (
  DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS + SAFETY_NET_BUFFER_SECONDS
) * 1000;
const MAX_PERMISSION_REQUEST_SAFETY_NET_MS = (
  MAX_PERMISSION_DIALOG_TIMEOUT_SECONDS + SAFETY_NET_BUFFER_SECONDS
) * 1000;

export function resolvePermissionRequestSafetyNetMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_PERMISSION_REQUEST_SAFETY_NET_MS;
  }
  return Math.max(
    MIN_PERMISSION_REQUEST_SAFETY_NET_MS,
    Math.min(MAX_PERMISSION_REQUEST_SAFETY_NET_MS, Math.trunc(parsed))
  );
}

// The webview owns the user-facing countdown; Node only needs a bounded leak-prevention fallback.
export const PERMISSION_REQUEST_SAFETY_NET_MS = resolvePermissionRequestSafetyNetMs(
  process.env.CLAUDE_PERMISSION_SAFETY_NET_MS
);

debugLog('INIT', `Permission dir: ${PERMISSION_DIR}`);
debugLog('INIT', `Session ID: ${SESSION_ID}`);
debugLog('INIT', `tmpdir(): ${tmpdir()}`);
debugLog('INIT', `CLAUDE_PERMISSION_DIR env: ${process.env.CLAUDE_PERMISSION_DIR || 'NOT SET'}`);
debugLog('INIT', `CLAUDE_SESSION_ID env: ${process.env.CLAUDE_SESSION_ID || 'NOT SET'}`);

// Ensure the directory exists.
// mode 0o700: IPC files contain tool inputs and plan text — restrict to the
// owning user on POSIX. Windows ignores the mode bit (NTFS ACLs apply instead).
try {
  mkdirSync(PERMISSION_DIR, { recursive: true, mode: 0o700 });
  debugLog('INIT', 'Permission directory created/verified successfully');
} catch (e) {
  debugLog('INIT_ERROR', `Failed to create permission dir: ${errorClass(e)}`);
}

/**
 * Request AskUserQuestion answers via file system communication with Java process.
 * @param {Object} input - AskUserQuestion tool parameters (contains questions array)
 * @returns {Promise<Object|null>} - User answers object, returns null on failure
 */
export async function requestAskUserQuestionAnswers(input) {
  const requestStartTime = Date.now();
  debugLog('ASK_USER_QUESTION_START', 'Requesting answers for questions', describeInputForLog(input));

  try {
    const requestId = `ask-${randomUUID()}`;
    debugLog('ASK_USER_QUESTION_ID', `Generated request ID: ${requestId}`);

    const requestFile = join(PERMISSION_DIR, `ask-user-question-${SESSION_ID}-${requestId}.json`);
    const responseFile = join(PERMISSION_DIR, `ask-user-question-response-${SESSION_ID}-${requestId}.json`);

    const requestData = {
      requestId,
      toolName: 'AskUserQuestion',
      questions: input.questions || [],
      timestamp: new Date().toISOString(),
      cwd: process.cwd()
    };

    debugLog('ASK_USER_QUESTION_FILE_WRITE', `Writing question request file`, { requestFile, responseFile });

    try {
      writeFileSync(requestFile, JSON.stringify(requestData, null, 2));
      debugLog('ASK_USER_QUESTION_FILE_WRITE_OK', `Question request file written successfully`);

      if (existsSync(requestFile)) {
        debugLog('ASK_USER_QUESTION_FILE_VERIFY', `Question request file exists after write`);
      } else {
        debugLog('ASK_USER_QUESTION_FILE_VERIFY_ERROR', `Question request file does NOT exist after write!`);
      }
    } catch (writeError) {
      debugLog('ASK_USER_QUESTION_FILE_WRITE_ERROR', `Failed to write question request file: ${errorClass(writeError)}`);
      return null;
    }

    const timeout = PERMISSION_REQUEST_SAFETY_NET_MS;
    let pollCount = 0;
    const pollInterval = 100;

    debugLog('ASK_USER_QUESTION_WAIT_START', `Starting to wait for answers (timeout: ${timeout}ms)`);

    while (Date.now() - requestStartTime < timeout) {
      await new Promise(resolve => setTimeout(resolve, pollInterval));
      pollCount++;

      if (pollCount % 50 === 0) {
        const elapsed = Date.now() - requestStartTime;
        debugLog('ASK_USER_QUESTION_WAITING', `Still waiting for answers`, { elapsed: `${elapsed}ms`, pollCount });
      }

      if (existsSync(responseFile)) {
        debugLog('ASK_USER_QUESTION_RESPONSE_FOUND', `Response file found!`);
        try {
          const responseContent = readFileSync(responseFile, 'utf-8');
          debugLog('ASK_USER_QUESTION_RESPONSE_CONTENT', 'Response content read', describeContentForLog(responseContent));

          const responseData = JSON.parse(responseContent);
          const answers = responseData.answers;
          debugLog('ASK_USER_QUESTION_RESPONSE_PARSED', `Parsed answers`, {
            ...describeAnswersForLog(answers),
            elapsed: `${Date.now() - requestStartTime}ms`
          });

          try {
            unlinkSync(responseFile);
            debugLog('ASK_USER_QUESTION_FILE_CLEANUP', `Response file deleted`);
          } catch (cleanupError) {
            debugLog('ASK_USER_QUESTION_FILE_CLEANUP_ERROR', `Failed to delete response file: ${errorClass(cleanupError)}`);
          }

          return answers;
        } catch (e) {
          debugLog('ASK_USER_QUESTION_RESPONSE_ERROR', `Error reading/parsing response: ${errorClass(e)}`);
          return null;
        }
      }
    }

    const elapsed = Date.now() - requestStartTime;
    debugLog('ASK_USER_QUESTION_TIMEOUT', `Timeout waiting for answers`, { elapsed: `${elapsed}ms`, timeout: `${timeout}ms` });
    return null;

  } catch (error) {
    debugLog('ASK_USER_QUESTION_FATAL_ERROR', `Unexpected error: ${errorClass(error)}`);
    return null;
  }
}

/**
 * Request plan approval via file system communication with Java process.
 * @param {Object} input - ExitPlanMode tool parameters (contains allowedPrompts)
 * @returns {Promise<Object>} - { approved: boolean, targetMode: string, message?: string }
 */
export async function requestPlanApproval(input) {
  const requestStartTime = Date.now();
  debugLog('PLAN_APPROVAL_START', 'Requesting plan approval', describeInputForLog(input));

  try {
    const requestId = `plan-${randomUUID()}`;
    debugLog('PLAN_APPROVAL_ID', `Generated request ID: ${requestId}`);

    const requestFile = join(PERMISSION_DIR, `plan-approval-${SESSION_ID}-${requestId}.json`);
    const responseFile = join(PERMISSION_DIR, `plan-approval-response-${SESSION_ID}-${requestId}.json`);

    const plan = typeof input?.plan === 'string' ? input.plan.substring(0, 100000) : '';
    const rawPrompts = Array.isArray(input?.allowedPrompts) ? input.allowedPrompts : [];
    const allowedPrompts = rawPrompts
      .filter(p => p && typeof p.tool === 'string' && typeof p.prompt === 'string')
      .map(p => ({ tool: String(p.tool), prompt: String(p.prompt) }));

    const requestData = {
      requestId,
      toolName: 'ExitPlanMode',
      plan,
      allowedPrompts,
      timestamp: new Date().toISOString(),
      cwd: process.cwd()
    };

    debugLog('PLAN_APPROVAL_FILE_WRITE', `Writing plan approval request file`, { requestFile, responseFile });

    try {
      writeFileSync(requestFile, JSON.stringify(requestData, null, 2));
      debugLog('PLAN_APPROVAL_FILE_WRITE_OK', `Plan approval request file written successfully`);

      if (existsSync(requestFile)) {
        debugLog('PLAN_APPROVAL_FILE_VERIFY', `Plan approval request file exists after write`);
      } else {
        debugLog('PLAN_APPROVAL_FILE_VERIFY_ERROR', `Plan approval request file does NOT exist after write!`);
      }
    } catch (writeError) {
      debugLog('PLAN_APPROVAL_FILE_WRITE_ERROR', `Failed to write plan approval request file: ${errorClass(writeError)}`);
      return { approved: false, message: 'Failed to write plan approval request' };
    }

    const timeout = PERMISSION_REQUEST_SAFETY_NET_MS;
    let pollCount = 0;
    const pollInterval = 100;

    debugLog('PLAN_APPROVAL_WAIT_START', `Starting to wait for plan approval response (timeout: ${timeout}ms)`);

    while (Date.now() - requestStartTime < timeout) {
      await new Promise(resolve => setTimeout(resolve, pollInterval));
      pollCount++;

      if (pollCount % 100 === 0) {
        const elapsed = Date.now() - requestStartTime;
        debugLog('PLAN_APPROVAL_WAITING', `Still waiting for plan approval`, { elapsed: `${elapsed}ms`, pollCount });
      }

      if (existsSync(responseFile)) {
        debugLog('PLAN_APPROVAL_RESPONSE_FOUND', `Response file found!`);
        try {
          const responseContent = readFileSync(responseFile, 'utf-8');
          debugLog('PLAN_APPROVAL_RESPONSE_CONTENT', 'Response content read', describeContentForLog(responseContent));

          const responseData = JSON.parse(responseContent);
          const approved = responseData.approved === true;
          const targetMode = responseData.targetMode || 'default';
          const message = responseData.message;

          debugLog('PLAN_APPROVAL_RESPONSE_PARSED', `Parsed response`, {
            approved,
            targetMode,
            elapsed: `${Date.now() - requestStartTime}ms`
          });

          try {
            unlinkSync(responseFile);
            debugLog('PLAN_APPROVAL_FILE_CLEANUP', `Response file deleted`);
          } catch (cleanupError) {
            debugLog('PLAN_APPROVAL_FILE_CLEANUP_ERROR', `Failed to delete response file: ${errorClass(cleanupError)}`);
          }

          return { approved, targetMode, message };
        } catch (e) {
          debugLog('PLAN_APPROVAL_RESPONSE_ERROR', `Error reading/parsing response: ${errorClass(e)}`);
          return { approved: false, message: 'Failed to parse plan approval response' };
        }
      }
    }

    const elapsed = Date.now() - requestStartTime;
    debugLog('PLAN_APPROVAL_TIMEOUT', `Timeout waiting for plan approval`, { elapsed: `${elapsed}ms`, timeout: `${timeout}ms` });
    return { approved: false, message: 'Plan approval timed out' };

  } catch (error) {
    debugLog('PLAN_APPROVAL_FATAL_ERROR', `Unexpected error: ${errorClass(error)}`);
    return { approved: false, message: 'Unexpected plan approval error' };
  }
}

/**
 * Request permission via file system communication with Java process.
 * @param {string} toolName - Tool name
 * @param {Object} input - Tool parameters
 * @returns {Promise<boolean>} - Whether allowed
 */
export async function requestPermissionFromJava(toolName, input) {
  const requestStartTime = Date.now();
  debugLog('REQUEST_START', `Tool: ${toolName}`, describeInputForLog(input));

  try {
    try {
      const existingFiles = readdirSync(PERMISSION_DIR);
      debugLog('DIR_CONTENTS', `Files in permission dir (before request)`, { files: existingFiles });
    } catch (e) {
      debugLog('DIR_ERROR', `Cannot read permission dir: ${errorClass(e)}`);
    }

    const requestId = randomUUID();
    debugLog('REQUEST_ID', `Generated request ID: ${requestId}`);

    const requestFile = join(PERMISSION_DIR, `request-${SESSION_ID}-${requestId}.json`);
    const responseFile = join(PERMISSION_DIR, `response-${SESSION_ID}-${requestId}.json`);

    const requestData = {
      requestId,
      toolName,
      inputs: input,
      timestamp: new Date().toISOString(),
      cwd: process.cwd()
    };

    debugLog('FILE_WRITE', `Writing request file`, { requestFile, responseFile });

    try {
      writeFileSync(requestFile, JSON.stringify(requestData, null, 2));
      debugLog('FILE_WRITE_OK', `Request file written successfully`);

      if (existsSync(requestFile)) {
        debugLog('FILE_VERIFY', `Request file exists after write`);
      } else {
        debugLog('FILE_VERIFY_ERROR', `Request file does NOT exist after write!`);
      }
    } catch (writeError) {
      debugLog('FILE_WRITE_ERROR', `Failed to write request file: ${errorClass(writeError)}`);
      return false;
    }

    const timeout = PERMISSION_REQUEST_SAFETY_NET_MS;
    let pollCount = 0;
    const pollInterval = 100;

    debugLog('WAIT_START', `Starting to wait for response (timeout: ${timeout}ms)`);

    while (Date.now() - requestStartTime < timeout) {
      await new Promise(resolve => setTimeout(resolve, pollInterval));
      pollCount++;

      if (pollCount % 50 === 0) {
        const elapsed = Date.now() - requestStartTime;
        debugLog('WAITING', `Still waiting for response`, { elapsed: `${elapsed}ms`, pollCount });

        const reqFileExists = existsSync(requestFile);
        const respFileExists = existsSync(responseFile);
        debugLog('FILE_STATUS', `File status check`, {
          requestFileExists: reqFileExists,
          responseFileExists: respFileExists
        });
      }

      if (existsSync(responseFile)) {
        debugLog('RESPONSE_FOUND', `Response file found!`);
        try {
          const responseContent = readFileSync(responseFile, 'utf-8');
          debugLog('RESPONSE_CONTENT', 'Response content read', describeContentForLog(responseContent));

          const result = parsePermissionAllowResponse(responseContent);
          debugLog('RESPONSE_PARSED', `Parsed response`, { allow: result, elapsed: `${Date.now() - requestStartTime}ms` });

          try {
            unlinkSync(responseFile);
            debugLog('FILE_CLEANUP', `Response file deleted`);
          } catch (cleanupError) {
            debugLog('FILE_CLEANUP_ERROR', `Failed to delete response file: ${errorClass(cleanupError)}`);
          }

          return result;
        } catch (e) {
          debugLog('RESPONSE_ERROR', `Error reading/parsing response: ${errorClass(e)}`);
          return false;
        }
      }
    }

    const elapsed = Date.now() - requestStartTime;
    debugLog('TIMEOUT', `Timeout waiting for response`, { elapsed: `${elapsed}ms`, timeout: `${timeout}ms` });

    const reqFileExists = existsSync(requestFile);
    const respFileExists = existsSync(responseFile);
    debugLog('TIMEOUT_FILE_STATUS', `File status at timeout`, {
      requestFileExists: reqFileExists,
      responseFileExists: respFileExists
    });

    return false;

  } catch (error) {
    debugLog('FATAL_ERROR', `Unexpected error in requestPermissionFromJava: ${errorClass(error)}`);
    return false;
  }
}

/**
 * Permission Handler — thin coordinator.
 * Provides the `canUseTool` callback for Claude SDK.
 *
 * IPC primitives: ./permission-ipc.js
 * Path safety:    ./permission-safety.js
 */

import {
  debugLog,
  describeAnswersForLog,
  describeInputForLog,
  requestAskUserQuestionAnswers,
  requestPermissionFromJava,
  requestPlanApproval,
} from './permission-ipc.js';
import { rewriteToolInputPaths, isDangerousPath, collectToolInputPaths } from './permission-safety.js';

// ========== Tool categories for permission control ==========

// READ_ONLY tools: pure read operations with no side effects.
// These are a subset of SAFE_ALWAYS_ALLOW_TOOLS and are auto-allowed in all modes.
// Kept as a separate set for semantic clarity and acceptEdits mode fallback checks.
export const READ_ONLY_TOOLS = new Set([
  'Glob',           // Find files by pattern
  'Grep',           // Search file contents
  'Read',           // Read files/images/PDFs
  'ListMcpResourcesTool',   // List MCP resources
  'ReadMcpResourceTool',    // Read MCP resource
]);

// SAFE_ALWAYS_ALLOW_TOOLS: Tools that are inherently safe and always auto-allowed
// without prompting in ANY permission mode (including default).
// These tools have no dangerous side effects and don't need permission checks.
// Matches CLI's SAFE_YOLO_ALLOWLISTED_TOOLS (classifierDecision.ts)
//
// NOTE: WebFetch, WebSearch, and Skill are NOT in this list because they have
// their own checkPermissions logic in CLI (URL checks, skill property checks).
// They go through canUseTool for proper permission handling.
export const SAFE_ALWAYS_ALLOW_TOOLS = new Set([
  // Search / discovery (no side effects)
  'ToolSearch',       // Search/select deferred tools
  // Read-only tools (also safe in all modes)
  'Glob',             // Find files by pattern
  'Grep',             // Search file contents
  'Read',             // Read files/images/PDFs
  'LSP',              // Language server protocol queries
  'ListMcpResourcesTool',   // List MCP resources
  'ReadMcpResourceTool',    // Read MCP resource
  // Task management (metadata only, no file side effects)
  'TodoWrite',        // Manage task checklist
  'TaskCreate',       // Create a task in task list
  'TaskGet',          // Get a task by ID
  'TaskUpdate',       // Update a task
  'TaskList',         // List all tasks
  'TaskStop',         // Stop a background task
  'TaskOutput',       // Read task output
  // Plan mode / UI
  'AskUserQuestion',  // Ask user questions (interactive but safe)
  'EnterPlanMode',    // Enter planning mode
  'ExitPlanMode',     // Exit plan mode (triggers approval dialog)
  // Agent coordination
  'SendMessage',      // Send message to agent (agent has own permission checks)
  // Misc safe
  'Sleep',            // Sleep/wait tool
]);

// EDIT tools: auto-allowed in acceptEdits mode
export const EDIT_TOOLS = new Set([
  'Edit',           // Modify file contents
  'MultiEdit',      // Multi-location edit
  'Write',          // Create/overwrite files
  'NotebookEdit',   // Edit Jupyter notebook cells
  'CreateDirectory', // Create directories
  'MoveFile',       // Move/rename files
  'CopyFile',       // Copy files
  'Rename',         // Rename files
]);

// EXECUTION tools: always require permission (except bypassPermissions mode)
export const EXECUTION_TOOLS = new Set([
  'Bash',           // Execute shell commands
  'Agent',          // Launch sub-agents (agent has own permission checks but launch needs approval)
]);

// Re-export IPC functions for consumers that import from permission-handler
export { requestPlanApproval, requestPermissionFromJava };

/**
 * canUseTool callback function.
 * Used by Claude SDK.
 * Signature: (toolName: string, input: ToolInput, options: { signal: AbortSignal; suggestions?: PermissionUpdate[] }) => Promise<PermissionResult>
 * SDK expected return format: { behavior: 'allow' | 'deny', updatedInput?: object, message?: string }
 */
export async function canUseTool(toolName, input, options = {}) {
  const callStartTime = Date.now();
  debugLog('CAN_USE_TOOL', '========== CALLED ==========');
  debugLog('CAN_USE_TOOL', `toolName: ${toolName}`);
  debugLog('CAN_USE_TOOL', 'inputMetadata', describeInputForLog(input));
  debugLog('CAN_USE_TOOL', `options: ${options ? 'present' : 'undefined'}`);
  debugLog('CAN_USE_TOOL', `Called with tool: ${toolName}`, describeInputForLog(input));

  // Special handling for the AskUserQuestion tool
  if (toolName === 'AskUserQuestion') {
    debugLog('ASK_USER_QUESTION', 'Handling AskUserQuestion tool', describeInputForLog(input));

    const answers = await requestAskUserQuestionAnswers(input);
    const elapsed = Date.now() - callStartTime;

    if (answers !== null) {
      debugLog('ASK_USER_QUESTION_SUCCESS', 'User provided answers', {
        ...describeAnswersForLog(answers),
        elapsed: `${elapsed}ms`
      });
      return {
        behavior: 'allow',
        updatedInput: {
          questions: input.questions || [],
          answers: answers
        }
      };
    } else {
      debugLog('ASK_USER_QUESTION_FAILED', 'Failed to get answers from user', { elapsed: `${elapsed}ms` });
      return {
        behavior: 'deny',
        message: 'User did not provide answers'
      };
    }
  }

  // Rewrite paths like /tmp to the project root directory
  const rewriteResult = rewriteToolInputPaths(toolName, input);
  if (rewriteResult.changed) {
    debugLog('PATH_REWRITE', `Paths were rewritten for tool: ${toolName}`, describeInputForLog(input));
  }

  // Deny if no tool name is provided
  if (!toolName) {
    debugLog('ERROR', 'No tool name provided, denying');
    return {
      behavior: 'deny',
      message: 'Tool name is required'
    };
  }

  // Check for dangerous paths before allowing.
  // Security (K): screen ALL path-bearing fields (file_path, path, notebook_path,
  // MultiEdit edits[]) and Bash command strings — not just file_path/path — so e.g.
  // `cat ~/.ssh/id_rsa` issued via Bash is also denied, closing the shell-bypass gap.
  const dangerousPath = collectToolInputPaths(toolName, input).find(isDangerousPath);
  if (dangerousPath) {
    debugLog('SECURITY', 'Dangerous path detected, denying', {
      toolName,
      pathLength: String(dangerousPath).length,
    });
    return {
      behavior: 'deny',
      message: 'Access to a sensitive path is not allowed for security reasons'
    };
  }

  // SAFE_ALWAYS_ALLOW_TOOLS can be auto-allowed (no side effects, no permission needed).
  // EXCEPTION: ExitPlanMode needs the plan approval dialog — it must go through
  // requestPermissionFromJava (which triggers the Java-side approval UI).
  // In CLI, ExitPlanMode.checkPermissions() returns 'ask' to trigger the dialog;
  // here we achieve the same by not auto-approving it.
  if (SAFE_ALWAYS_ALLOW_TOOLS.has(toolName) && toolName !== 'ExitPlanMode') {
    debugLog('AUTO_ALLOW', `Auto-allowing safe tool: ${toolName}`);
    return {
      behavior: 'allow',
      updatedInput: input
    };
  }

  // All other tools require explicit permission
  debugLog('PERMISSION_NEEDED', `Tool ${toolName} requires permission, calling requestPermissionFromJava`);
  const allowed = await requestPermissionFromJava(toolName, input);
  const elapsed = Date.now() - callStartTime;

  if (allowed) {
    debugLog('PERMISSION_GRANTED', `User allowed ${toolName}`, { elapsed: `${elapsed}ms` });
    return {
      behavior: 'allow',
      updatedInput: input
    };
  } else {
    debugLog('PERMISSION_DENIED', `User denied ${toolName}`, { elapsed: `${elapsed}ms` });
    return {
      behavior: 'deny',
      message: `User denied permission for ${toolName} tool`
    };
  }
}

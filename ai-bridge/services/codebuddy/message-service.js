/**
 * CodeBuddy Agent SDK streaming adapter.
 * The adapter deliberately emits the same marker protocol used by the other
 * providers so Java and the webview do not need a provider-specific renderer.
 */
import { loadCodeBuddySdk, requireSdk } from '../../utils/sdk-loader.js';
import { resolveCodeBuddyCliPath } from '../../utils/cli-path.js';

const VALID_PERMISSION_MODES = new Set(['default', 'acceptEdits', 'bypassPermissions', 'plan']);
const VALID_REASONING_EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

function log(...args) {
  console.error('[CodeBuddy]', ...args);
}

function asText(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  if (typeof value.text === 'string') return value.text;
  if (typeof value.thinking === 'string') return value.thinking;
  if (Array.isArray(value.content)) return value.content.map(asText).filter(Boolean).join('');
  return '';
}

function emitMessage(message) {
  process.stdout.write(`[MESSAGE] ${JSON.stringify(message)}\n`);
}

function emitDelta(marker, value) {
  if (value) process.stdout.write(`[${marker}] ${JSON.stringify(value)}\n`);
}

function getStreamEventText(event) {
  const delta = event?.delta || event?.content_block || event?.data;
  if (!delta) return { text: '', thinking: '' };
  if (delta.type === 'text_delta' || delta.type === 'text') {
    return { text: asText(delta), thinking: '' };
  }
  if (delta.type === 'thinking_delta' || delta.type === 'thinking') {
    return { text: '', thinking: asText(delta) };
  }
  return { text: '', thinking: '' };
}

function normalizePermissionMode(value) {
  return VALID_PERMISSION_MODES.has(value) ? value : 'default';
}

export function buildPromptWithAttachments(message, attachments) {
  const validAttachments = Array.isArray(attachments)
    ? attachments.filter((attachment) => attachment && typeof attachment === 'object')
    : [];
  if (validAttachments.length === 0) return message || '';

  let budget = MAX_TOTAL_ATTACHMENT_PROMPT_CHARS;
  const parts = [];
  for (const attachment of validAttachments) {
    if (budget <= 0) {
      parts.push(`- ${describeAttachment(attachment)} — skipped: prompt size limit reached`);
      continue;
    }
    const rendered = renderAttachment(attachment, budget);
    budget -= rendered.length;
    parts.push(`- ${rendered}`);
  }
  return `${message || ''}\n\n## Attachments\n${parts.join('\n')}`.trim();
}

/** Per-attachment embedded content cap (chars of prompt text / base64). */
const MAX_ATTACHMENT_CONTENT_CHARS = 60_000;
/** Total prompt budget for all attachments combined. */
const MAX_TOTAL_ATTACHMENT_PROMPT_CHARS = 200_000;

function describeAttachment(attachment) {
  const fileName = String(attachment.fileName || 'attachment');
  const mediaType = String(attachment.mediaType || 'application/octet-stream');
  return `${fileName} (${mediaType})`;
}

function decodeBase64Utf8(data) {
  try {
    return Buffer.from(data, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

function isTextMediaType(mediaType, fileName = '') {
  if (/^text\//i.test(mediaType)
    || /^application\/(json|xml|javascript|ecmascript|x-yaml|yaml|toml|sql|x-sh|x-httpd-php|graphql)/i.test(mediaType)
    || /^image\/svg\+xml/i.test(mediaType)) {
    return true;
  }
  // Generic media type but a recognizable source/config file extension —
  // treat it as text so the content gets inlined.
  return /\.(txt|md|markdown|json|ya?ml|toml|xml|svg|csv|log|ini|cfg|conf|properties|sql|sh|bat|ps1|py|js|jsx|ts|tsx|java|kt|c|h|cpp|hpp|cs|go|rs|rb|php|html?|css|scss|less|vue|gradle|lock)$/i.test(fileName);
}

function renderAttachment(attachment, budget) {
  const fileName = String(attachment.fileName || 'attachment');
  const mediaType = String(attachment.mediaType || 'application/octet-stream');
  const data = typeof attachment.data === 'string' ? attachment.data : '';

  // Images go in as markdown data URLs — the CLI forwards them to the
  // multimodal backend. Oversized images are skipped explicitly rather than
  // silently ballooning the prompt.
  if (mediaType.startsWith('image/') && data) {
    if (data.length > MAX_ATTACHMENT_CONTENT_CHARS || data.length > budget) {
      return `${describeAttachment(attachment)} — skipped: image too large (${Math.round(data.length * 3 / 4 / 1024)} KB)`;
    }
    return `![${fileName}](data:${mediaType};base64,${data})`;
  }

  // Text-like attachments are inlined so the model actually sees the content.
  if (data && isTextMediaType(mediaType, fileName)) {
    const decoded = decodeBase64Utf8(data);
    if (!decoded) {
      return `${describeAttachment(attachment)} — skipped: content could not be decoded`;
    }
    if (decoded.length > MAX_ATTACHMENT_CONTENT_CHARS || decoded.length > budget) {
      const clipped = decoded.slice(0, Math.max(0, Math.min(MAX_ATTACHMENT_CONTENT_CHARS, budget)));
      return `File: ${fileName} (${mediaType}) — first ${clipped.length} characters (file truncated):\n\`\`\`\n${clipped}\n\`\`\``;
    }
    return `File: ${fileName} (${mediaType}):\n\`\`\`\n${decoded}\n\`\`\``;
  }

  // Binary / unknown attachments: state explicitly that the content was NOT
  // sent, instead of the old silent name-only placeholder.
  if (data) {
    return `${describeAttachment(attachment)} — skipped: binary content cannot be inlined`;
  }
  return `${describeAttachment(attachment)} — no content provided`;
}

export function normalizeReasoningEffort(value) {
  const effort = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return VALID_REASONING_EFFORTS.has(effort) ? effort : '';
}

export function buildQueryOptions({ cwd, permissionMode, model, sessionId, reasoningEffort }) {
  const mode = normalizePermissionMode(permissionMode);
  const options = {
    cwd: cwd && cwd.trim() ? cwd : process.cwd(),
    permissionMode: mode,
    allowDangerouslySkipPermissions: mode === 'bypassPermissions',
    settingSources: ['user', 'project', 'local'],
    includePartialMessages: true,
    persistSession: true,
    maxTurns: 1000,
  };
  const effort = normalizeReasoningEffort(reasoningEffort);
  if (effort) options.effort = effort;
  if (model && model.trim()) options.model = model.trim();
  if (sessionId && sessionId.trim()) options.resume = sessionId.trim();
  return options;
}

/** Return only the newly appended part of an assistant snapshot. */
export function computeAssistantSnapshotDelta(snapshot, previousSnapshot, emittedText, allowRepeat = false) {
  if (!snapshot) return '';
  if (previousSnapshot) {
    if (snapshot === previousSnapshot) return '';
    if (snapshot.startsWith(previousSnapshot)) return snapshot.slice(previousSnapshot.length);
    if (previousSnapshot.startsWith(snapshot)) return '';
  }
  if (!allowRepeat && emittedText) {
    if (emittedText.endsWith(snapshot)) return '';
    if (snapshot.startsWith(emittedText)) return snapshot.slice(emittedText.length);
  }
  return snapshot;
}

/**
 * Extract a human-readable error from an SDK result message, or null when the
 * result is a success. The Agent SDK reports failures such as
 * error_max_turns / error_during_execution as result messages (is_error or a
 * non-success subtype) instead of throwing — treating them as success would
 * leave the user with an empty reply and no error.
 */
export function getResultError(msg) {
  if (!msg || msg.type !== 'result') return null;
  const subtype = typeof msg.subtype === 'string' ? msg.subtype : '';
  const isError = msg.is_error === true || (subtype && subtype !== 'success' && subtype !== 'usage');
  if (!isError) return null;
  if (Array.isArray(msg.errors)) {
    const joined = msg.errors.filter(e => typeof e === 'string' && e.trim()).join('; ');
    if (joined) return joined;
  }
  if (typeof msg.error === 'string' && msg.error.trim()) return msg.error;
  if (msg.error && typeof msg.error.message === 'string' && msg.error.message.trim()) {
    return msg.error.message;
  }
  if (typeof msg.result === 'string' && msg.result.trim()) return msg.result;
  return subtype ? `CodeBuddy run failed (${subtype})` : 'CodeBuddy run failed';
}

export async function sendMessage(
  message,
  sessionId = '',
  cwd = '',
  permissionMode = 'default',
  model = '',
  reasoningEffort = '',
  attachments = [],
) {
  let streamStarted = false;
  // Graceful interruption: Java terminates the channel with SIGTERM on Unix
  // (taskkill /F /T on Windows) so the SDK gets a chance to stop and clean up
  // its own CLI child process instead of being orphaned. Declared before the
  // try so the finally block can always detach the handlers.
  const abortController = new AbortController();
  const onTerminate = () => abortController.abort();
  process.once('SIGTERM', onTerminate);
  process.once('SIGINT', onTerminate);
  try {
    requireSdk('codebuddy');
    const sdk = await loadCodeBuddySdk();
    const query = sdk?.query
      || (typeof sdk?.default === 'function' ? sdk.default : sdk?.default?.query);
    if (typeof query !== 'function') {
      throw new Error('CodeBuddy Agent SDK query function not available. Please reinstall dependencies.');
    }

    const workingDirectory = cwd && cwd.trim() ? cwd : process.cwd();
    const codeBuddyCliPath = resolveCodeBuddyCliPath();
    const options = buildQueryOptions({
      cwd: workingDirectory,
      permissionMode,
      model,
      sessionId,
      reasoningEffort,
    });
    options.abortController = abortController;
    if (codeBuddyCliPath) options.pathToCodebuddyCode = codeBuddyCliPath;
    if (sessionId && sessionId.trim()) {
      log('resuming session', sessionId.trim());
    }

    process.stdout.write('[MESSAGE_START]\n[STREAM_START]\n');
    streamStarted = true;
    let currentSessionId = sessionId || '';
    let runError = null;
    let assistantText = '';
    let currentTurnText = '';
    let lastAssistantSnapshot = '';
    let allowSnapshotRepeat = false;
    const assistantSnapshots = new Map();

    for await (const rawMessage of query({
      prompt: buildPromptWithAttachments(message, attachments),
      options,
    })) {
      const msg = rawMessage || {};
      if (msg.type === 'system' && msg.session_id) {
        currentSessionId = msg.session_id;
        process.stdout.write(`[SESSION_ID] ${msg.session_id}\n`);
      }

      if (msg.type === 'stream_event' || msg.type === 'partial') {
        const delta = getStreamEventText(msg.event || msg);
        if (delta.text) {
          assistantText += delta.text;
          emitDelta('CONTENT_DELTA', delta.text);
        }
        if (delta.thinking) emitDelta('THINKING_DELTA', delta.thinking);
        continue;
      }

      // Preserve tool calls and tool results for the transcript. Plain text
      // assistant snapshots are already represented by CONTENT_DELTA.
      const content = msg.message?.content ?? msg.content;
      const hasToolBlock = Array.isArray(content)
        && content.some(block => block?.type === 'tool_use' || block?.type === 'tool_result');
      if (msg.type !== 'assistant' || hasToolBlock) emitMessage(msg);

      if (msg.type === 'assistant' && !hasToolBlock) {
        const text = asText(content);
        if (text) {
          const snapshotId = msg.uuid || msg.id || msg.message?.uuid || msg.message?.id || '';
          const previousSnapshot = snapshotId
            ? assistantSnapshots.get(snapshotId) || ''
            : lastAssistantSnapshot;
          const delta = computeAssistantSnapshotDelta(
            text,
            previousSnapshot,
            currentTurnText,
            allowSnapshotRepeat,
          );
          if (delta) {
            assistantText += delta;
            currentTurnText += delta;
            emitDelta('CONTENT_DELTA', delta);
          }
          if (snapshotId) assistantSnapshots.set(snapshotId, text);
          lastAssistantSnapshot = text;
          allowSnapshotRepeat = false;
        }
      }

      if (msg.type === 'result') {
        // A subsequent assistant snapshot may be a new turn with the same
        // text; do not suppress it as a duplicate of the previous turn.
        allowSnapshotRepeat = true;
        lastAssistantSnapshot = '';
        currentTurnText = '';
        assistantSnapshots.clear();
        const usage = msg.usage || msg.modelUsage;
        if (usage) process.stdout.write(`[USAGE] ${JSON.stringify(usage)}\n`);
        // The final result wins: a later successful turn clears an earlier
        // turn's error (and vice versa).
        runError = getResultError(msg);
      }
    }

    if (!assistantText && !runError) log('completed without a text response; tool messages were preserved');
    if (streamStarted) process.stdout.write('[STREAM_END]\n');
    process.stdout.write('[MESSAGE_END]\n');
    if (runError) {
      // Mirror the catch-path wire shape so Java surfaces the failure instead
      // of a silent empty success.
      const payload = { success: false, error: runError, sessionId: currentSessionId };
      console.error('[SEND_ERROR]', JSON.stringify(payload));
      process.stdout.write(`[SEND_ERROR] ${JSON.stringify(payload)}\n`);
      process.stdout.write(`${JSON.stringify(payload)}\n`);
      return;
    }
    process.stdout.write(`${JSON.stringify({ success: true, sessionId: currentSessionId })}\n`);
  } catch (error) {
    if (streamStarted) process.stdout.write('[STREAM_END]\n');
    const payload = { success: false, error: error?.message || String(error) };
    console.error('[SEND_ERROR]', JSON.stringify(payload));
    process.stdout.write(`[SEND_ERROR] ${JSON.stringify(payload)}\n`);
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  } finally {
    process.removeListener('SIGTERM', onTerminate);
    process.removeListener('SIGINT', onTerminate);
  }
}

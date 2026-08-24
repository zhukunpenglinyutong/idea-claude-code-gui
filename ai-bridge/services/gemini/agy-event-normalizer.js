/**
 * Normalize Antigravity CLI stream-json NDJSON events → Claude-compatible bridge tags.
 *
 * Official headless events (https://antigravity.google/docs/cli/headless):
 *   init → step_update* → result
 *
 * Tags match Grok/Claude Java parsers:
 *   [MESSAGE_START] [STREAM_START] [CONTENT_DELTA] [MESSAGE] [TOOL_RESULT]
 *   [USAGE] [SESSION_ID] [STREAM_END] [MESSAGE_END] [SEND_ERROR]
 */

import { normalizeUsageToSnakeCase, extractAgyContextTokens } from './agy-utils.js';

/**
 * Render a tool_info.error value for the result body. It can be an object
 * ({message,type} — or any shape like {code:'ENOENT'}), an array, a plain
 * string, or another JSON value (number); anything must become readable text.
 */
function errToText(err) {
  // Empty/whitespace-only string errors keep the pre-diff 'tool error'
  // label — a bare trailing "Error: " line carries no diagnostic.
  if (typeof err === 'string') return err.trim() ? err : 'tool error';
  if (err && typeof err === 'object') {
    // Only take message/type when they are strings themselves — an object
    // message (String(obj) → "[object Object]") must reach the stringify
    // branch instead.
    if (typeof err.message === 'string' && err.message) return err.message;
    if (typeof err.type === 'string' && err.type) return err.type;
    try {
      return JSON.stringify(err);
    } catch {
      // non-serializable — fall through to the generic string
    }
  }
  return String(err);
}

export class AgyEventNormalizer {
  constructor({ log = console.log, error = console.error } = {}) {
    this.log = log;
    this.error = error;
    this.assistantText = '';
    this.streamStarted = false;
    this.messageStarted = false;
    this.streamEnded = false;
    this.messageEnded = false;
    this.conversationId = null;
    this.lastUsage = null;
    /** Read-only slash command answer (command_result), when the turn was one. */
    this.commandResult = null;
    /** Peak context tokens seen this turn (ignore tiny checkpoint regressions). */
    this.peakContextTokens = 0;
    this.emittedToolKeys = new Set();
    this.emittedToolUses = new Set();
    this.emittedToolResults = new Set();
    this._terminalError = null;
    this._terminalStatus = null;
  }

  begin() {
    this.lastUsage = null;
    this.peakContextTokens = 0;
    this.assistantText = '';
    this.commandResult = null;
    this.emittedToolKeys = new Set();
    this.emittedToolUses = new Set();
    this.emittedToolResults = new Set();
    this._terminalError = null;
    this._terminalStatus = null;
    this.streamEnded = false;
    this.messageEnded = false;
    this._emit('[MESSAGE_START]');
    this.messageStarted = true;
    this._emit('[STREAM_START]');
    this.streamStarted = true;
  }

  /**
   * @param {object} eventObj parsed NDJSON line from agy stream-json
   */
  handleStreamEvent(eventObj) {
    if (!eventObj || typeof eventObj !== 'object') return;
    const event = eventObj.event;

    if (event === 'init') {
      const cid = eventObj.conversation_id || eventObj.init?.conversation_id;
      if (cid) {
        this.conversationId = cid;
        this._emit(`[SESSION_ID] ${cid}`);
      }
      return;
    }

    if (event === 'step_update') {
      this._handleStepUpdate(eventObj.step_update || {});
      return;
    }

    // agy ≥ 1.1.11: read-only slash commands (/usage, /model, …) answer via
    // command_result without an agent turn; the text also arrives in the
    // terminal result event. Keep command data for callers that want it, but
    // never treat the pair as a failure.
    if (event === 'command_result') {
      this.commandResult = eventObj.command || null;
      return;
    }

    if (event === 'result') {
      this._handleResult(eventObj.result || eventObj);
      return;
    }
  }

  _handleStepUpdate(step) {
    if (!step || typeof step !== 'object') return;

    if (step.conversation_id && !this.conversationId) {
      this.conversationId = step.conversation_id;
      this._emit(`[SESSION_ID] ${this.conversationId}`);
    }

    const usage = normalizeUsageToSnakeCase(step.usage);
    if (usage) {
      this._maybeEmitUsage(usage, { authoritative: false });
    }

    const stepType = String(step.step_type || '').toLowerCase();
    const state = String(step.state || '').toUpperCase();

    if (stepType === 'agent_response' || stepType === 'planner_response') {
      const delta = step.text_delta;
      if (delta != null && String(delta).length > 0) {
        const text = String(delta);
        this.assistantText += text;
        this._emit(`[CONTENT_DELTA] ${JSON.stringify(text)}`);
      }
    }

    if (stepType === 'thinking' || stepType === 'agent_thought' || step.thinking_delta) {
      const t = step.thinking_delta ?? step.text_delta;
      if (t != null && String(t).length > 0) {
        this._emit(`[THINKING_DELTA] ${JSON.stringify(String(t))}`);
      }
    }

    // Handle planner_response / agent_response tool_calls array if present
    if (Array.isArray(step.tool_calls) && step.tool_calls.length > 0) {
      step.tool_calls.forEach((call, idx) => {
        const toolName = call.name || 'tool';
        const params = call.args || call.parameters || {};
        const callId = `agy-tool-${step.step_index ?? 'x'}-${idx}`;
        this._emitToolUse(callId, toolName, params);
      });
    }

    if (stepType === 'tool' || step.tool_info || step.tool_name) {
      this._emitTool(step);
    }

    if (step.subagent_info && state === 'DONE') {
      try {
        const info = step.subagent_info;
        const names = Array.isArray(info.subagents)
          ? info.subagents.map((s) => s.type_name || s.role || 'subagent').join(', ')
          : 'subagent';
        this._emit(`[TOOL_RESULT] ${JSON.stringify({
          type: 'tool_result',
          tool_use_id: `subagent-${step.step_index ?? 'x'}`,
          content: `Subagent: ${names}`,
          is_error: false,
          _meta: { kind: 'subagent', subagent_info: info },
        })}`);
      } catch {
        // ignore
      }
    }
  }

  _emitToolUse(toolCallId, name, params) {
    if (this.emittedToolUses.has(toolCallId)) return;
    this.emittedToolUses.add(toolCallId);

    const toolUseMsg = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: toolCallId,
            name: name || 'tool',
            input: typeof params === 'object' && params !== null ? params : { value: params },
          },
        ],
      },
    };
    this._emit(`[MESSAGE] ${JSON.stringify(toolUseMsg)}`);
    this._emit('[BLOCK_RESET]');
  }

  _emitTool(step) {
    const info = step.tool_info || {};
    const name = info.name || step.tool_name || 'tool';
    const params = info.parameters || step.parameters || {};
    const state = String(step.state || '').toUpperCase();
    const stepIndex = step.step_index ?? 'x';
    const toolCallId = `agy-tool-${stepIndex}`;

    // Always emit tool_use card to UI on first sight / ACTIVE state
    this._emitToolUse(toolCallId, name, params);

    const output = info.output != null ? String(info.output) : '';
    const err = info.error;
    // info.error can be anything present — an object ({message,type} or e.g.
    // {code:'ENOENT'}), an array, a plain string, or another JSON value
    // (number, ""). All must mark the result as failed, never as success:
    // falsy-but-present values (0, "", false) are failures too.
    const isError = err !== undefined && err !== null;
    const errText = errToText(err);

    // Emit tool_result when tool completes or has output/error
    const isDone = state === 'DONE' || output || isError;
    if (isDone && !this.emittedToolResults.has(toolCallId)) {
      this.emittedToolResults.add(toolCallId);

      let summary = '';
      try {
        const cmd = params.CommandLine || params.command || params.path || params.Path || '';
        summary = cmd ? `${name}: ${cmd}` : name;
      } catch {
        summary = name;
      }

      let body;
      if (isError) {
        // Keep the error line inside the cap even when the summary alone
        // would fill it — the error is the diagnostic; slicing the combined
        // string from the front truncates exactly the part that matters.
        const errLine = `\nError: ${errText}`.slice(0, 8000);
        body = summary.slice(0, Math.max(0, 8000 - errLine.length)) + errLine;
      } else {
        body = output ? `${summary}\n${output}`.slice(0, 8000) : summary;
      }

      this._emit(`[TOOL_RESULT] ${JSON.stringify({
        type: 'tool_result',
        tool_use_id: toolCallId,
        content: body,
        is_error: isError,
        _meta: {
          tool_name: name,
          parameters: params,
          step_index: step.step_index,
          state,
        },
      })}`);
    }
  }

  _handleResult(result) {
    if (!result || typeof result !== 'object') return;

    if (result.conversation_id && this.conversationId !== result.conversation_id) {
      this.conversationId = result.conversation_id;
      this._emit(`[SESSION_ID] ${this.conversationId}`);
    }

    const usage = normalizeUsageToSnakeCase(result.usage);
    if (usage) {
      // Final result usage is authoritative for the turn (includes all steps).
      this._maybeEmitUsage(usage, { authoritative: true });
    }

    const responseText = result.response != null ? String(result.response) : '';
    if (responseText && !this.assistantText) {
      this.assistantText = responseText;
      this._emit(`[CONTENT_DELTA] ${JSON.stringify(responseText)}`);
    } else if (responseText && responseText.length > this.assistantText.length) {
      const already = this.assistantText;
      if (!responseText.startsWith(already)) {
        this.assistantText = responseText;
      }
    }

    const status = String(result.status || '').toUpperCase();
    if (status && status !== 'SUCCESS' && status !== 'RUNNING') {
      if (status === 'ERROR' || status === 'INVALID') {
        const errMsg = result.error || `agy run status=${status}`;
        this._terminalError = errMsg;
        this._terminalStatus = status;
      }
    }
  }

  /**
   * Emit [USAGE] for the status bar.
   * Intermediate step usage (esp. tiny checkpoint rows) must not replace a larger
   * peak — agy often ends with checkpoint usage ~100 tokens after a 20k+ response step.
   */
  _maybeEmitUsage(usage, { authoritative = false } = {}) {
    if (!usage) return;
    const ctx = extractAgyContextTokens(usage);
    if (!authoritative && ctx > 0 && ctx < this.peakContextTokens) {
      return;
    }
    if (ctx > this.peakContextTokens) {
      this.peakContextTokens = ctx;
    }
    this.lastUsage = usage;
    this._emit(`[USAGE] ${JSON.stringify(usage)}`);
  }

  finishSuccess(conversationId, resultText) {
    const finalId = conversationId || this.conversationId || `agy-${Date.now()}`;
    if (!this.conversationId) {
      this._emit(`[SESSION_ID] ${finalId}`);
    }

    const text = (resultText != null && String(resultText).length > 0)
      ? String(resultText)
      : this.assistantText;

    if (this.lastUsage) {
      this._emit(`[USAGE] ${JSON.stringify(this.lastUsage)}`);
    }

    const assistantMessage = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: text || '' }],
        ...(this.lastUsage ? { usage: this.lastUsage } : {}),
      },
    };
    this._emit(`[MESSAGE] ${JSON.stringify(assistantMessage)}`);
    this._emitStreamEndOnce();
    this._emitMessageEndOnce();

    this.log(JSON.stringify({
      success: true,
      sessionId: finalId,
      result: text,
    }));
  }

  finishError(error) {
    const message = error?.message || String(error || 'Unknown error');
    this._emit(`[SEND_ERROR] ${JSON.stringify({ error: message })}`);
    this._emitStreamEndOnce();
    this._emitMessageEndOnce();
    this.log(JSON.stringify({
      success: false,
      error: message,
      sessionId: this.conversationId || '',
    }));
  }

  _emitStreamEndOnce() {
    if (!this.streamEnded) {
      this._emit('[STREAM_END]');
      this.streamEnded = true;
    }
  }

  _emitMessageEndOnce() {
    if (!this.messageEnded) {
      this._emit('[MESSAGE_END]');
      this.messageEnded = true;
    }
  }

  _emit(line) {
    this.log(line);
  }
}

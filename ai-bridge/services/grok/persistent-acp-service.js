/**
 * Persistent ACP service for Grok daemon mode.
 *
 * Mirrors the spirit of claude/persistent-query-service but for ACP `grok agent stdio`.
 * Keeps GrokAcpClient (and its authenticated ACP session) warm across turns
 * for the same runtime key (epoch + session + cwd + model + permissionMode).
 *
 * Commands exposed to daemon:
 *   grok.send
 *   grok.preconnect
 *   grok.resetRuntime
 *   (abort handled at daemon level)
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  GrokAcpClient,
  initializeAndAuthenticate,
  ensureSession,
  applyPermissionModeToSession,
  buildPromptBlocks,
  isAutoApproveMode,
  resolveAcpPermissionDecision,
  isPermissionRequestMethod,
  extractPermissionToolInfo,
  TURN_PROMPT_TIMEOUT_MS,
} from './grok-acp-client.js';
import { GrokEventNormalizer } from './grok-event-normalizer.js';
import {
  buildGrokEnv,
  buildGrokContextUsagePayload,
  extractUsedTokens,
  extractUsageFromAcpEnvelope,
  resolveEffectiveGrokAuth,
  normalizeGrokModelId,
} from './grok-utils.js';
import { requestPermissionFromJava } from '../../permission-ipc.js';
import { AcpTerminalHost } from './acp-terminal-host.js';

export { buildGrokContextUsagePayload, extractUsedTokens };

/**
 * Remember last ACP usage total on the runtime for /context synthesis.
 */
function rememberUsageOnRuntime(runtime, usage) {
  if (!runtime || !usage) return;
  const used = extractUsedTokens(usage);
  if (used > 0) {
    runtime.lastUsedTokens = used;
  }
}

/**
 * Pull usage from ACP notifications (session/update usage_update OR
 * _x.ai/session_notification turn_completed — the path real Grok CLI uses).
 */
function usageFromNotification(method, params) {
  return extractUsageFromAcpEnvelope(method, params);
}

// =============================================================================
// Runtime registry (lightweight, Grok-specific)
// =============================================================================

const runtimes = new Map(); // runtimeKey -> runtime
let activeTurnRuntime = null;

function normalizePermissionMode(mode) {
  const m = String(mode || '').trim().toLowerCase();
  // Empty → default so preconnect (permissionMode:"") shares the runtime with UI "default"
  // and does not leave tools un-gated under a silent always-approve session.
  return m || 'default';
}

function makeRuntimeKey(params) {
  const epoch = params.runtimeSessionEpoch || params.epoch || 'default';
  const sid = (params.sessionId || '').trim() || 'new';
  const cwd = (params.cwd || process.cwd()).trim();
  const model = normalizeGrokModelId(params.model);
  const perm = normalizePermissionMode(params.permissionMode);
  // authFingerprint: presence only (never secrets)
  const authMethod = String(params.authMethod || process.env.GROK_AUTH_METHOD || 'oauth').toLowerCase();
  const hasKey = !!(params.apiKey || process.env.XAI_API_KEY || process.env.GROK_API_KEY);
  const authFp = authMethod + ':' + (hasKey ? 'key' : 'nokey');
  const baseFp = String(params.baseUrl || '').trim() || 'direct';
  return [epoch, sid, cwd, model, perm, authFp + '|' + baseFp].join('|');
}

function getRuntime(key) {
  return runtimes.get(key) || null;
}

function rememberRuntime(key, runtime) {
  runtimes.set(key, runtime);
}

function removeRuntime(keyOrRuntime) {
  if (typeof keyOrRuntime === 'string') {
    const rt = runtimes.get(keyOrRuntime);
    if (rt) {
      runtimes.delete(keyOrRuntime);
      if (activeTurnRuntime === rt) activeTurnRuntime = null;
    }
  } else {
    for (const [k, rt] of runtimes.entries()) {
      if (rt === keyOrRuntime) {
        runtimes.delete(k);
      }
    }
    if (activeTurnRuntime === keyOrRuntime) activeTurnRuntime = null;
  }
}

function getAllRuntimes() {
  return Array.from(runtimes.values());
}

function setActive(runtime) {
  activeTurnRuntime = runtime || null;
}

function clearActiveIf(runtime) {
  if (activeTurnRuntime === runtime) activeTurnRuntime = null;
}

// =============================================================================
// Runtime lifecycle
// =============================================================================

async function createRuntime(params, { log } = {}) {
  const key = makeRuntimeKey(params);
  const existing = getRuntime(key);
  if (existing && !existing.closed) {
    // Drop half-dead clients left after ACP timeout so the next turn recovers.
    const client = existing.client;
    if (client && (client.closed || client.unhealthy || client.isUnhealthy?.())) {
      await disposeRuntime(existing);
    } else {
      return existing;
    }
  }

  const workCwd = (params.cwd || '').trim() || process.cwd();
  // Resolve OAuth-empty → config.toml api_key before env/auth so ACP does not
  // open device-code login when CLI-native credentials exist.
  const resolvedAuth = resolveEffectiveGrokAuth({
    preferredAuth: params.authMethod || process.env.GROK_AUTH_METHOD || '',
    apiKey: params.apiKey || '',
    baseUrl: params.baseUrl || '',
  });
  // Mutate params so later turns / logs see the effective method.
  params.authMethod = resolvedAuth.authMethod;
  params.apiKey = resolvedAuth.apiKey;
  params.baseUrl = resolvedAuth.baseUrl;

  const env = buildGrokEnv(
    process.env,
    resolvedAuth.apiKey,
    resolvedAuth.baseUrl,
    resolvedAuth.authMethod,
    false
  );
  if (params.reasoningEffort) {
    env.GROK_REASONING_EFFORT = String(params.reasoningEffort);
    env.REASONING_EFFORT = String(params.reasoningEffort);
  }
  env.GROK_NO_AUTO_UPDATE = '1';
  env.CI = env.CI || '1';

  // Live permission mode holder — onServerRequest / authorizeCreate must re-read
  // this on every decision so setPermissionModePersistent and default mode work.
  // (Previously autoApprove was closed over at create time → default stayed silent
  // if the runtime was ever created under bypass, and live mode changes were ignored.)
  const live = {
    permissionMode: normalizePermissionMode(params.permissionMode),
  };

  const terminalHost = new AcpTerminalHost({
    defaultCwd: workCwd,
    env,
    onEvent: (event, data) => {
      // terminal events can be logged; not emitted as tags for UI in v1
      if (log) log('[GROK-TERM]', event);
    },
    authorizeCreate: async (info) => {
      const mode = live.permissionMode || 'default';
      if (isAutoApproveMode(mode)) return true;
      try {
        // default / plan / acceptEdits+exec: always surface the permission dialog
        return await requestPermissionFromJava('run_terminal_command', {
          command: info.commandLine || info.command,
          cwd: info.cwd,
        });
      } catch {
        return false;
      }
    },
  });

  const client = new GrokAcpClient({
    env,
    cwd: workCwd,
    terminalHost,
    onStderr: (s) => {
      const t = String(s || '').trim();
      if (t) console.error('[GROK-ACP]', t.slice(0, 400));
    },
    onNotification: () => {
      // notifications are handled per-turn via the turn's normalizer
    },
    onServerRequest: async (method, paramsReq, id, acp) => {
      if (isPermissionRequestMethod(method)) {
        const mode = live.permissionMode || 'default';
        const decision = await resolveAcpPermissionDecision(paramsReq, mode, {
          autoApprove: isAutoApproveMode(mode),
        });
        acp.respond(id, decision.response);
        return true;
      }
      return false;
    },
  });

  client.start();

  try {
    const preferredAuth = String(params.authMethod || env.GROK_AUTH_METHOD || 'oauth').toLowerCase();
    const hasApiKeyFromEnv =
      preferredAuth === 'oauth'
        ? false
        : !!(params.apiKey || env.XAI_API_KEY || env.GROK_API_KEY);
    const { init } = await initializeAndAuthenticate(client, {
      apiKey: params.apiKey,
      baseUrl: params.baseUrl,
      hasApiKeyFromEnv,
      authMethod: preferredAuth,
    });

    await ensureSession(client, {
      sessionId: params.sessionId || '',
      cwd: workCwd,
      model: params.model || '',
    });

    // Sync CLI always-approve with mode (default → off so agent keeps requesting).
    if (client.activeSessionId) {
      await applyPermissionModeToSession(client, client.activeSessionId, live.permissionMode);
    }

    const runtime = {
      key,
      client,
      sessionId: client.activeSessionId,
      epoch: params.runtimeSessionEpoch || params.epoch || 'default',
      cwd: workCwd,
      model: params.model || '',
      permissionMode: live.permissionMode,
      /** Shared with authorizeCreate / onServerRequest — mutate for live mode changes. */
      _livePermission: live,
      /** Last ACP [USAGE] total — used by getContextUsage when Java has no snapshot. */
      lastUsedTokens: 0,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      activeTurnCount: 0,
      closed: false,
      initResult: init,
    };

    rememberRuntime(key, runtime);
    console.log('[GROK-DAEMON] runtime created key=' + key.slice(0, 80) + ' sessionId=' + runtime.sessionId
      + ' permissionMode=' + live.permissionMode);
    return runtime;
  } catch (e) {
    await client.close().catch(() => {});
    throw e;
  }
}

async function disposeRuntime(runtime) {
  if (!runtime || runtime.closed) return;
  runtime.closed = true;
  clearActiveIf(runtime);
  try {
    await runtime.client?.close();
  } catch {}
  removeRuntime(runtime);
  console.log('[GROK-DAEMON] runtime disposed');
}

async function resetRuntimesByFilter(filterFn) {
  const toDispose = [];
  for (const [k, rt] of runtimes.entries()) {
    if (filterFn(rt, k)) {
      toDispose.push(rt);
    }
  }
  for (const rt of toDispose) {
    await disposeRuntime(rt);
  }
}

// =============================================================================
// Turn execution (serialized per runtime via simple lock)
// =============================================================================

async function executeTurn(runtime, params, normalizer) {
  if (!runtime || runtime.closed) {
    throw new Error('Grok runtime is closed');
  }

  runtime.activeTurnCount = (runtime.activeTurnCount || 0) + 1;
  setActive(runtime);
  runtime.lastUsedAt = Date.now();

  const emit = (type, payload) => normalizer.handleAcpEvent(type, payload);

  try {
    normalizer.begin();

    // Ensure we have a live session id (in case previous was recreated)
    let sid = runtime.sessionId || params.sessionId || runtime.client?.activeSessionId || '';
    if (!sid || runtime.client.closed) {
      // re-ensure
      const sess = await ensureSession(runtime.client, {
        sessionId: sid,
        cwd: runtime.cwd,
        model: runtime.model,
      });
      sid = sess.sessionId;
      runtime.sessionId = sid;
    }

    emit('session_id', sid);

    const promptBlocks = buildPromptBlocks({
      message: params.message || '',
      agentPrompt: params.agentPrompt || '',
      openedFiles: params.openedFiles || null,
      attachments: params.attachments || [],
    });

    // Wire notifications / permission / fs writes into the turn normalizer.
    // Grok file edits arrive mainly as session/request_permission; createRuntime's
    // onServerRequest must be overridden for the turn so the ledger sees them.
    // finishSuccess flushes the ledger so edit stats are correct at turn end.
    const originalOnNotif = runtime.client.onNotification;
    const originalOnFsWrite = runtime.client.onFsWrite;
    const originalOnServerRequest = runtime.client.onServerRequest;
    runtime.client.onNotification = (method, p) => {
      const usage = usageFromNotification(method, p);
      if (usage) rememberUsageOnRuntime(runtime, usage);
      emit('notification', { method, params: p });
      if (typeof originalOnNotif === 'function') {
        try { originalOnNotif(method, p); } catch {}
      }
    };
    runtime.client.onFsWrite = (payload) => {
      emit('fs_write', payload);
      if (typeof originalOnFsWrite === 'function') {
        try { originalOnFsWrite(payload); } catch {}
      }
    };
    runtime.client.onServerRequest = async (method, paramsReq, id, acp) => {
      emit('server_request', { method, params: paramsReq });
      if (isPermissionRequestMethod(method)) {
        const mode =
          runtime._livePermission?.permissionMode ||
          runtime.permissionMode ||
          'default';
        const decision = await resolveAcpPermissionDecision(paramsReq, mode, {
          autoApprove: isAutoApproveMode(mode),
        });
        const info = extractPermissionToolInfo(paramsReq || {});
        emit('permission_decision', {
          method,
          toolName: decision.toolName,
          allowed: decision.allowed,
          optionId: decision.optionId,
          source: decision.source,
          toolCallId: info.input?._acp?.toolCallId || '',
          input: info.input,
        });
        acp.respond(id, decision.response);
        return true;
      }
      if (typeof originalOnServerRequest === 'function') {
        return originalOnServerRequest(method, paramsReq, id, acp);
      }
      return false;
    };

    try {
      const result = await runtime.client.prompt(sid, promptBlocks, TURN_PROMPT_TIMEOUT_MS);

      // Keep turn notification handler until after prompt_result is normalized —
      // late turn_completed must not be dropped by restoring the previous handler early.
      const resultUsage = extractUsageFromAcpEnvelope(result) || result?.usage;
      if (resultUsage) {
        rememberUsageOnRuntime(runtime, resultUsage);
      }

      emit('prompt_result', result);
      // finishSuccess flushes the file-edit ledger before STREAM_END
      normalizer.finishSuccess(sid || runtime.sessionId, normalizer.assistantText);

      runtime.sessionId = sid || runtime.client.activeSessionId;
      return { sessionId: runtime.sessionId, success: true };
    } finally {
      runtime.client.onNotification = originalOnNotif;
      runtime.client.onFsWrite = originalOnFsWrite;
      runtime.client.onServerRequest = originalOnServerRequest;
    }
  } catch (err) {
    normalizer.finishError(err);
    // Ensure timeout / stream corruption always recycles (even if markUnhealthy raced).
    if (err?.code === 'ACP_TIMEOUT' || /ACP timeout waiting for/i.test(String(err?.message || ''))) {
      try {
        runtime.client?.markUnhealthy?.(err.message || 'ACP timeout', { killProcess: true });
      } catch {
        // ignore
      }
    }
    throw err;
  } finally {
    runtime.activeTurnCount = Math.max((runtime.activeTurnCount || 1) - 1, 0);
    clearActiveIf(runtime);
    // If client died or became unhealthy (timeout), drop runtime so the next send
    // creates a fresh ACP session instead of hanging on a stuck agent.
    const client = runtime.client;
    if (client && (client.closed || client.unhealthy || client.isUnhealthy?.())) {
      await disposeRuntime(runtime);
    }
  }
}

// =============================================================================
// Public API (called by daemon and fallback paths)
// =============================================================================

export async function sendMessagePersistent(params = {}) {
  const key = makeRuntimeKey(params);
  let runtime;
  try {
    runtime = await createRuntime(params);
  } catch (e) {
    console.error('[GROK-DAEMON] failed to create runtime, will rely on fallback:', e.message);
    throw e; // caller (daemon) will let Java fallback
  }

  // Simple per-runtime serialization: attach to runtime
  if (!runtime._turnQueue) runtime._turnQueue = Promise.resolve();

  const normalizer = new GrokEventNormalizer({
    log: (...a) => console.log(...a),
    error: (...a) => console.error(...a),
  });

  runtime._turnQueue = runtime._turnQueue.then(async () => {
    return executeTurn(runtime, params, normalizer);
  });

  try {
    const r = await runtime._turnQueue;
    // Note: the success JSON is already emitted by normalizer.finishSuccess()
    // Do not emit again to avoid duplicate processing on Java side.
    return r;
  } catch (e) {
    // error already emitted via [SEND_ERROR] + json by normalizer.finishError()
    throw e;
  }
}

export async function preconnectPersistent(params = {}) {
  try {
    const runtime = await createRuntime(params);
    console.log('[GROK-DAEMON] preconnect ok for key=' + runtime.key?.slice(0, 60));
    console.log(JSON.stringify({ success: true, sessionId: runtime.sessionId }));
    return { success: true, sessionId: runtime.sessionId };
  } catch (e) {
    console.warn('[GROK-DAEMON] preconnect failed (non-fatal):', e.message);
    // Do not throw — preconnect is best-effort
    return { success: false, error: e.message };
  }
}

export async function resetRuntimePersistent(params = {}) {
  const epoch = params.runtimeSessionEpoch || params.epoch;
  const key = params.runtimeKey || null;

  if (key) {
    const rt = getRuntime(key);
    if (rt) await disposeRuntime(rt);
    console.log('[GROK-DAEMON] reset by key');
  } else if (epoch) {
    await resetRuntimesByFilter((rt) => rt.epoch === epoch);
    console.log('[GROK-DAEMON] reset by epoch=' + epoch);
  } else {
    // reset all Grok
    const all = getAllRuntimes();
    for (const rt of all) await disposeRuntime(rt);
    console.log('[GROK-DAEMON] reset all');
  }

  console.log(JSON.stringify({ success: true }));
  return { success: true };
}

export async function abortCurrentTurn() {
  const runtime = activeTurnRuntime;
  if (!runtime) return;

  console.log('[GROK-DAEMON] abortCurrentTurn epoch=' + (runtime.epoch || '(none)'));

  clearActiveIf(runtime);

  try {
    runtime.client?.abortActiveRequests('user aborted');
  } catch {}

  // For safety and to match Claude behavior for abort, dispose the runtime.
  // Next send will recreate (cold start once).
  await disposeRuntime(runtime).catch(() => {});
}

export async function shutdownPersistentRuntimes() {
  const all = getAllRuntimes();
  for (const rt of all) {
    await disposeRuntime(rt).catch(() => {});
  }
  runtimes.clear();
  activeTurnRuntime = null;
  console.log('[GROK-DAEMON] shutdown all Grok runtimes');
}

/**
 * Live permission-mode switch for an existing Grok runtime (daemon grok.setPermissionMode).
 * Updates the live holder used by authorizeCreate / session/request_permission so default
 * mode immediately starts showing the permission dialog again.
 */
export async function setPermissionModePersistent(params = {}) {
  const targetMode = normalizePermissionMode(params.permissionMode);
  const sessionId = (params.sessionId || '').trim() || null;
  const epoch = params.runtimeSessionEpoch || params.epoch || null;

  // Collect every runtime that should flip mode now. Mid-turn Auto switches must
  // hit the active turn even when Java's sessionId does not match the ACP id
  // (permission-service key vs Grok thread id) — that mismatch was a residual
  // path where dialogs kept appearing after the user selected Auto.
  const targets = [];
  const seen = new Set();
  const addTarget = (rt) => {
    if (!rt || rt.closed || seen.has(rt)) return;
    seen.add(rt);
    targets.push(rt);
  };

  // 1) Always prefer the in-flight turn (sessionId mismatch safe).
  if (activeTurnRuntime && !activeTurnRuntime.closed) {
    addTarget(activeTurnRuntime);
  }

  // 2) Exact ACP / host session match.
  if (sessionId) {
    for (const rt of getAllRuntimes()) {
      if (!rt.closed && rt.sessionId === sessionId) {
        addTarget(rt);
      }
    }
  }

  // 3) Same epoch (preconnect + send share epoch; covers id-less runtimes).
  if (epoch) {
    for (const rt of getAllRuntimes()) {
      if (!rt.closed && rt.epoch === epoch) {
        addTarget(rt);
      }
    }
  }

  // 4) Last resort: single open runtime in the process.
  if (targets.length === 0) {
    const open = getAllRuntimes().filter((rt) => !rt.closed);
    if (open.length === 1) {
      addTarget(open[0]);
    }
  }

  if (targets.length === 0) {
    console.log(
      '[GROK-DAEMON] setPermissionModePersistent skipped: no live runtime'
      + ` sessionId=${sessionId || '(none)'} epoch=${epoch || '(none)'} mode=${targetMode}`
    );
    return { success: true, applied: false, permissionMode: targetMode };
  }

  for (const runtime of targets) {
    runtime.permissionMode = targetMode;
    if (runtime._livePermission) {
      runtime._livePermission.permissionMode = targetMode;
    }

    const sid =
      runtime.sessionId
      || runtime.client?.activeSessionId
      || null;
    if (runtime.client && sid) {
      await applyPermissionModeToSession(runtime.client, sid, targetMode);
    }

    console.log(
      '[GROK-DAEMON] setPermissionModePersistent applied mode=' + targetMode
      + ' sessionId=' + (runtime.sessionId || '(none)')
      + ' epoch=' + (runtime.epoch || '(none)')
    );
  }

  return {
    success: true,
    applied: true,
    permissionMode: targetMode,
    runtimeCount: targets.length,
  };
}

/**
 * Context usage for /context dialog. Prefer Java-supplied used/max when present;
 * otherwise use lastUsage stored on the active runtime.
 */
export async function getContextUsagePersistent(params = {}) {
  const active = activeTurnRuntime && !activeTurnRuntime.closed ? activeTurnRuntime : null;
  let used = Number(params.usedTokens);
  if (!Number.isFinite(used) || used < 0) {
    used = Number(active?.lastUsedTokens) || 0;
  }
  let max = Number(params.maxTokens);
  if (!Number.isFinite(max) || max <= 0) {
    max = 200_000;
  }
  const model = params.model || active?.model || '';
  const payload = buildGrokContextUsagePayload({ usedTokens: used, maxTokens: max, model });
  console.log(JSON.stringify(payload));
  return payload;
}

/**
 * Live Grok billing/credits. Best-effort headless `grok -p "/usage"`; otherwise a
 * structured unavailable payload so the Settings panel stops spinning (never hangs).
 */
export async function getUsagePersistent(params = {}) {
  const cwd = (params.cwd || process.cwd()).trim() || process.cwd();
  try {
    const { spawnGrok, buildGrokEnv } = await import('./grok-utils.js');
    const env = buildGrokEnv(
      process.env,
      params.apiKey || '',
      params.baseUrl || '',
      params.authMethod || process.env.GROK_AUTH_METHOD || '',
    );

    const result = await Promise.race([
      spawnGrok(
        ['-p', '/usage', '--output-format', 'json', '--always-approve'],
        env,
        cwd,
      ),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('grok /usage timed out')), 20_000);
      }),
    ]);

    const trimmed = String(result?.stdout || '').trim();
    if (trimmed) {
      try {
        const parsed = JSON.parse(trimmed);
        const payload = parsed.data || parsed.config
          ? { success: true, data: parsed.data || parsed }
          : { success: true, data: { raw: parsed }, output: trimmed };
        console.log(JSON.stringify(payload));
        return payload;
      } catch {
        const payload = { success: true, data: { raw: trimmed }, output: trimmed };
        console.log(JSON.stringify(payload));
        return payload;
      }
    }
  } catch (e) {
    console.error('[GROK-DAEMON] getUsagePersistent failed:', e?.message || e);
  }

  const payload = {
    success: true,
    data: {
      unavailable: true,
      message:
        'Grok billing snapshot is not available here. Use the /usage slash command in chat, or check account limits on grok.com / console.x.ai.',
      source: 'plugin-fallback',
    },
  };
  console.log(JSON.stringify(payload));
  return payload;
}

// For daemon introspection / tests
export const __testing = {
  getRuntimes: () => getAllRuntimes(),
  getActiveTurnRuntime: () => activeTurnRuntime,
  getActiveTurnRuntimeInternal: () => activeTurnRuntime,
  makeRuntimeKey,
  normalizePermissionMode,
  resetRegistry: () => {
    runtimes.clear();
    activeTurnRuntime = null;
  },
  /**
   * Lightweight fake runtime for unit tests (no real Grok CLI).
   * Mirrors fields used by setPermissionModePersistent / permission handlers.
   */
  createTestRuntime: (key, opts = {}) => {
    const mode = normalizePermissionMode(opts.permissionMode);
    const live = { permissionMode: mode };
    const rt = {
      key,
      client: opts.client || {
        activeSessionId: opts.sessionId || null,
        request: opts.clientRequest || (async () => ({})),
      },
      sessionId: opts.sessionId ?? null,
      epoch: opts.epoch || opts.runtimeSessionEpoch || 'default',
      cwd: opts.cwd || '/tmp',
      model: opts.model || '',
      permissionMode: mode,
      _livePermission: live,
      createdAt: opts.createdAt || Date.now(),
      lastUsedAt: opts.lastUsedAt || Date.now(),
      activeTurnCount: opts.activeTurnCount || 0,
      closed: false,
    };
    rememberRuntime(key, rt);
    return rt;
  },
  forceSetActiveTurn: (runtime) => {
    activeTurnRuntime = runtime || null;
  },
  /** No-op placeholder for older tests that expected idle cleanup timers. */
  triggerCleanup: () => {},
};

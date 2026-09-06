const runtimesBySessionId = new Map();
const anonymousRuntimes = new Set();
const anonymousRuntimesBySignature = new Map();

let activeTurnRuntime = null;

const RUNTIME_MAX_ABSOLUTE_LIFETIME_MS = 6 * 60 * 60 * 1000;
const ANONYMOUS_RUNTIME_MAX_IDLE_MS = 10 * 60 * 1000;
const SESSION_RUNTIME_MAX_IDLE_MS = 30 * 60 * 1000;
const SESSION_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

export {
  RUNTIME_MAX_ABSOLUTE_LIFETIME_MS,
  ANONYMOUS_RUNTIME_MAX_IDLE_MS,
  SESSION_RUNTIME_MAX_IDLE_MS,
  SESSION_CLEANUP_INTERVAL_MS
};

export function rememberRuntime(runtime, requestContext, registerActiveQueryResult) {
  if (requestContext.requestedSessionId) {
    runtimesBySessionId.set(requestContext.requestedSessionId, runtime);
    registerActiveQueryResult?.(requestContext.requestedSessionId, runtime.query);
    return;
  }

  anonymousRuntimes.add(runtime);
  anonymousRuntimesBySignature.set(requestContext.runtimeSignature, runtime);
}

export function promoteRuntimeToSession(runtime, sessionId, { removeSession, registerActiveQueryResult }) {
  if (!sessionId) return;

  console.log('[LIFECYCLE] registerRuntimeSession sessionId=' + sessionId
    + ' epoch=' + (runtime?.runtimeSessionEpoch || '(none)'));

  for (const [signature, item] of anonymousRuntimesBySignature.entries()) {
    if (item === runtime) {
      anonymousRuntimesBySignature.delete(signature);
    }
  }

  for (const [existingSessionId, existingRuntime] of runtimesBySessionId.entries()) {
    if (existingRuntime === runtime && existingSessionId !== sessionId) {
      runtimesBySessionId.delete(existingSessionId);
      removeSession?.(existingSessionId);
    }
  }

  runtime.sessionId = sessionId;
  runtime.runtimeSessionEpoch = runtime.runtimeSessionEpoch || null;
  runtimesBySessionId.set(sessionId, runtime);
  anonymousRuntimes.delete(runtime);
  registerActiveQueryResult?.(sessionId, runtime.query);
}

export function removeRuntime(runtime, removeSession) {
  anonymousRuntimes.delete(runtime);

  for (const [signature, item] of anonymousRuntimesBySignature.entries()) {
    if (item === runtime) {
      anonymousRuntimesBySignature.delete(signature);
    }
  }

  for (const [sessionId, item] of runtimesBySessionId.entries()) {
    if (item === runtime) {
      runtimesBySessionId.delete(sessionId);
      removeSession?.(sessionId);
    }
  }
}

export function findRuntimeForRequest(requestContext) {
  if (requestContext.requestedSessionId) {
    return runtimesBySessionId.get(requestContext.requestedSessionId) || null;
  }
  const exact = anonymousRuntimesBySignature.get(requestContext.runtimeSignature);
  if (exact) return exact;
  // A bypass transition changes the spawn-time signature before the next
  // request arrives. Only consider a pending runtime from the same anonymous
  // session epoch; otherwise a request could dispose another session's runtime.
  if (!requestContext.runtimeSessionEpoch) return null;
  for (const runtime of anonymousRuntimes) {
    if (runtime.runtimeSignature === '__rebuild-pending-bypass-change__'
        && runtime.runtimeSessionEpoch === requestContext.runtimeSessionEpoch) {
      return runtime;
    }
  }
  return null;
}

export function beginRuntimeTurn(runtime) {
  if (!runtime) return;
  runtime.activeTurnCount = (runtime.activeTurnCount || 0) + 1;
}

export function endRuntimeTurn(runtime) {
  if (!runtime) return;
  runtime.activeTurnCount = Math.max((runtime.activeTurnCount || 0) - 1, 0);
}

export function touchRuntime(runtime) {
  if (!runtime || runtime.closed) return;
  runtime.lastUsedAt = Date.now();
}

export function canDisposeIdleRuntime(runtime, now, maxIdleMs) {
  if (!runtime || runtime.closed) return false;
  if (now - runtime.createdAt > RUNTIME_MAX_ABSOLUTE_LIFETIME_MS) return true;
  if ((runtime.activeTurnCount || 0) > 0) return false;
  return now - runtime.lastUsedAt > maxIdleMs;
}

export async function cleanupStaleAnonymousRuntimes(disposeFn) {
  const now = Date.now();
  const snapshot = [...anonymousRuntimes];
  for (const runtime of snapshot) {
    if (runtime.closed) {
      anonymousRuntimes.delete(runtime);
      continue;
    }
    if (canDisposeIdleRuntime(runtime, now, ANONYMOUS_RUNTIME_MAX_IDLE_MS)) {
      console.log(`[DAEMON] Disposing stale anonymous runtime (idle ${Math.round((now - runtime.lastUsedAt) / 1000)}s)`);
      await disposeFn(runtime);
    }
  }
}

export async function cleanupStaleSessionRuntimes(disposeFn) {
  const now = Date.now();
  for (const [sessionId, runtime] of runtimesBySessionId.entries()) {
    if (runtime.closed) {
      runtimesBySessionId.delete(sessionId);
      continue;
    }
    if (canDisposeIdleRuntime(runtime, now, SESSION_RUNTIME_MAX_IDLE_MS)) {
      console.log(`[DAEMON] Disposing stale session runtime ${sessionId} (idle ${Math.round((now - runtime.lastUsedAt) / 1000)}s)`);
      await disposeFn(runtime);
    }
  }
}

export function setActiveTurnRuntime(runtime) {
  activeTurnRuntime = runtime || null;
}

export function getActiveTurnRuntime() {
  return activeTurnRuntime;
}

export function clearActiveTurnRuntime() {
  activeTurnRuntime = null;
}

export function clearActiveTurnRuntimeIf(runtime) {
  if (activeTurnRuntime === runtime) {
    activeTurnRuntime = null;
  }
}

export function getAllRuntimes() {
  return new Set([
    ...anonymousRuntimes,
    ...anonymousRuntimesBySignature.values(),
    ...runtimesBySessionId.values(),
    activeTurnRuntime
  ].filter(Boolean));
}

export function getRuntimeForSession(sessionId) {
  return runtimesBySessionId.get(sessionId) || null;
}

export function getSnapshot() {
  return {
    anonymousRuntimeCount: anonymousRuntimes.size,
    sessionRuntimeCount: runtimesBySessionId.size,
    activeTurnEpoch: activeTurnRuntime?.runtimeSessionEpoch || null
  };
}

export function resetRegistryState() {
  anonymousRuntimes.clear();
  anonymousRuntimesBySignature.clear();
  runtimesBySessionId.clear();
  activeTurnRuntime = null;
}

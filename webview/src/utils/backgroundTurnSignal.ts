/**
 * Live signal that the CLI is generating a background (inter-turn) response.
 *
 * The ai-bridge perpetual reader emits `background_turn` daemon events:
 * 'active' when a CLI-owned turn starts producing messages (re-emitted as a
 * heartbeat with each throttled session_updated nudge, ~5s) and 'idle' on the
 * turn's result. Java forwards them to `window.updateBackgroundTurnState`.
 *
 * The transcript-tail heuristic in turnScope.ts cannot cover live turns: by
 * the time a reload runs, the first response chunk already follows the
 * task-notification, so the "trailing notification" condition never holds.
 * This store is the live source of truth; the heuristic remains as a
 * reload-time fallback.
 *
 * The active state expires TTL ms after the last heartbeat so a daemon that
 * dies mid-turn (never sending 'idle') cannot leave a forever-spinner.
 */
import { useSyncExternalStore } from 'react';

/** 4x the bridge heartbeat cadence (5s) — tolerates a few lost events. */
export const BACKGROUND_TURN_SIGNAL_TTL_MS = 20_000;

export interface BackgroundTurnSignal {
  sessionId: string;
  /** When the current active burst was first signalled (ms epoch). */
  startedAtMs: number;
}

let signal: BackgroundTurnSignal | null = null;
let expiryTimer: number | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((listener) => listener());
}

function clearExpiryTimer(): void {
  if (expiryTimer !== null) {
    window.clearTimeout(expiryTimer);
    expiryTimer = null;
  }
}

export function updateBackgroundTurnSignal(sessionId: string, active: boolean, nowMs: number = Date.now()): void {
  clearExpiryTimer();
  if (!active) {
    if (signal !== null) {
      signal = null;
      notify();
    }
    return;
  }
  const startedAtMs = signal && signal.sessionId === sessionId ? signal.startedAtMs : nowMs;
  const changed = !signal || signal.sessionId !== sessionId;
  signal = { sessionId, startedAtMs };
  expiryTimer = window.setTimeout(() => {
    expiryTimer = null;
    signal = null;
    notify();
  }, BACKGROUND_TURN_SIGNAL_TTL_MS);
  // Heartbeats refresh the TTL without re-rendering subscribers.
  if (changed) notify();
}

export function getBackgroundTurnSignal(): BackgroundTurnSignal | null {
  return signal;
}

export function useBackgroundTurnSignal(): BackgroundTurnSignal | null {
  return useSyncExternalStore(
    (callback) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    getBackgroundTurnSignal,
  );
}

/** Test helper. */
export function resetBackgroundTurnSignal(): void {
  clearExpiryTimer();
  signal = null;
}

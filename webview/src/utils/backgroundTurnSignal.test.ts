import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BACKGROUND_TURN_SIGNAL_TTL_MS,
  getBackgroundTurnSignal,
  resetBackgroundTurnSignal,
  updateBackgroundTurnSignal,
} from './backgroundTurnSignal';

describe('backgroundTurnSignal', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetBackgroundTurnSignal();
  });

  afterEach(() => {
    resetBackgroundTurnSignal();
    vi.useRealTimers();
  });

  it('activates with the session id and start time', () => {
    updateBackgroundTurnSignal('sess-1', true, 1000);
    expect(getBackgroundTurnSignal()).toEqual({ sessionId: 'sess-1', startedAtMs: 1000 });
  });

  it('keeps the original start time across heartbeats', () => {
    updateBackgroundTurnSignal('sess-1', true, 1000);
    updateBackgroundTurnSignal('sess-1', true, 6000);
    expect(getBackgroundTurnSignal()).toEqual({ sessionId: 'sess-1', startedAtMs: 1000 });
  });

  it('resets the start time when a different session activates', () => {
    updateBackgroundTurnSignal('sess-1', true, 1000);
    updateBackgroundTurnSignal('sess-2', true, 5000);
    expect(getBackgroundTurnSignal()).toEqual({ sessionId: 'sess-2', startedAtMs: 5000 });
  });

  it('clears on idle', () => {
    updateBackgroundTurnSignal('sess-1', true, 1000);
    updateBackgroundTurnSignal('sess-1', false);
    expect(getBackgroundTurnSignal()).toBeNull();
  });

  it('expires after the TTL without a heartbeat', () => {
    updateBackgroundTurnSignal('sess-1', true, 1000);
    vi.advanceTimersByTime(BACKGROUND_TURN_SIGNAL_TTL_MS - 1);
    expect(getBackgroundTurnSignal()).not.toBeNull();
    vi.advanceTimersByTime(2);
    expect(getBackgroundTurnSignal()).toBeNull();
  });

  it('a heartbeat refreshes the TTL', () => {
    updateBackgroundTurnSignal('sess-1', true, 1000);
    vi.advanceTimersByTime(BACKGROUND_TURN_SIGNAL_TTL_MS - 1000);
    updateBackgroundTurnSignal('sess-1', true, 20_000);
    vi.advanceTimersByTime(BACKGROUND_TURN_SIGNAL_TTL_MS - 1000);
    expect(getBackgroundTurnSignal()).toEqual({ sessionId: 'sess-1', startedAtMs: 1000 });
    vi.advanceTimersByTime(1001);
    expect(getBackgroundTurnSignal()).toBeNull();
  });

  it('idle is a no-op when already inactive', () => {
    expect(() => updateBackgroundTurnSignal('sess-1', false)).not.toThrow();
    expect(getBackgroundTurnSignal()).toBeNull();
  });
});

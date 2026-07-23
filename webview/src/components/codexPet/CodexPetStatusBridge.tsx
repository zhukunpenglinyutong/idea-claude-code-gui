import { useEffect, useMemo, useRef } from 'react';
import { petBridge } from './petBridge';
import { resolveCodexPetState } from './petState';

const STATE_HEARTBEAT_MS = 1_000;
const ERROR_RESET_MS = 140 * 8 * 5;

interface CodexPetStatusBridgeProps {
  active: boolean;
  loading: boolean;
  streamingActive: boolean;
  isThinking: boolean;
  status: string;
  errorCount?: number;
  provider?: string;
  model?: string;
  tabTitle?: string;
}

function createSourceId(): string {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `pet-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function CodexPetStatusBridge({
  active,
  loading,
  streamingActive,
  isThinking,
  status,
  errorCount = 0,
  provider,
  model,
  tabTitle,
}: CodexPetStatusBridgeProps) {
  const sourceId = useRef(createSourceId());
  const wasBusy = useRef(false);
  const liveTurnActive = useRef(false);
  const lastBubbleEvent = useRef<string | null>(null);
  const lastReportedState = useRef('idle');
  const terminalState = useRef<'success' | 'error' | null>(null);
  const stateResetTimer = useRef<number | undefined>(undefined);
  const turnStartedAt = useRef<number | null>(null);
  const turnStartErrorCount = useRef(errorCount);
  const turnStartStatus = useRef(status.trim());
  const resolvedState = useMemo(
    () => resolveCodexPetState(loading, streamingActive, isThinking, status),
    [isThinking, loading, status, streamingActive],
  );

  useEffect(() => {
    const busy = loading || streamingActive || isThinking;
    const statusChangedToError = resolvedState === 'error' && status.trim() !== turnStartStatus.current;
    const turnHasError = errorCount > turnStartErrorCount.current || statusChangedToError;
    const state = resolvedState === 'error' && !turnHasError ? 'idle' : resolvedState;
    const reportState = (nextState: string) => {
      lastReportedState.current = nextState;
      petBridge.updateState(sourceId.current, nextState);
    };
    const clearTerminalState = () => {
      if (stateResetTimer.current !== undefined) {
        window.clearTimeout(stateResetTimer.current);
        stateResetTimer.current = undefined;
      }
      terminalState.current = null;
      turnStartedAt.current = null;
      turnStartErrorCount.current = errorCount;
      turnStartStatus.current = status.trim();
    };
    const scheduleIdle = (delayMs: number) => {
      if (stateResetTimer.current !== undefined) {
        window.clearTimeout(stateResetTimer.current);
      }
      stateResetTimer.current = window.setTimeout(() => {
        stateResetTimer.current = undefined;
        terminalState.current = null;
        turnStartedAt.current = null;
        reportState('idle');
      }, delayMs);
    };
    const showBubble = (event: 'task_started' | 'thinking' | 'running' | 'task_success' | 'task_error') => {
      if (lastBubbleEvent.current === event) return;
      lastBubbleEvent.current = event;
      petBridge.showBubble({
        event,
        sourceId: sourceId.current,
        tabTitle,
        provider,
        model,
        durationMs: turnStartedAt.current === null
          ? undefined
          : Math.max(0, Date.now() - turnStartedAt.current),
        background: typeof document !== 'undefined' && document.visibilityState === 'hidden',
      });
    };
    if (!active) {
      clearTerminalState();
      reportState('disposed');
      wasBusy.current = false;
      liveTurnActive.current = false;
      lastBubbleEvent.current = null;
    } else if (!wasBusy.current && busy) {
      clearTerminalState();
      liveTurnActive.current = true;
      turnStartErrorCount.current = errorCount;
      turnStartStatus.current = status.trim();
      turnStartedAt.current = Date.now();
      reportState(state);
      showBubble('task_started');
      wasBusy.current = true;
    } else if ((liveTurnActive.current || terminalState.current === 'success') && turnHasError) {
      showBubble('task_error');
      reportState('error');
      terminalState.current = 'error';
      scheduleIdle(ERROR_RESET_MS);
      wasBusy.current = false;
      liveTurnActive.current = false;
    } else if (wasBusy.current && !busy) {
      showBubble('task_success');
      reportState('success');
      terminalState.current = 'success';
      scheduleIdle(2400);
      wasBusy.current = false;
      liveTurnActive.current = false;
    } else if (terminalState.current && !busy) {
      return undefined;
    } else {
      if (liveTurnActive.current && (state === 'thinking' || state === 'running')) {
        showBubble(state);
      }
      reportState(state);
      wasBusy.current = busy;
    }
    return undefined;
  }, [active, errorCount, isThinking, loading, model, provider, resolvedState, status, streamingActive, tabTitle]);

  useEffect(() => {
    if (!active) return undefined;
    const heartbeat = window.setInterval(
      () => petBridge.updateState(sourceId.current, lastReportedState.current),
      STATE_HEARTBEAT_MS,
    );
    return () => window.clearInterval(heartbeat);
  }, [active]);

  useEffect(() => () => {
    if (stateResetTimer.current !== undefined) {
      window.clearTimeout(stateResetTimer.current);
    }
    petBridge.updateState(sourceId.current, 'disposed');
  }, []);

  return null;
}

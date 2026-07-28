import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import type { ClaudeRawMessage, SubagentHistoryResponse, TaskEvent, TaskEventMap } from '../types';

// SubagentHistoryContext holds the full history map so consumers
// (AgentGroupBlock / TaskExecutionBlock) re-render when an entry arrives.
// Reactivity is required: an inline Agent card expands, polls the sidechain
// transcript, and must flip from "pending" to "completed" once the response
// lands - a stable getter would never trigger that re-render. The map is small
// (one entry per polled subagent) and updates are low-frequency (2 s polling,
// only for expanded cards), so re-rendering all inline cards on a change is
// bounded and matches the TaskEventContext pattern below.
const SubagentHistoryContext = createContext<Record<string, SubagentHistoryResponse>>({});

interface SessionIdContextValue {
  currentSessionId: string | null;
}

const SessionIdContext = createContext<SessionIdContextValue>({
  currentSessionId: null,
});

export type GetToolResultRawFn = (toolUseId: string) => ClaudeRawMessage | null;

const ToolResultRawContext = createContext<GetToolResultRawFn>(() => null);

// TaskEventContext holds the full task-events map (keyed by tool_use_id) so that
// inline Agent tool cards (TaskExecutionBlock / AgentGroupBlock) can subscribe to
// a background agent's terminal status. Unlike SubagentHistoryContext, this
// deliberately re-renders consumers on change: a background agent's
// task_notification arrives after the launch tool_result, and the card must flip
// from "running" to "completed" without a manual reload. The map is small (one
// entry per background agent) and updates are low-frequency, so the re-render
// cost is bounded.
//
// Split into its own provider (TaskEventProvider) rather than living in
// MessagesContext so that task_event updates do not invalidate the
// MessagesContext value and re-render every consumer of it.
const TaskEventContext = createContext<TaskEventMap>({});

// SetTaskEventContext is separated from TaskEventContext so that components
// which only need the setter (App.tsx, useSessionManagement, useWindowCallbacks)
// do not re-render when the map changes.
const SetTaskEventContext = createContext<React.Dispatch<React.SetStateAction<TaskEventMap>> | null>(null);

/**
 * Provider that owns the task-events map state. Mount once above the App so
 * both the setter (consumed by App/session-management/window-callbacks) and the
 * map (consumed by inline Agent cards and useSubagents) share a single source.
 */
export function TaskEventProvider({ children }: { children: ReactNode }) {
  const [taskEvents, setTaskEvents] = useState<TaskEventMap>({});
  return (
    <SetTaskEventContext.Provider value={setTaskEvents}>
      <TaskEventContext.Provider value={taskEvents}>
        {children}
      </TaskEventContext.Provider>
    </SetTaskEventContext.Provider>
  );
}

/**
 * Read the task-events map. Re-renders the caller when any entry changes.
 */
export function useTaskEvents(): TaskEventMap {
  return useContext(TaskEventContext);
}

/**
 * Read the setter for the task-events map. Stable identity; does NOT re-render
 * the caller when the map changes. Throws if used outside TaskEventProvider.
 */
export function useSetTaskEvents(): React.Dispatch<React.SetStateAction<TaskEventMap>> {
  const setTaskEvents = useContext(SetTaskEventContext);
  if (!setTaskEvents) {
    throw new Error('useSetTaskEvents must be used within a TaskEventProvider');
  }
  return setTaskEvents;
}

/**
 * Read the full subagent-history map. Re-renders the caller whenever any entry
 * changes, so an expanded inline Agent card reflects a freshly loaded sidechain
 * transcript without a manual reload. Callers narrow to the key they care about
 * (toolUseId, falling back to agentId).
 */
export function useSubagentHistories(): Record<string, SubagentHistoryResponse> {
  return useContext(SubagentHistoryContext);
}

/**
 * Hook for reading the current session ID provided via SessionIdContext.
 */
export function useSessionId(): string | null {
  return useContext(SessionIdContext).currentSessionId;
}

/**
 * Hook for looking up the raw message that contains a given tool result.
 */
export function useGetToolResultRaw(): GetToolResultRawFn {
  return useContext(ToolResultRawContext);
}

/**
 * Hook returning the latest task_* event for a background (run_in_background)
 * Agent tool call, keyed by its tool_use_id. Re-renders the caller when the
 * event map changes so inline Agent cards reflect completion in real time.
 */
export function useTaskEvent(toolUseId: string | undefined): TaskEvent | undefined {
  const taskEvents = useContext(TaskEventContext);
  if (!toolUseId) return undefined;
  return taskEvents[toolUseId];
}

/**
 * Creates the context value objects used by App.tsx's Providers.
 * `subagentHistoryCtxValue` is the raw map so Provider consumers re-render when
 * an entry arrives (see useSubagentHistories); its identity changes only when
 * `subagentHistories` changes. `sessionIdCtxValue` is memoized on
 * `currentSessionId` so SessionIdContext consumers don't re-render on every
 * history update.
 */
export function useSubagentContextValues(subagentHistories: Record<string, SubagentHistoryResponse>, currentSessionId: string | null) {
  const sessionIdCtxValue = useMemo(() => ({ currentSessionId }), [currentSessionId]);
  return { subagentHistoryCtxValue: subagentHistories, sessionIdCtxValue };
}

export { SubagentHistoryContext, SessionIdContext, ToolResultRawContext };

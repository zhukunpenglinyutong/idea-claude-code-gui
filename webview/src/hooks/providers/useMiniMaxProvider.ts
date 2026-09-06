import { MINIMAX_DEFAULT_MODEL_ID } from '../../components/ChatInputBox/types';
import { useCliProviderState } from './useCliProviderState';

/**
 * MiniMax Code CLI provider state.
 * Auth/config comes from MiniMax CLI native home (~/.minimax).
 */
export function useMiniMaxProvider() {
  const state = useCliProviderState(MINIMAX_DEFAULT_MODEL_ID);
  return {
    selectedMiniMaxModel: state.selectedModel,
    setSelectedMiniMaxModel: state.setSelectedModel,
    miniMaxPermissionMode: state.permissionMode,
    setMiniMaxPermissionMode: state.setPermissionMode,
  };
}

export type UseMiniMaxProviderReturn = ReturnType<typeof useMiniMaxProvider>;

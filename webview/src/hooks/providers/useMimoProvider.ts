import { MIMO_DEFAULT_MODEL_ID } from '../../components/ChatInputBox/types';
import { useCliProviderState } from './useCliProviderState';

/**
 * MiMo Code CLI provider state (OpenCode fork).
 * Auth/config comes from MiMo Code native config (~/.config/mimocode).
 */
export function useMimoProvider() {
  const state = useCliProviderState(MIMO_DEFAULT_MODEL_ID);
  return {
    selectedMimoModel: state.selectedModel,
    setSelectedMimoModel: state.setSelectedModel,
    mimoPermissionMode: state.permissionMode,
    setMimoPermissionMode: state.setPermissionMode,
  };
}

export type UseMimoProviderReturn = ReturnType<typeof useMimoProvider>;

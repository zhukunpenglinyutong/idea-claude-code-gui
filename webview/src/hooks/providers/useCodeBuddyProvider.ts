import { CODEBUDDY_DEFAULT_MODEL_ID, type PermissionMode } from '../../components/ChatInputBox/types';
import { useState } from 'react';

/** CodeBuddy SDK provider state (model and permission mode are tab-local). */
export function useCodeBuddyProvider() {
  const [selectedModel, setSelectedModel] = useState(CODEBUDDY_DEFAULT_MODEL_ID);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('default');
  return {
    selectedCodeBuddyModel: selectedModel,
    setSelectedCodeBuddyModel: setSelectedModel,
    codeBuddyPermissionMode: permissionMode,
    setCodeBuddyPermissionMode: setPermissionMode,
  };
}

export type UseCodeBuddyProviderReturn = ReturnType<typeof useCodeBuddyProvider>;

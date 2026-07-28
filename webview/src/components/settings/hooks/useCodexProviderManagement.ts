import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { CodexProviderConfig } from '../../../types/provider';

const sendToJava = (message: string) => {
  if (window.sendToJava) {
    window.sendToJava(message);
  }
  // Silently ignore when sendToJava is unavailable to avoid log pollution in production
};

export interface CodexProviderDialogState {
  isOpen: boolean;
  provider: CodexProviderConfig | null;
}

export interface DeleteCodexConfirmState {
  isOpen: boolean;
  provider: CodexProviderConfig | null;
}

export interface UseCodexProviderManagementOptions {
  onError?: (message: string) => void;
  onSuccess?: (message: string) => void;
}

export function useCodexProviderManagement(options: UseCodexProviderManagementOptions = {}) {
  const { t } = useTranslation();
  const { onSuccess } = options;

  // Codex provider list state
  const [codexProviders, setCodexProviders] = useState<CodexProviderConfig[]>([]);
  const [codexLoading, setCodexLoading] = useState(false);

  // Codex configuration (reserved for future display)
  const [_codexConfig, setCodexConfig] = useState<any>(null);
  const [_codexConfigLoading, setCodexConfigLoading] = useState(false);

  // Codex provider dialog state
  const [codexProviderDialog, setCodexProviderDialog] = useState<CodexProviderDialogState>({
    isOpen: false,
    provider: null,
  });

  // Codex provider delete confirmation state
  const [deleteCodexConfirm, setDeleteCodexConfirm] = useState<DeleteCodexConfirmState>({
    isOpen: false,
    provider: null,
  });

  // Load Codex provider list
  const loadCodexProviders = useCallback(() => {
    setCodexLoading(true);
    sendToJava('get_codex_providers:');
  }, []);

  // Update Codex provider list (used by window callback)
  const updateCodexProviders = useCallback((providersList: CodexProviderConfig[]) => {
    setCodexProviders(providersList);
    setCodexLoading(false);
  }, []);

  // Update active Codex provider (used by window callback)
  const updateActiveCodexProvider = useCallback((activeProvider: CodexProviderConfig) => {
    if (activeProvider) {
      setCodexProviders((prev) =>
        prev.map((p) => ({ ...p, isActive: p.id === activeProvider.id }))
      );
      // Custom models are now plugin-level, managed by PluginCustomModels in ProviderTabSection.
      // No longer sync provider-level customModels to localStorage.
    }
  }, []);

  // Update Codex configuration (used by window callback)
  const updateCurrentCodexConfig = useCallback((config: any) => {
    setCodexConfig(config);
    setCodexConfigLoading(false);
  }, []);

  // Open add Codex provider dialog
  const handleAddCodexProvider = useCallback(() => {
    setCodexProviderDialog({ isOpen: true, provider: null });
  }, []);

  // Open edit Codex provider dialog
  const handleEditCodexProvider = useCallback((provider: CodexProviderConfig) => {
    setCodexProviderDialog({ isOpen: true, provider });
  }, []);

  // Close Codex provider dialog
  const handleCloseCodexProviderDialog = useCallback(() => {
    setCodexProviderDialog({ isOpen: false, provider: null });
  }, []);

  // Save Codex provider
  const handleSaveCodexProvider = useCallback(
    (providerData: CodexProviderConfig) => {
      const isAdding = !codexProviderDialog.provider;

      if (isAdding) {
        sendToJava(`add_codex_provider:${JSON.stringify(providerData)}`);
        onSuccess?.(t('toast.providerAdded'));
      } else {
        const updateData = {
          id: providerData.id,
          updates: {
            name: providerData.name,
            remark: providerData.remark,
            configToml: providerData.configToml,
            authJson: providerData.authJson,
            customModels: providerData.customModels,
            messageEnvVars: providerData.messageEnvVars || [],
            mcpEnvVars: providerData.mcpEnvVars || [],
          },
        };
        sendToJava(`update_codex_provider:${JSON.stringify(updateData)}`);
        onSuccess?.(t('toast.providerUpdated'));
      }

      // Custom models are now plugin-level, managed by PluginCustomModels in ProviderTabSection.
      // No longer sync provider-level customModels to localStorage.

      setCodexProviderDialog({ isOpen: false, provider: null });
      setCodexLoading(true);
    },
    [codexProviderDialog.provider, codexProviders, onSuccess]
  );

  // Switch Codex provider
  const handleSwitchCodexProvider = useCallback((id: string) => {
    const data = { id };
    sendToJava(`switch_codex_provider:${JSON.stringify(data)}`);
    setCodexLoading(true);
  }, []);

  const handleAuthorizeCodexLocalConfig = useCallback(() => {
    sendToJava('authorize_codex_local_config:');
    setCodexLoading(true);
    setCodexConfigLoading(true);
  }, []);

  const handleRevokeCodexLocalConfigAuthorization = useCallback((fallbackProviderId?: string) => {
    const data = {
      fallbackProviderId: fallbackProviderId ?? '',
    };
    sendToJava(`revoke_codex_local_config_authorization:${JSON.stringify(data)}`);
    setCodexLoading(true);
    setCodexConfigLoading(true);
  }, []);

  // Delete Codex provider
  const handleDeleteCodexProvider = useCallback((provider: CodexProviderConfig) => {
    setDeleteCodexConfirm({ isOpen: true, provider });
  }, []);

  // Confirm Codex provider deletion
  const confirmDeleteCodexProvider = useCallback(() => {
    const provider = deleteCodexConfirm.provider;
    if (!provider) return;

    const data = { id: provider.id };
    sendToJava(`delete_codex_provider:${JSON.stringify(data)}`);
    onSuccess?.(t('toast.providerDeleted'));
    setCodexLoading(true);
    setDeleteCodexConfirm({ isOpen: false, provider: null });
  }, [deleteCodexConfirm.provider, onSuccess]);

  // Cancel Codex provider deletion
  const cancelDeleteCodexProvider = useCallback(() => {
    setDeleteCodexConfirm({ isOpen: false, provider: null });
  }, []);

  return {
    // State
    codexProviders,
    codexLoading,
    codexProviderDialog,
    deleteCodexConfirm,
    // Methods
    loadCodexProviders,
    updateCodexProviders,
    updateActiveCodexProvider,
    updateCurrentCodexConfig,
    handleAddCodexProvider,
    handleEditCodexProvider,
    handleCloseCodexProviderDialog,
    handleSaveCodexProvider,
    handleSwitchCodexProvider,
    handleAuthorizeCodexLocalConfig,
    handleRevokeCodexLocalConfigAuthorization,
    handleDeleteCodexProvider,
    confirmDeleteCodexProvider,
    cancelDeleteCodexProvider,
    // Setter
    setCodexLoading,
    setCodexConfigLoading,
  };
}

export type UseCodexProviderManagementReturn = ReturnType<typeof useCodexProviderManagement>;

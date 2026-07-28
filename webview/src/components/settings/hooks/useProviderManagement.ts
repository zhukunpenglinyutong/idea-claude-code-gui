import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProviderConfig } from '../../../types/provider';
import { SPECIAL_PROVIDER_IDS } from '../../../types/provider';
import { writeClaudeModelMapping } from '../../../utils/claudeModelMapping';

const sendToJava = (message: string) => {
  if (window.sendToJava) {
    window.sendToJava(message);
  }
  // Silently ignore when sendToJava is unavailable to avoid log pollution in production
};

export interface ProviderDialogState {
  isOpen: boolean;
  provider: ProviderConfig | null;
}

export interface DeleteConfirmState {
  isOpen: boolean;
  provider: ProviderConfig | null;
}

export interface UseProviderManagementOptions {
  onError?: (message: string) => void;
  onSuccess?: (message: string) => void;
}

export function useProviderManagement(options: UseProviderManagementOptions = {}) {
  const { t } = useTranslation();
  const { onError, onSuccess } = options;

  // Provider list state
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [loading, setLoading] = useState(false);

  // Provider dialog state
  const [providerDialog, setProviderDialog] = useState<ProviderDialogState>({
    isOpen: false,
    provider: null,
  });

  // Delete confirmation dialog state
  const [deleteConfirm, setDeleteConfirm] = useState<DeleteConfirmState>({
    isOpen: false,
    provider: null,
  });

  // Sync active provider model mapping to localStorage
  const syncActiveProviderModelMapping = useCallback((provider?: ProviderConfig | null) => {
    if (!provider || !provider.settingsConfig || !provider.settingsConfig.env) {
      writeClaudeModelMapping({});
      return;
    }
    const env = provider.settingsConfig.env as Record<string, any>;
    const mapping = {
      main: env.ANTHROPIC_MODEL ?? '',
      fable: env.ANTHROPIC_DEFAULT_FABLE_MODEL ?? '',
      haiku: env.ANTHROPIC_DEFAULT_HAIKU_MODEL ?? '',
      sonnet: env.ANTHROPIC_DEFAULT_SONNET_MODEL ?? '',
      opus: env.ANTHROPIC_DEFAULT_OPUS_MODEL ?? '',
    };
    writeClaudeModelMapping(mapping);
  }, []);

  // Load provider list
  const loadProviders = useCallback(() => {
    setLoading(true);
    sendToJava('get_providers:');
  }, []);

  // Update provider list (used by window callback)
  const updateProviders = useCallback(
    (providersList: ProviderConfig[]) => {
      setProviders(providersList);
      const active = providersList.find((p) => p.isActive);
      if (active) {
        syncActiveProviderModelMapping(active);
      } else {
        syncActiveProviderModelMapping(null);
      }
      setLoading(false);
    },
    [syncActiveProviderModelMapping]
  );

  // Update active provider (used by window callback)
  const updateActiveProvider = useCallback(
    (activeProvider: ProviderConfig) => {
      if (activeProvider) {
        setProviders((prev) =>
          prev.map((p) => ({ ...p, isActive: p.id === activeProvider.id }))
        );
        syncActiveProviderModelMapping(activeProvider);
      }
    },
    [syncActiveProviderModelMapping]
  );

  // Open edit dialog
  const handleEditProvider = useCallback((provider: ProviderConfig) => {
    setProviderDialog({ isOpen: true, provider });
  }, []);

  // Open add dialog
  const handleAddProvider = useCallback(() => {
    setProviderDialog({ isOpen: true, provider: null });
  }, []);

  // Close dialog
  const handleCloseProviderDialog = useCallback(() => {
    setProviderDialog({ isOpen: false, provider: null });
  }, []);

  // Save provider
  const handleSaveProvider = useCallback(
    (data: {
      providerName: string;
      remark: string;
      apiKey: string;
      apiUrl: string;
      jsonConfig: string;
    }) => {
      if (!data.providerName) {
        onError?.(t('toast.pleaseEnterProviderName'));
        return false;
      }

      let parsedConfig;
      try {
        parsedConfig = JSON.parse(data.jsonConfig || '{}');
      } catch (e) {
        onError?.(t('toast.invalidJsonConfig'));
        return false;
      }

      const updates = {
        name: data.providerName,
        remark: data.remark,
        websiteUrl: null,
        settingsConfig: parsedConfig,
      };

      const isAdding = !providerDialog.provider;

      if (isAdding) {
        const newProvider = {
          id: crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(),
          ...updates,
        };
        sendToJava(`add_provider:${JSON.stringify(newProvider)}`);
        onSuccess?.(t('toast.providerAdded'));
      } else {
        if (!providerDialog.provider) return false;

        const providerId = providerDialog.provider.id;
        const currentProvider =
          providers.find((p) => p.id === providerId) || providerDialog.provider;
        const isActive = currentProvider.isActive;

        const updateData = {
          id: providerId,
          updates,
        };
        sendToJava(`update_provider:${JSON.stringify(updateData)}`);
        onSuccess?.(t('toast.providerUpdated'));

        if (isActive) {
          syncActiveProviderModelMapping({
            ...currentProvider,
            settingsConfig: parsedConfig,
          });
          setTimeout(() => {
            sendToJava(`switch_provider:${JSON.stringify({ id: providerId })}`);
          }, 100);
        }
      }

      setProviderDialog({ isOpen: false, provider: null });
      setLoading(true);
      return true;
    },
    [providerDialog.provider, providers, syncActiveProviderModelMapping, onError, onSuccess]
  );

  // Switch provider
  const handleSwitchProvider = useCallback(
    (id: string) => {
      const data = { id };
      if (id === SPECIAL_PROVIDER_IDS.DISABLED) {
        syncActiveProviderModelMapping(null);
        sendToJava(`switch_provider:${JSON.stringify(data)}`);
        setLoading(true);
        return;
      }
      const target = providers.find((p) => p.id === id);
      if (target) {
        syncActiveProviderModelMapping(target);
      }
      sendToJava(`switch_provider:${JSON.stringify(data)}`);
      setLoading(true);
    },
    [providers, syncActiveProviderModelMapping]
  );

  // Delete provider
  const handleDeleteProvider = useCallback((provider: ProviderConfig) => {
    setDeleteConfirm({ isOpen: true, provider });
  }, []);

  // Confirm deletion
  const confirmDeleteProvider = useCallback(() => {
    const provider = deleteConfirm.provider;
    if (!provider) return;

    const data = { id: provider.id };
    sendToJava(`delete_provider:${JSON.stringify(data)}`);
    onSuccess?.(t('toast.providerDeleted'));
    setLoading(true);
    setDeleteConfirm({ isOpen: false, provider: null });
  }, [deleteConfirm.provider, onSuccess]);

  // Cancel deletion
  const cancelDeleteProvider = useCallback(() => {
    setDeleteConfirm({ isOpen: false, provider: null });
  }, []);

  return {
    // State
    providers,
    loading,
    providerDialog,
    deleteConfirm,

    // Methods
    loadProviders,
    updateProviders,
    updateActiveProvider,
    handleEditProvider,
    handleAddProvider,
    handleCloseProviderDialog,
    handleSaveProvider,
    handleSwitchProvider,
    handleDeleteProvider,
    confirmDeleteProvider,
    cancelDeleteProvider,
    syncActiveProviderModelMapping,

    // Setter (for external loading state control)
    setLoading,
  };
}

export type UseProviderManagementReturn = ReturnType<typeof useProviderManagement>;

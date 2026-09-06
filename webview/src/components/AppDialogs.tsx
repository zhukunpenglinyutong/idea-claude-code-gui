import { useEffect, useState, type ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';
import ConfirmDialog from './ConfirmDialog';
import PermissionDialog from './PermissionDialog';
import AskUserQuestionDialog from './AskUserQuestionDialog';
import PlanApprovalDialog from './PlanApprovalDialog';
import RewindDialog from './RewindDialog';
import RewindSelectDialog, { type RewindableMessage } from './RewindSelectDialog';
import ChangelogDialog from './ChangelogDialog';
import CustomModelDialog from './settings/CustomModelDialog';
import { usePluginModels } from './settings/hooks/usePluginModels';
import { STORAGE_KEYS } from '../types/provider';
import { CHANGELOG_DATA } from '../version/changelog';
import { useDialogs } from '../contexts/DialogContext';
import { useUIState } from '../contexts/UIStateContext';
import ContextUsageDialog from './ContextUsageDialog';
import { DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS } from '../utils/permissionDialogTimeout';
import { setSkipNewSessionConfirm } from '../utils/skipNewSessionConfirm';

/**
 * Wrapper that manages plugin-level custom models for the add-model dialog.
 * Uses the shared usePluginModels hook for localStorage persistence.
 */
const AddModelDialogWrapper = ({
  isOpen,
  onClose,
  currentProvider,
}: {
  isOpen: boolean;
  onClose: () => void;
  currentProvider: string;
}) => {
  const storageKey = currentProvider === 'codex'
    ? STORAGE_KEYS.CODEX_CUSTOM_MODELS
    : STORAGE_KEYS.CLAUDE_CUSTOM_MODELS;
  const { models, updateModels } = usePluginModels(storageKey);
  return (
    <CustomModelDialog
      isOpen={isOpen}
      models={models}
      onModelsChange={updateModels}
      onClose={onClose}
      contextWindowEnabled={currentProvider === 'codex'}
      initialAddMode
    />
  );
};

export interface AppDialogsProps {
  /** Session-management dialogs come from useSessionManagement, still passed as props. */
  showNewSessionConfirm: boolean;
  onConfirmNewSession: () => void;
  onCancelNewSession: () => void;
  showInterruptConfirm: boolean;
  onConfirmInterrupt: () => void;
  onCancelInterrupt: () => void;
  /** Rewind selection list is computed in App.tsx from messages, still a prop. */
  rewindableMessages: RewindableMessage[];
  onRewindSelect: ComponentProps<typeof RewindSelectDialog>['onSelect'];
  onRewindSelectCancel: ComponentProps<typeof RewindSelectDialog>['onCancel'];
  onRewindConfirm: ComponentProps<typeof RewindDialog>['onConfirm'];
  onRewindCancel: ComponentProps<typeof RewindDialog>['onCancel'];
  /** Provider id for the add-model dialog (lives in useModelProviderState). */
  currentProvider: string;
  /** Permission dialog timeout in seconds (from backend config). */
  permissionDialogTimeoutSeconds?: number;
  /** Apply the execution mode chosen while approving a Claude plan. */
  onPlanApprovalModeChange?: (mode: string) => void;
}

/**
 * Renders all top-level dialogs.
 * Permission / ask-user / plan / rewind / changelog / add-model state is read
 * from DialogContext and UIStateContext directly to avoid prop drilling 25+
 * fields from App.tsx (stage 4-5 of TASK-P1-01).
 */
export const AppDialogs = ({
  showNewSessionConfirm,
  onConfirmNewSession,
  onCancelNewSession,
  showInterruptConfirm,
  onConfirmInterrupt,
  onCancelInterrupt,
  rewindableMessages,
  onRewindSelect,
  onRewindSelectCancel,
  onRewindConfirm,
  onRewindCancel,
  currentProvider,
  permissionDialogTimeoutSeconds = DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS,
  onPlanApprovalModeChange,
}: AppDialogsProps) => {
  const { t } = useTranslation();
  const {
    permissionDialogOpen, currentPermissionRequest,
    handlePermissionApprove, handlePermissionApproveAlways, handlePermissionSkip,
    askUserQuestionDialogOpen, currentAskUserQuestionRequest,
    handleAskUserQuestionSubmit, handleAskUserQuestionCancel,
    planApprovalDialogOpen, currentPlanApprovalRequest,
    handlePlanApprovalApprove, handlePlanApprovalReject,
    rewindSelectDialogOpen, rewindDialogOpen, currentRewindRequest, isRewinding,
    contextUsageDialogOpen, contextUsageIsLoading, contextUsageData, closeContextUsageDialog,
  } = useDialogs();
  const {
    showChangelogDialog, closeChangelogDialog,
    addModelDialogOpen, setAddModelDialogOpen,
  } = useUIState();

  // "Don't ask again" checkbox state for the new-session confirm dialog.
  // Resets to unchecked every time the dialog re-opens so the user re-affirms
  // intent each time they want to silence it.
  const [skipNewSessionAgain, setSkipNewSessionAgain] = useState(false);
  useEffect(() => {
    if (showNewSessionConfirm) {
      setSkipNewSessionAgain(false);
    }
  }, [showNewSessionConfirm]);

  const handleConfirmNewSessionWithSkip = () => {
    if (skipNewSessionAgain) {
      // Persist before navigating away — listeners (settings page) sync automatically.
      setSkipNewSessionConfirm(true);
    }
    onConfirmNewSession();
  };
  // Note: We deliberately do NOT persist the "don't ask again" checkbox when the
  // user cancels the dialog. A cancelled dialog means they did not intend the
  // destructive action AND did not intend to change the preference. The state is
  // discarded via the useEffect above on next open.

  return (
    <>
      <ConfirmDialog
        isOpen={showNewSessionConfirm}
        title={t('chat.createNewSession')}
        message={t('chat.confirmNewSession')}
        confirmText={t('common.confirm')}
        cancelText={t('common.cancel')}
        onConfirm={handleConfirmNewSessionWithSkip}
        onCancel={onCancelNewSession}
      >
        <label className="confirm-dialog-dont-ask-again">
          <input
            type="checkbox"
            checked={skipNewSessionAgain}
            onChange={(e) => setSkipNewSessionAgain(e.target.checked)}
          />
          <span>{t('common.dontAskAgain')}</span>
        </label>
      </ConfirmDialog>
      <ConfirmDialog
        isOpen={showInterruptConfirm}
        title={t('chat.createNewSession')}
        message={t('chat.confirmInterrupt')}
        confirmText={t('common.confirm')}
        cancelText={t('common.cancel')}
        onConfirm={onConfirmInterrupt}
        onCancel={onCancelInterrupt}
      />
      <PermissionDialog
        isOpen={permissionDialogOpen}
        request={currentPermissionRequest}
        onApprove={handlePermissionApprove}
        onSkip={handlePermissionSkip}
        onApproveAlways={handlePermissionApproveAlways}
        timeoutSeconds={permissionDialogTimeoutSeconds}
      />
      <AskUserQuestionDialog
        isOpen={askUserQuestionDialogOpen}
        request={currentAskUserQuestionRequest}
        onSubmit={handleAskUserQuestionSubmit}
        onCancel={handleAskUserQuestionCancel}
        timeoutSeconds={permissionDialogTimeoutSeconds}
      />
      <PlanApprovalDialog
        isOpen={planApprovalDialogOpen}
        request={currentPlanApprovalRequest}
        onApprove={(requestId, targetMode) => {
          handlePlanApprovalApprove(requestId, targetMode);
          onPlanApprovalModeChange?.(targetMode);
        }}
        onReject={handlePlanApprovalReject}
        timeoutSeconds={permissionDialogTimeoutSeconds}
      />
      <RewindSelectDialog
        isOpen={rewindSelectDialogOpen}
        rewindableMessages={rewindableMessages}
        onSelect={onRewindSelect}
        onCancel={onRewindSelectCancel}
      />
      <RewindDialog
        isOpen={rewindDialogOpen}
        request={currentRewindRequest}
        isLoading={isRewinding}
        onConfirm={onRewindConfirm}
        onCancel={onRewindCancel}
      />
      <ChangelogDialog
        isOpen={showChangelogDialog}
        onClose={closeChangelogDialog}
        entries={CHANGELOG_DATA}
      />
      <AddModelDialogWrapper
        isOpen={addModelDialogOpen}
        onClose={() => setAddModelDialogOpen(false)}
        currentProvider={currentProvider}
      />
      {contextUsageDialogOpen ? (
        <ContextUsageDialog
          isOpen={contextUsageDialogOpen}
          isLoading={contextUsageIsLoading}
          data={contextUsageData}
          onClose={closeContextUsageDialog}
        />
      ) : null}
    </>
  );
};

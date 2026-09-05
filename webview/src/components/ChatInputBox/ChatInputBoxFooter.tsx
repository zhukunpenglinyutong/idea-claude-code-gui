import type { TFunction } from 'i18next';
import type { CodexFastMode, DropdownItemData, DropdownPosition, PermissionMode, ReasoningEffort, SelectedAgent } from './types.js';
import type { TooltipState } from './hooks/useTooltip.js';
import { ButtonArea } from './ButtonArea.js';
import { CompletionDropdown } from './Dropdown/index.js';
import { PromptEnhancerDialog } from './PromptEnhancerDialog.js';

interface CompletionController {
  isOpen: boolean;
  position: DropdownPosition | null;
  items: DropdownItemData[];
  activeIndex: number;
  loading: boolean;
  close: () => void;
  selectIndex: (index: number) => void;
  handleMouseEnter: (index: number) => void;
}

export function ChatInputBoxFooter({
  disabled,
  hasInputContent,
  isLoading,
  isEnhancing,
  selectedModel,
  permissionMode,
  currentProvider,
  codexNativeAutoReviewAvailable = true,
  reasoningEffort,
  codexFastMode,
  dshPreset,
  onSubmit,
  onStop,
  onModeSelect,
  onModelSelect,
  onProviderSelect,
  onReasoningChange,
  onCodexFastModeChange,
  onDshPresetChange,
  onEnhancePrompt,
  alwaysThinkingEnabled,
  onToggleThinking,
  streamingEnabled,
  onStreamingEnabledChange,
  selectedAgent,
  onAgentSelect,
  onOpenAgentSettings,
  onAddModel,
  onClearAgent,
  onOpenCliSettings,
  onOpenCodeBuddySettings,
  longContextEnabled = true,
  onLongContextChange,
  fileCompletion,
  commandCompletion,
  agentCompletion,
  promptCompletion,
  dollarCommandCompletion,
  tooltip,
  promptEnhancer,
  t,
}: {
  disabled: boolean;
  hasInputContent: boolean;
  isLoading: boolean;
  isEnhancing: boolean;
  selectedModel: string;
  permissionMode: PermissionMode;
  currentProvider: string;
  codexNativeAutoReviewAvailable?: boolean;
  reasoningEffort: ReasoningEffort;
  codexFastMode?: CodexFastMode;
  dshPreset?: string;
  onSubmit: () => void;
  onStop?: () => void;
  onModeSelect?: (mode: PermissionMode) => void;
  onModelSelect?: (modelId: string) => void;
  onProviderSelect?: (providerId: string) => void;
  onReasoningChange?: (effort: ReasoningEffort) => void;
  onCodexFastModeChange?: (mode: CodexFastMode) => void;
  onDshPresetChange?: (preset: string) => void;
  onEnhancePrompt: () => void;
  alwaysThinkingEnabled?: boolean;
  onToggleThinking?: (enabled: boolean) => void;
  streamingEnabled?: boolean;
  onStreamingEnabledChange?: (enabled: boolean) => void;
  selectedAgent?: SelectedAgent | null;
  onAgentSelect?: (agent: SelectedAgent) => void;
  onOpenAgentSettings?: () => void;
  onAddModel?: () => void;
  onClearAgent: () => void;
  onOpenCliSettings?: () => void;
  onOpenCodeBuddySettings?: () => void;
  longContextEnabled?: boolean;
  onLongContextChange?: (enabled: boolean) => void;
  fileCompletion: CompletionController;
  commandCompletion: CompletionController;
  agentCompletion: CompletionController;
  promptCompletion: CompletionController;
  dollarCommandCompletion?: CompletionController;
  tooltip: TooltipState | null;
  promptEnhancer: {
    isOpen: boolean;
    isLoading: boolean;
    originalPrompt: string;
    enhancedPrompt: string;
    usageInfo?: {
      provider: string | null;
      model: string | null;
      resolutionSource: 'manual' | 'auto' | 'unavailable' | null;
    } | null;
    onUseEnhanced: () => void;
    onKeepOriginal: () => void;
    onClose: () => void;
    onOpenSettings?: () => void;
  };
  t: TFunction;
}) {
  return (
    <>
      {/* Bottom button area */}
      <ButtonArea
        disabled={disabled || isLoading}
        hasInputContent={hasInputContent}
        isLoading={isLoading}
        isEnhancing={isEnhancing}
        selectedModel={selectedModel}
        permissionMode={permissionMode}
        currentProvider={currentProvider}
        codexNativeAutoReviewAvailable={codexNativeAutoReviewAvailable}
        reasoningEffort={reasoningEffort}
        codexFastMode={codexFastMode}
        dshPreset={dshPreset}
        onSubmit={onSubmit}
        onStop={onStop}
        onModeSelect={onModeSelect}
        onModelSelect={onModelSelect}
        onProviderSelect={onProviderSelect}
        onReasoningChange={onReasoningChange}
        onCodexFastModeChange={onCodexFastModeChange}
        onDshPresetChange={onDshPresetChange}
        onEnhancePrompt={onEnhancePrompt}
        alwaysThinkingEnabled={alwaysThinkingEnabled}
        onToggleThinking={onToggleThinking}
        streamingEnabled={streamingEnabled}
        onStreamingEnabledChange={onStreamingEnabledChange}
        selectedAgent={selectedAgent}
        onAgentSelect={(agent) => onAgentSelect?.(agent)}
        onOpenAgentSettings={onOpenAgentSettings}
        onAddModel={onAddModel}
        onClearAgent={onClearAgent}
        onOpenCliSettings={onOpenCliSettings}
        onOpenCodeBuddySettings={onOpenCodeBuddySettings}
        longContextEnabled={longContextEnabled}
        onLongContextChange={onLongContextChange}
      />

      {/* @ file reference dropdown menu */}
      <CompletionDropdown
        isVisible={fileCompletion.isOpen}
        position={fileCompletion.position}
        items={fileCompletion.items}
        selectedIndex={fileCompletion.activeIndex}
        loading={fileCompletion.loading}
        emptyText={t('chat.noMatchingFiles')}
        onClose={fileCompletion.close}
        onSelect={(_, index) => fileCompletion.selectIndex(index)}
        onMouseEnter={fileCompletion.handleMouseEnter}
      />

      {/* / slash command dropdown menu */}
      <CompletionDropdown
        isVisible={commandCompletion.isOpen}
        position={commandCompletion.position}
        width={450}
        items={commandCompletion.items}
        selectedIndex={commandCompletion.activeIndex}
        loading={commandCompletion.loading}
        emptyText={t('chat.noMatchingCommands')}
        onClose={commandCompletion.close}
        onSelect={(_, index) => commandCompletion.selectIndex(index)}
        onMouseEnter={commandCompletion.handleMouseEnter}
      />

      {/* # agent selection dropdown menu */}
      <CompletionDropdown
        isVisible={agentCompletion.isOpen}
        position={agentCompletion.position}
        width={350}
        items={agentCompletion.items}
        selectedIndex={agentCompletion.activeIndex}
        loading={agentCompletion.loading}
        emptyText={t('chat.noAvailableAgents')}
        onClose={agentCompletion.close}
        onSelect={(_, index) => agentCompletion.selectIndex(index)}
        onMouseEnter={agentCompletion.handleMouseEnter}
      />

      {/* ! prompt selection dropdown menu */}
      <CompletionDropdown
        isVisible={promptCompletion.isOpen}
        position={promptCompletion.position}
        width={400}
        items={promptCompletion.items}
        selectedIndex={promptCompletion.activeIndex}
        loading={promptCompletion.loading}
        emptyText={t('settings.prompt.noPromptsDropdown')}
        onClose={promptCompletion.close}
        onSelect={(_, index) => promptCompletion.selectIndex(index)}
        onMouseEnter={promptCompletion.handleMouseEnter}
      />

      {/* $ command dropdown menu */}
      {dollarCommandCompletion && (
        <CompletionDropdown
          isVisible={dollarCommandCompletion.isOpen}
          position={dollarCommandCompletion.position}
          width={400}
          items={dollarCommandCompletion.items}
          selectedIndex={dollarCommandCompletion.activeIndex}
          loading={dollarCommandCompletion.loading}
          emptyText={t('chat.noMatchingCommands')}
          onClose={dollarCommandCompletion.close}
          onSelect={(_, index) => dollarCommandCompletion.selectIndex(index)}
          onMouseEnter={dollarCommandCompletion.handleMouseEnter}
        />
      )}

      {/* Floating Tooltip (uses Portal or Fixed positioning to break overflow limit) */}
      {tooltip && tooltip.visible && (() => {
        const tooltipStyle: React.CSSProperties = {
          top: `${tooltip.top}px`,
          left: `${tooltip.left}px`,
          width: tooltip.width ? `${tooltip.width}px` : undefined,
          // @ts-expect-error CSS custom properties
          '--tooltip-tx': tooltip.tx || '-50%',
          '--arrow-left': tooltip.arrowLeft || '50%',
        };
        return (
        <div
          className={`tooltip-popup ${tooltip.isBar ? 'tooltip-bar' : ''}`}
          style={tooltipStyle}
        >
          {tooltip.text}
        </div>
        );
      })()}

      {/* Prompt enhancer dialog */}
      <PromptEnhancerDialog
        isOpen={promptEnhancer.isOpen}
        isLoading={promptEnhancer.isLoading}
        originalPrompt={promptEnhancer.originalPrompt}
        enhancedPrompt={promptEnhancer.enhancedPrompt}
        usageInfo={promptEnhancer.usageInfo}
        onUseEnhanced={promptEnhancer.onUseEnhanced}
        onKeepOriginal={promptEnhancer.onKeepOriginal}
        onClose={promptEnhancer.onClose}
        onOpenSettings={promptEnhancer.onOpenSettings}
      />
    </>
  );
}

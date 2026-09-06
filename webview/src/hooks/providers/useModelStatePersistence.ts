import { useEffect } from 'react';
import { sendBridgeEvent } from '../../utils/bridge';
import {
  CLAUDE_MODELS,
  CODEX_MODELS,
  DEFAULT_CLAUDE_MODEL_ID,
  GROK_DEFAULT_MODEL_ID,
  KIMI_DEFAULT_MODEL_ID,
  OMP_DEFAULT_MODEL_ID,
  MINIMAX_DEFAULT_MODEL_ID,
  OPENCODE_DEFAULT_MODEL_ID,
  PI_DEFAULT_MODEL_ID,
  DSH_DEFAULT_MODEL_ID,
  DSH_PRESET_NONE,
  isValidDshPreset,
  isValidPermissionMode,
  normalizeClaudeModelId,
  apply1MContextSuffix,
  strip1MContextSuffix,
} from '../../components/ChatInputBox/types';
import type { CodexFastMode, PermissionMode, ReasoningEffort } from '../../components/ChatInputBox/types';
import { isCliOnlyProvider, normalizeCliPermissionMode, OMP_ROLE_MODEL_IDS } from './cliProviders';

const STORAGE_KEY = 'model-selection-state';
const REASONING_VALUES = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const CODEX_FAST_MODE_VALUES = ['normal', 'fast'] as const;

const getCustomModels = (key: string): { id: string }[] => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
};

const isReasoningEffort = (value: unknown): value is ReasoningEffort =>
  typeof value === 'string' && (REASONING_VALUES as readonly string[]).includes(value);

const isCodexFastMode = (value: unknown): value is CodexFastMode =>
  typeof value === 'string' && (CODEX_FAST_MODE_VALUES as readonly string[]).includes(value);

/**
 * OMP modes are dynamic model roles (designer, vision, …) beyond the static
 * VALID_PERMISSION_MODE_IDS whitelist, so restore accepts any well-formed
 * role id rather than only the static set.
 */
const OMP_MODE_ID_PATTERN = /^[a-zA-Z][\w-]{0,31}$/;
const isRestorableOmpMode = (value: unknown): value is PermissionMode =>
  typeof value === 'string' && OMP_MODE_ID_PATTERN.test(value);

// Older sessions stored autoEdit, but the canonical UI/backend value is acceptEdits.
const normalizeRestoredPermissionMode = (value: unknown): PermissionMode | null => {
  const candidate = value === 'autoEdit' ? 'acceptEdits' : value;
  return typeof candidate === 'string' && isValidPermissionMode(candidate) ? candidate : null;
};

export interface UseModelStatePersistenceOptions {
  // Cross-slice load setters (run once on mount)
  setCurrentProvider: (value: string) => void;
  setSelectedClaudeModel: (value: string) => void;
  setSelectedCodexModel: (value: string) => void;
  setClaudePermissionMode: (value: PermissionMode) => void;
  setCodexPermissionMode: (value: PermissionMode) => void;
  setSelectedGrokModel: (value: string) => void;
  setSelectedKimiModel: (value: string) => void;
  setSelectedMiniMaxModel: (value: string) => void;
  setSelectedOpenCodeModel: (value: string) => void;
  setSelectedPiModel: (value: string) => void;
  setSelectedOmpModel: (value: string) => void;
  setSelectedDshModel: (value: string) => void;
  setGrokPermissionMode: (value: PermissionMode) => void;
  setKimiPermissionMode: (value: PermissionMode) => void;
  setMiniMaxPermissionMode: (value: PermissionMode) => void;
  setOpenCodePermissionMode: (value: PermissionMode) => void;
  setPiPermissionMode: (value: PermissionMode) => void;
  setOmpPermissionMode: (value: PermissionMode) => void;
  setDshPermissionMode: (value: PermissionMode) => void;
  setPermissionMode: (value: PermissionMode) => void;
  setLongContextEnabled: (value: boolean) => void;
  setReasoningEffort: (value: ReasoningEffort) => void;
  setCodexFastMode: (value: CodexFastMode) => void;
  setDshPreset: (value: string) => void;
  // Cross-slice save deps (re-saves on any change)
  currentProvider: string;
  selectedClaudeModel: string;
  selectedCodexModel: string;
  claudePermissionMode: PermissionMode;
  codexPermissionMode: PermissionMode;
  selectedGrokModel: string;
  selectedKimiModel: string;
  selectedMiniMaxModel: string;
  selectedOpenCodeModel: string;
  selectedPiModel: string;
  selectedOmpModel: string;
  selectedDshModel: string;
  grokPermissionMode: PermissionMode;
  kimiPermissionMode: PermissionMode;
  miniMaxPermissionMode: PermissionMode;
  openCodePermissionMode: PermissionMode;
  piPermissionMode: PermissionMode;
  ompPermissionMode: PermissionMode;
  dshPermissionMode: PermissionMode;
  longContextEnabled: boolean;
  reasoningEffort: ReasoningEffort;
  codexFastMode: CodexFastMode;
  dshPreset: string;
}

/**
 * Two effects for persisting cross-slice provider/model state to localStorage:
 *  1. On mount: hydrate state from localStorage and sync the restored values
 *     to the backend (retrying until the JCEF bridge is ready).
 *  2. On change: re-save the snapshot to localStorage.
 *
 * Save uses `JSON.stringify` of the persisted keys; load applies
 * defensive validation (custom models lookup, permission mode allowlist,
 * reasoning effort allowlist) before invoking the slice setters.
 */
export function useModelStatePersistence(options: UseModelStatePersistenceOptions) {
  const {
    setCurrentProvider,
    setSelectedClaudeModel,
    setSelectedCodexModel,
    setClaudePermissionMode,
    setCodexPermissionMode,
    setSelectedGrokModel,
    setSelectedKimiModel,
    setSelectedMiniMaxModel,
    setSelectedOpenCodeModel,
    setSelectedPiModel,
    setSelectedOmpModel,
    setSelectedDshModel,
    setGrokPermissionMode,
    setKimiPermissionMode,
    setMiniMaxPermissionMode,
    setOpenCodePermissionMode,
    setPiPermissionMode,
    setOmpPermissionMode,
    setDshPermissionMode,
    setPermissionMode,
    setLongContextEnabled,
    setReasoningEffort,
    setCodexFastMode,
    setDshPreset,
    currentProvider,
    selectedClaudeModel,
    selectedCodexModel,
    claudePermissionMode,
    codexPermissionMode,
    selectedGrokModel,
    selectedKimiModel,
    selectedMiniMaxModel,
    selectedOpenCodeModel,
    selectedPiModel,
    selectedOmpModel,
    selectedDshModel,
    grokPermissionMode,
    kimiPermissionMode,
    miniMaxPermissionMode,
    openCodePermissionMode,
    piPermissionMode,
    ompPermissionMode,
    dshPermissionMode,
    longContextEnabled,
    reasoningEffort,
    codexFastMode,
    dshPreset,
  } = options;

  // Hydrate from localStorage and sync to backend (mount only).
  // Setters are stable; deps left empty to ensure single execution.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      // Per-tab restore (issue #1353): when the Java backend has loaded a saved
      // session for this specific tab, it injects __INITIAL_TAB_PROVIDER__ /
      // __INITIAL_TAB_MODEL__ into the HTML before React boots. Those values
      // win over the global localStorage snapshot, which is shared across every
      // tab in the JCEF process and would otherwise cause every CC tab on
      // restart to be set to whichever provider was last saved by ANY tab.
      const initialTabProvider = typeof window.__INITIAL_TAB_PROVIDER__ === 'string'
        ? window.__INITIAL_TAB_PROVIDER__.trim()
        : '';
      const initialTabModel = typeof window.__INITIAL_TAB_MODEL__ === 'string'
        ? window.__INITIAL_TAB_MODEL__.trim()
        : '';
      const hasBackendProvider = initialTabProvider === 'claude'
        || initialTabProvider === 'codex'
        || isCliOnlyProvider(initialTabProvider);
      const hasBackendModel = initialTabModel.length > 0;

      let restoredProvider = 'claude';
      let restoredClaudeModel = DEFAULT_CLAUDE_MODEL_ID;
      let restoredCodexModel = CODEX_MODELS[0].id;
      let restoredClaudePermissionMode: PermissionMode = 'default';
      let restoredCodexPermissionMode: PermissionMode = 'default';
      let restoredGrokModel = GROK_DEFAULT_MODEL_ID;
      let restoredKimiModel = KIMI_DEFAULT_MODEL_ID;
      let restoredMiniMaxModel = MINIMAX_DEFAULT_MODEL_ID;
      let restoredOpenCodeModel = OPENCODE_DEFAULT_MODEL_ID;
      let restoredPiModel = PI_DEFAULT_MODEL_ID;
      let restoredOmpModel = OMP_DEFAULT_MODEL_ID;
      let restoredDshModel = DSH_DEFAULT_MODEL_ID;
      let restoredGrokPermissionMode: PermissionMode = 'default';
      let restoredKimiPermissionMode: PermissionMode = 'default';
      let restoredMiniMaxPermissionMode: PermissionMode = 'default';
      let restoredOpenCodePermissionMode: PermissionMode = 'default';
      let restoredPiPermissionMode: PermissionMode = 'default';
      let restoredOmpPermissionMode: PermissionMode = 'default';
      let restoredDshPermissionMode: PermissionMode = 'default';
      let restoredLongContextEnabled = true;
      let restoredCodexFastMode: CodexFastMode = 'normal';
      let restoredDshPreset = DSH_PRESET_NONE;

      // Model validation helpers — close over the restored* lets so both
      // branches (saved localStorage / fresh backend-only) share the same logic
      // and each getCustomModels localStorage read happens at most once.
      const applyClaudeModel = (modelId: string) => {
        const normalized = normalizeClaudeModelId(strip1MContextSuffix(modelId));
        const customs = getCustomModels('claude-custom-models');
        if (CLAUDE_MODELS.find(m => m.id === normalized) || customs.find(m => m.id === normalized)) {
          restoredClaudeModel = normalized;
          setSelectedClaudeModel(normalized);
        }
      };
      const applyCodexModel = (modelId: string) => {
        // Codex catalogs are dynamic (config.toml `model` + model_catalog_json),
        // so any non-empty saved id is accepted — same policy as CLI providers.
        // A stale id is corrected by the catalog auto-select once the fetch lands.
        if (typeof modelId === 'string' && modelId.trim().length > 0) {
          restoredCodexModel = modelId;
          setSelectedCodexModel(modelId);
        }
      };
      // CLI catalogs are dynamic (user-defined Grok profiles, backend-reported
      // Kimi/OpenCode models), so any non-empty saved id is accepted.
      const makeCliModelApplier = (apply: (id: string) => void) => (modelId: unknown) => {
        if (typeof modelId === 'string' && modelId.trim().length > 0) {
          apply(modelId);
        }
      };
      const applyGrokModel = makeCliModelApplier((id) => {
        // Migrate stale sentinel / legacy ids saved by older versions — mirrors
        // normalizeGrokModelId in ai-bridge/services/grok/grok-utils.js.
        const lower = id.trim().toLowerCase();
        const sentinel = ['grok', 'default', '(default)', 'grok-4.5'].includes(lower);
        const normalized = sentinel ? GROK_DEFAULT_MODEL_ID : id;
        restoredGrokModel = normalized;
        setSelectedGrokModel(normalized);
      });
      const applyKimiModel = makeCliModelApplier((id) => {
        restoredKimiModel = id;
        setSelectedKimiModel(id);
      });
      const applyMiniMaxModel = makeCliModelApplier((id) => {
        restoredMiniMaxModel = id;
        setSelectedMiniMaxModel(id);
      });
      const applyOpenCodeModel = makeCliModelApplier((id) => {
        restoredOpenCodeModel = id;
        setSelectedOpenCodeModel(id);
      });
      const applyPiModel = makeCliModelApplier((id) => {
        restoredPiModel = id;
        setSelectedPiModel(id);
      });
      const applyOmpModel = makeCliModelApplier((id) => {
        restoredOmpModel = id;
        setSelectedOmpModel(id);
      });
      const applyDshModel = makeCliModelApplier((id) => {
        restoredDshModel = id;
        setSelectedDshModel(id);
      });

      if (saved) {
        const state = JSON.parse(saved);

        // Backend-supplied provider wins. We still fall through the rest of the
        // hydration so non-provider preferences (permission mode, reasoning
        // effort, codex fast mode, …) are restored from localStorage.
        const providerCandidate = hasBackendProvider ? initialTabProvider : state.provider;
        if (['claude', 'codex'].includes(providerCandidate) || isCliOnlyProvider(providerCandidate)) {
          restoredProvider = providerCandidate;
          setCurrentProvider(providerCandidate);
        }

        const restoredClaudeMode = normalizeRestoredPermissionMode(state.claudePermissionMode);
        if (restoredClaudeMode) {
          restoredClaudePermissionMode = restoredClaudeMode;
        }
        const restoredCodexMode = normalizeRestoredPermissionMode(state.codexPermissionMode);
        if (restoredCodexMode) {
          restoredCodexPermissionMode = restoredCodexMode === 'plan'
            ? 'default'
            : restoredCodexMode;
        }
        const restoredGrokMode = normalizeRestoredPermissionMode(state.grokPermissionMode);
        if (restoredGrokMode) {
          restoredGrokPermissionMode = normalizeCliPermissionMode(restoredGrokMode, 'grok');
        }
        const restoredKimiMode = normalizeRestoredPermissionMode(state.kimiPermissionMode);
        if (restoredKimiMode) {
          restoredKimiPermissionMode = normalizeCliPermissionMode(restoredKimiMode, 'kimi');
        }
        const restoredMiniMaxMode = normalizeRestoredPermissionMode(state.miniMaxPermissionMode);
        if (restoredMiniMaxMode) {
          restoredMiniMaxPermissionMode = normalizeCliPermissionMode(restoredMiniMaxMode, 'minimax');
        }
        const restoredOpenCodeMode = normalizeRestoredPermissionMode(state.openCodePermissionMode);
        if (restoredOpenCodeMode) {
          restoredOpenCodePermissionMode = normalizeCliPermissionMode(restoredOpenCodeMode, 'opencode');
        }
        const restoredPiMode = normalizeRestoredPermissionMode(state.piPermissionMode);
        if (restoredPiMode) {
          restoredPiPermissionMode = normalizeCliPermissionMode(restoredPiMode, 'pi');
        }
        if (isRestorableOmpMode(state.ompPermissionMode)) {
          const restoredOmpMode = state.ompPermissionMode === 'autoEdit'
            ? 'default'
            : state.ompPermissionMode;
          restoredOmpPermissionMode = normalizeCliPermissionMode(restoredOmpMode, 'omp');
        }
        const restoredDshMode = normalizeRestoredPermissionMode(state.dshPermissionMode);
        if (restoredDshMode) {
          restoredDshPermissionMode = normalizeCliPermissionMode(restoredDshMode, 'dsh');
        }

        if (typeof state.longContextEnabled === 'boolean') {
          restoredLongContextEnabled = state.longContextEnabled;
          setLongContextEnabled(state.longContextEnabled);
        }

        if (isReasoningEffort(state.reasoningEffort)) {
          setReasoningEffort(state.reasoningEffort);
        }
        if (isCodexFastMode(state.codexFastMode)) {
          restoredCodexFastMode = state.codexFastMode;
          setCodexFastMode(restoredCodexFastMode);
        }
        if (isValidDshPreset(state.dshPreset)) {
          restoredDshPreset = state.dshPreset;
          setDshPreset(restoredDshPreset);
        }

        const claudeModelCandidate = hasBackendModel && restoredProvider === 'claude'
          ? initialTabModel
          : state.claudeModel;
        applyClaudeModel(claudeModelCandidate);

        const codexModelCandidate = hasBackendModel && restoredProvider === 'codex'
          ? initialTabModel
          : state.codexModel;
        applyCodexModel(codexModelCandidate);

        const grokModelCandidate = hasBackendModel && restoredProvider === 'grok'
          ? initialTabModel
          : state.grokModel;
        applyGrokModel(grokModelCandidate);

        const kimiModelCandidate = hasBackendModel && restoredProvider === 'kimi'
          ? initialTabModel
          : state.kimiModel;
        applyKimiModel(kimiModelCandidate);

        const miniMaxModelCandidate = hasBackendModel && restoredProvider === 'minimax'
          ? initialTabModel
          : state.miniMaxModel;
        applyMiniMaxModel(miniMaxModelCandidate);

        const openCodeModelCandidate = hasBackendModel && restoredProvider === 'opencode'
          ? initialTabModel
          : state.openCodeModel;
        applyOpenCodeModel(openCodeModelCandidate);

        const piModelCandidate = hasBackendModel && restoredProvider === 'pi'
          ? initialTabModel
          : state.piModel;
        applyPiModel(piModelCandidate);

        const ompModelCandidate = hasBackendModel && restoredProvider === 'omp'
          ? initialTabModel
          : state.ompModel;
        applyOmpModel(ompModelCandidate);
        const dshModelCandidate = hasBackendModel && restoredProvider === 'dsh'
          ? initialTabModel
          : state.dshModel;
        applyDshModel(dshModelCandidate);
      } else if (hasBackendProvider) {
        // No localStorage yet (fresh user) but backend supplied a provider:
        // honor it so the tab starts with the right provider.
        restoredProvider = initialTabProvider;
        setCurrentProvider(initialTabProvider);
        if (hasBackendModel) {
          if (initialTabProvider === 'claude') applyClaudeModel(initialTabModel);
          else if (initialTabProvider === 'codex') applyCodexModel(initialTabModel);
          else if (initialTabProvider === 'grok') applyGrokModel(initialTabModel);
          else if (initialTabProvider === 'kimi') applyKimiModel(initialTabModel);
          else if (initialTabProvider === 'minimax') applyMiniMaxModel(initialTabModel);
          else if (initialTabProvider === 'opencode') applyOpenCodeModel(initialTabModel);
          else if (initialTabProvider === 'pi') applyPiModel(initialTabModel);
          else if (initialTabProvider === 'omp') applyOmpModel(initialTabModel);
          else if (initialTabProvider === 'dsh') applyDshModel(initialTabModel);
        }
      }

      // Reconcile omp mode⇔model pairs saved by builds before the two were
      // unified: a role id on either side wins and is mirrored onto the other,
      // so a stale { model: 'auto', mode: 'smol' } restores as model 'smol'.
      // Static roles only — snapshots from those builds predate dynamic roles.
      if (OMP_ROLE_MODEL_IDS.has(restoredOmpModel)) {
        restoredOmpPermissionMode = restoredOmpModel;
      } else if (
        OMP_ROLE_MODEL_IDS.has(restoredOmpPermissionMode)
        && restoredOmpModel === OMP_DEFAULT_MODEL_ID
      ) {
        applyOmpModel(restoredOmpPermissionMode);
      }

      const initialPermissionMode: PermissionMode = restoredProvider === 'codex'
        ? restoredCodexPermissionMode
        : restoredProvider === 'grok'
          ? restoredGrokPermissionMode
          : restoredProvider === 'kimi'
            ? restoredKimiPermissionMode
            : restoredProvider === 'minimax'
              ? restoredMiniMaxPermissionMode
              : restoredProvider === 'opencode'
              ? restoredOpenCodePermissionMode
              : restoredProvider === 'pi'
                ? restoredPiPermissionMode
                : restoredProvider === 'omp'
                  ? restoredOmpPermissionMode
                  : restoredProvider === 'dsh'
                    ? restoredDshPermissionMode
                    : restoredClaudePermissionMode;
      setClaudePermissionMode(restoredClaudePermissionMode);
      setCodexPermissionMode(restoredCodexPermissionMode);
      setGrokPermissionMode(restoredGrokPermissionMode);
      setKimiPermissionMode(restoredKimiPermissionMode);
      setMiniMaxPermissionMode(restoredMiniMaxPermissionMode);
      setOpenCodePermissionMode(restoredOpenCodePermissionMode);
      setPiPermissionMode(restoredPiPermissionMode);
      setOmpPermissionMode(restoredOmpPermissionMode);
      setDshPermissionMode(restoredDshPermissionMode);
      setPermissionMode(initialPermissionMode);

      let syncRetryCount = 0;
      const MAX_SYNC_RETRIES = 30;

      const syncToBackend = () => {
        if (window.sendToJava) {
          // Native watchdog reload reuses the original HTML snapshot. Java
          // pushes the current Session state after frontend_ready; echoing the
          // stale boot snapshot would route the existing transcript incorrectly.
          if (window.__CCGUI_RECOVERY_RELOAD__ === true) {
            return;
          }
          sendBridgeEvent('set_provider', restoredProvider);
          const modelToSync = restoredProvider === 'codex'
            ? restoredCodexModel
            : restoredProvider === 'grok'
              ? restoredGrokModel
              : restoredProvider === 'kimi'
                ? restoredKimiModel
                : restoredProvider === 'minimax'
                  ? restoredMiniMaxModel
                  : restoredProvider === 'opencode'
                  ? restoredOpenCodeModel
                  : restoredProvider === 'pi'
                    ? restoredPiModel
                    : restoredProvider === 'omp'
                      ? restoredOmpModel
                      : restoredProvider === 'dsh'
                        ? restoredDshModel
                        : apply1MContextSuffix(restoredClaudeModel, restoredLongContextEnabled);
          sendBridgeEvent('set_model', modelToSync);
          // Do NOT push the permission mode to Java on boot. Java is the source
          // of truth for the mode (persisted app-level in PropertiesComponent,
          // which survives a plugin reinstall) and the webview seeds its own mode
          // FROM Java via get_mode → onModeReceived. Our localStorage copy is
          // wiped on reinstall, so pushing it here would clobber the surviving
          // Java value with 'default' — the reported "reinstall forgets Full Auto" bug.
          // The mode is only sent to Java on an explicit user switch
          // (handleModeSelect → set_mode).
          sendBridgeEvent('set_codex_fast_mode', restoredCodexFastMode);
          if (restoredProvider === 'dsh') {
            sendBridgeEvent('set_dsh_preset', restoredDshPreset);
          }
        } else {
          syncRetryCount++;
          if (syncRetryCount < MAX_SYNC_RETRIES) {
            setTimeout(syncToBackend, 100);
          }
        }
      };
      setTimeout(syncToBackend, 200);
    } catch {
      // Failed to load model selection state — fall back to defaults already
      // set by individual slice hooks.
    }
  }, []);

  // Persist snapshot whenever any of the persisted keys change.
  useEffect(() => {
    let retryTimer: number | undefined;
    let retryCount = 0;

    const persistWhenPageContextIsReady = () => {
      const pageContextPending = window.__CCGUI_PAGE_CONTEXT_READY__ !== true;
      const recoveryStatePending = window.__CCGUI_RECOVERY_RELOAD__ === true
        && window.__CCGUI_RECOVERY_STATE_APPLIED__ !== true;

      // React may mount before onLoadEnd/fallback establishes the runtime page
      // context. Never publish provisional HTML/default state to the localStorage
      // snapshot shared by every tab. Keep the same fast-then-slow retry policy as
      // bridge startup so delayed remote JCEF initialization can still settle.
      if (pageContextPending || recoveryStatePending) {
        retryCount += 1;
        retryTimer = window.setTimeout(
          persistWhenPageContextIsReady,
          retryCount < 50 ? 100 : 1000,
        );
        return;
      }

      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
          provider: currentProvider,
          claudeModel: selectedClaudeModel,
          codexModel: selectedCodexModel,
          claudePermissionMode,
          codexPermissionMode,
          grokModel: selectedGrokModel,
          kimiModel: selectedKimiModel,
          miniMaxModel: selectedMiniMaxModel,
          openCodeModel: selectedOpenCodeModel,
          piModel: selectedPiModel,
          ompModel: selectedOmpModel,
          dshModel: selectedDshModel,
          grokPermissionMode,
          kimiPermissionMode,
          miniMaxPermissionMode,
          openCodePermissionMode,
          piPermissionMode,
          ompPermissionMode,
          dshPermissionMode,
          longContextEnabled,
          reasoningEffort,
          codexFastMode,
          dshPreset,
        }));
      } catch {
        // Failed to save model selection state — non-fatal.
      }
    };

    persistWhenPageContextIsReady();
    return () => {
      if (retryTimer !== undefined) {
        window.clearTimeout(retryTimer);
      }
    };
  }, [
    currentProvider,
    selectedClaudeModel,
    selectedCodexModel,
    claudePermissionMode,
    codexPermissionMode,
    selectedGrokModel,
    selectedKimiModel,
    selectedMiniMaxModel,
    selectedOpenCodeModel,
    selectedPiModel,
    selectedOmpModel,
    selectedDshModel,
    grokPermissionMode,
    kimiPermissionMode,
    miniMaxPermissionMode,
    openCodePermissionMode,
    piPermissionMode,
    ompPermissionMode,
    dshPermissionMode,
    longContextEnabled,
    reasoningEffort,
    codexFastMode,
    dshPreset,
  ]);
}

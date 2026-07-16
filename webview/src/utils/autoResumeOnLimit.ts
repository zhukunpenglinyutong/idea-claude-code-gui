/**
 * Persistence for the "auto-resume session after usage limit reset" toggle.
 *
 * Storage: localStorage (per-machine), default OFF so existing users see no
 * behaviour change after upgrade.
 *
 * Sync: a CustomEvent is dispatched after a successful write so the header
 * toggle (and any other listener) can react in real time. This mirrors the
 * pattern used by `skipNewSessionConfirm.ts`.
 */

export const AUTO_RESUME_ON_LIMIT_KEY = 'cc-gui.autoResumeOnLimit';
export const AUTO_RESUME_ON_LIMIT_EVENT = 'autoResumeOnLimitChanged';

export interface AutoResumeOnLimitChangedDetail {
  enabled: boolean;
}

/** Read the current preference. Defaults to `false` (feature off). */
export function getAutoResumeOnLimit(): boolean {
  try {
    return localStorage.getItem(AUTO_RESUME_ON_LIMIT_KEY) === 'true';
  } catch {
    // localStorage can throw in some sandboxed contexts; fall back to safest default.
    return false;
  }
}

/**
 * Persist the preference AND notify same-tab listeners.
 *
 * The native `storage` event only fires for cross-tab writes, so we dispatch a
 * CustomEvent for same-tab subscribers. If the write fails we deliberately do
 * NOT dispatch, so UI state never drifts from what the next reload will show.
 */
export function setAutoResumeOnLimit(enabled: boolean): void {
  try {
    localStorage.setItem(AUTO_RESUME_ON_LIMIT_KEY, enabled ? 'true' : 'false');
  } catch (error) {
    console.warn('[autoResumeOnLimit] failed to persist:', error);
    return;
  }

  const detail: AutoResumeOnLimitChangedDetail = { enabled };
  window.dispatchEvent(new CustomEvent(AUTO_RESUME_ON_LIMIT_EVENT, { detail }));
}

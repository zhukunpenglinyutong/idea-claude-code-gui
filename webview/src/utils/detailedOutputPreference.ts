export const DETAILED_OUTPUT_ENABLED_KEY = 'detailedOutputEnabled';
export const DETAILED_OUTPUT_ENABLED_EVENT = 'detailed-output-enabled-changed';

export interface DetailedOutputEnabledChangedDetail {
  enabled: boolean;
}

export function getDetailedOutputEnabled(): boolean {
  try {
    return localStorage.getItem(DETAILED_OUTPUT_ENABLED_KEY) === 'true';
  } catch {
    return false;
  }
}

export function setDetailedOutputEnabled(enabled: boolean): void {
  try {
    if (enabled) {
      localStorage.setItem(DETAILED_OUTPUT_ENABLED_KEY, 'true');
    } else {
      localStorage.removeItem(DETAILED_OUTPUT_ENABLED_KEY);
    }
  } catch (error) {
    console.warn('[detailedOutputPreference] failed to persist:', error);
    return;
  }

  window.dispatchEvent(new CustomEvent<DetailedOutputEnabledChangedDetail>(
    DETAILED_OUTPUT_ENABLED_EVENT,
    { detail: { enabled } }
  ));
}

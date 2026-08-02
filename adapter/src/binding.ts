/**
 * Target binding value object.
 *
 * Identity rules are frozen by `REMOTE_GATEWAY_API_EVENT_CONTRACT_V1.md` §1:
 * projectId is 32 lowercase hex chars, tabId is an opaque runtime UUID.
 */
export class BindingValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BindingValidationError';
  }
}

export const PROJECT_ID_PATTERN = /^[0-9a-f]{32}$/;
export const TAB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TargetBinding {
  readonly projectId: string;
  readonly tabId: string;
}

export function parseTarget(projectId: string, tabId: string): TargetBinding {
  const project = projectId.trim().toLowerCase();
  const tab = tabId.trim().toLowerCase();
  if (!PROJECT_ID_PATTERN.test(project)) {
    throw new BindingValidationError(`projectId must be 32 lowercase hex chars, got: ${projectId}`);
  }
  if (!TAB_ID_PATTERN.test(tab)) {
    throw new BindingValidationError(`tabId must be a UUID, got: ${tabId}`);
  }
  return { projectId: project, tabId: tab };
}

export function sameTarget(a: TargetBinding, b: TargetBinding): boolean {
  return a.projectId === b.projectId && a.tabId === b.tabId;
}

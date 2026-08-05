import { sendToJava } from '../../../utils/bridge';

export type AiDataDirectoryId = 'claude' | 'codemoss' | 'codex';
export type AiDataDirectoryState = 'missing' | 'local' | 'linked' | 'unavailable';

export interface AiDataDirectoryEntry {
  id: AiDataDirectoryId;
  canonicalPath: string;
  physicalPath?: string;
  state: AiDataDirectoryState;
}

export interface AiDataDirectoryStatus {
  platform: string;
  supported: boolean;
  wsl: boolean;
  homeDirectory: string;
  recovered: boolean;
  storageRoot?: string;
  backupCount: number;
  directories: AiDataDirectoryEntry[];
  backups: Array<{ id: AiDataDirectoryId; path: string }>;
}

export interface AiDataDirectoryOperation {
  operation: 'status' | 'migrate' | 'cleanup';
  success: boolean;
  error?: string;
  status?: AiDataDirectoryStatus;
}

type Listener<T> = (payload: T) => void;

const statusListeners = new Set<Listener<AiDataDirectoryStatus>>();
const rootListeners = new Set<Listener<string>>();
const operationListeners = new Set<Listener<AiDataDirectoryOperation>>();
const DIRECTORY_IDS: AiDataDirectoryId[] = ['claude', 'codemoss', 'codex'];
const DIRECTORY_STATES: AiDataDirectoryState[] = ['missing', 'local', 'linked', 'unavailable'];
const OPERATIONS: AiDataDirectoryOperation['operation'][] = ['status', 'migrate', 'cleanup'];

function parseObject(json: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(json);
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function parseAiDataDirectoryStatus(json: string): AiDataDirectoryStatus | null {
  const value = parseObject(json);
  if (!value
    || typeof value.platform !== 'string'
    || typeof value.supported !== 'boolean'
    || typeof value.wsl !== 'boolean'
    || typeof value.homeDirectory !== 'string'
    || typeof value.recovered !== 'boolean'
    || typeof value.backupCount !== 'number'
    || !Number.isFinite(value.backupCount)
    || !Array.isArray(value.directories)
    || !Array.isArray(value.backups)) return null;

  const directories = value.directories.flatMap((candidate): AiDataDirectoryEntry[] => {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) return [];
    const item = candidate as Record<string, unknown>;
    if (typeof item.id !== 'string' || !DIRECTORY_IDS.includes(item.id as AiDataDirectoryId)
      || typeof item.canonicalPath !== 'string'
      || typeof item.state !== 'string'
      || !DIRECTORY_STATES.includes(item.state as AiDataDirectoryState)
      || (item.physicalPath !== undefined && typeof item.physicalPath !== 'string')) return [];
    return [{
      id: item.id as AiDataDirectoryId,
      canonicalPath: item.canonicalPath,
      physicalPath: item.physicalPath as string | undefined,
      state: item.state as AiDataDirectoryState,
    }];
  });
  if (directories.length !== DIRECTORY_IDS.length
    || new Set(directories.map((entry) => entry.id)).size !== DIRECTORY_IDS.length) return null;

  const backups = value.backups.flatMap((candidate): Array<{ id: AiDataDirectoryId; path: string }> => {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) return [];
    const item = candidate as Record<string, unknown>;
    if (typeof item.id !== 'string' || !DIRECTORY_IDS.includes(item.id as AiDataDirectoryId)
      || typeof item.path !== 'string') return [];
    return [{ id: item.id as AiDataDirectoryId, path: item.path }];
  });

  return {
    platform: value.platform,
    supported: value.supported,
    wsl: value.wsl,
    homeDirectory: value.homeDirectory,
    recovered: value.recovered,
    storageRoot: typeof value.storageRoot === 'string' ? value.storageRoot : undefined,
    backupCount: Math.max(0, Math.trunc(value.backupCount)),
    directories,
    backups,
  };
}

export function parseAiDataDirectoryOperation(json: string): AiDataDirectoryOperation | null {
  const value = parseObject(json);
  if (!value || typeof value.operation !== 'string'
    || !OPERATIONS.includes(value.operation as AiDataDirectoryOperation['operation'])
    || typeof value.success !== 'boolean') return null;
  let status: AiDataDirectoryStatus | undefined;
  if (value.status !== undefined) {
    status = parseAiDataDirectoryStatus(JSON.stringify(value.status)) ?? undefined;
  }
  return {
    operation: value.operation as AiDataDirectoryOperation['operation'],
    success: value.success,
    error: typeof value.error === 'string' ? value.error : undefined,
    status,
  };
}

function subscribe<T>(listeners: Set<Listener<T>>, listener: Listener<T>): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

if (typeof window !== 'undefined') {
  window.updateAiDataDirectoryStatus = (json) => {
    const status = parseAiDataDirectoryStatus(json);
    if (status) statusListeners.forEach((listener) => listener(status));
  };
  window.onAiDataDirectoryRootSelected = (json) => {
    const value = parseObject(json);
    if (value && typeof value.path === 'string' && value.path.length <= 2048) {
      const selectedPath = value.path as string;
      rootListeners.forEach((listener) => listener(selectedPath));
    }
  };
  window.onAiDataDirectoryOperation = (json) => {
    const operation = parseAiDataDirectoryOperation(json);
    if (operation) operationListeners.forEach((listener) => listener(operation));
  };
}

export const aiDataStorageBridge = {
  subscribeStatus: (listener: Listener<AiDataDirectoryStatus>) => subscribe(statusListeners, listener),
  subscribeRoot: (listener: Listener<string>) => subscribe(rootListeners, listener),
  subscribeOperation: (listener: Listener<AiDataDirectoryOperation>) =>
    subscribe(operationListeners, listener),
  getStatus: () => sendToJava('get_ai_data_directory_status'),
  chooseRoot: () => sendToJava('choose_ai_data_directory_root'),
  migrate: (targetRoot: string) => sendToJava('migrate_ai_data_directories', { targetRoot }),
  cleanupBackups: () => sendToJava('cleanup_ai_data_directory_backups'),
};

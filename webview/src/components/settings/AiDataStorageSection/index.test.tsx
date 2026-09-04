import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AiDataStorageSection from './index';

const mocks = vi.hoisted(() => ({
  statusListeners: [] as Array<(status: unknown) => void>,
  rootListeners: [] as Array<(path: string) => void>,
  operationListeners: [] as Array<(operation: unknown) => void>,
  getStatus: vi.fn(),
  chooseRoot: vi.fn(),
  migrate: vi.fn(),
  cleanupBackups: vi.fn(),
  translate: (key: string) => key,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mocks.translate }),
}));

vi.mock('./aiDataStorageBridge', () => ({
  aiDataStorageBridge: {
    subscribeStatus: (listener: (status: unknown) => void) => {
      mocks.statusListeners.push(listener);
      return () => undefined;
    },
    subscribeRoot: (listener: (path: string) => void) => {
      mocks.rootListeners.push(listener);
      return () => undefined;
    },
    subscribeOperation: (listener: (operation: unknown) => void) => {
      mocks.operationListeners.push(listener);
      return () => undefined;
    },
    getStatus: mocks.getStatus,
    chooseRoot: mocks.chooseRoot,
    migrate: mocks.migrate,
    cleanupBackups: mocks.cleanupBackups,
  },
}));

const status = {
  platform: 'windows',
  supported: true,
  wsl: false,
  homeDirectory: 'C:/Users/test',
  recovered: false,
  backupCount: 1,
  directories: [
    { id: 'claude', canonicalPath: 'C:/Users/test/.claude', state: 'local' },
    { id: 'codemoss', canonicalPath: 'C:/Users/test/.codemoss', state: 'local' },
    { id: 'codex', canonicalPath: 'C:/Users/test/.codex', state: 'local' },
  ],
  backups: [{ id: 'codex', path: 'C:/Users/test/.codex.cc-gui-backup-1' }],
};

describe('AiDataStorageSection', () => {
  beforeEach(() => {
    mocks.statusListeners.length = 0;
    mocks.rootListeners.length = 0;
    mocks.operationListeners.length = 0;
    mocks.getStatus.mockClear();
    mocks.chooseRoot.mockClear();
    mocks.migrate.mockClear();
    mocks.cleanupBackups.mockClear();
    vi.restoreAllMocks();
  });

  it('shows all canonical directories and requests status on mount', () => {
    render(<AiDataStorageSection addToast={vi.fn()} />);
    act(() => mocks.statusListeners[0]!(status));

    expect(mocks.getStatus).toHaveBeenCalledOnce();
    expect(screen.getByText('.claude')).toBeTruthy();
    expect(screen.getByText('.codemoss')).toBeTruthy();
    expect(screen.getByText('.codex')).toBeTruthy();
  });

  it('requires confirmation before migration', () => {
    render(<AiDataStorageSection addToast={vi.fn()} />);
    act(() => mocks.statusListeners[0]!(status));
    act(() => mocks.rootListeners[0]!('D:/AI Data'));

    fireEvent.click(screen.getByRole('button', { name: 'settings.storage.migrate' }));
    expect(mocks.migrate).not.toHaveBeenCalled();
    expect(screen.getByText('settings.storage.migrateConfirmTitle')).toBeTruthy();
    expect(screen.getByText('D:/AI Data')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'settings.storage.confirmMigration' }));

    expect(mocks.migrate).toHaveBeenCalledWith('D:/AI Data');
  });

  it('requires confirmation before deleting migration backups', () => {
    render(<AiDataStorageSection addToast={vi.fn()} />);
    act(() => mocks.statusListeners[0]!(status));

    fireEvent.click(screen.getByRole('button', { name: 'settings.storage.cleanupBackups' }));
    expect(mocks.cleanupBackups).not.toHaveBeenCalled();
    expect(screen.getByText('settings.storage.cleanupConfirmTitle')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'settings.storage.deleteBackups' }));

    expect(mocks.cleanupBackups).toHaveBeenCalledOnce();
  });

  it('refreshes status from the directory list header', () => {
    render(<AiDataStorageSection addToast={vi.fn()} />);
    mocks.getStatus.mockClear();

    fireEvent.click(screen.getByRole('button', { name: 'common.refresh' }));

    expect(mocks.getStatus).toHaveBeenCalledOnce();
  });

  it('prevents repeating migration when the current storage root is selected', () => {
    render(<AiDataStorageSection addToast={vi.fn()} />);
    act(() => mocks.statusListeners[0]!({
      ...status,
      storageRoot: 'D:\\AI Data',
      directories: status.directories.map((entry) => ({
        ...entry,
        physicalPath: `D:/AI Data/.${entry.id}`,
        state: 'linked',
      })),
    }));

    const migrateButton = screen.getByRole('button', { name: 'settings.storage.alreadyMigrated' });
    expect((migrateButton as HTMLButtonElement).disabled).toBe(true);
  });
});

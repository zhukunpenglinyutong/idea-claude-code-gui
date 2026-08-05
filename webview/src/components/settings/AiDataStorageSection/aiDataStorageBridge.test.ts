import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sendToJava } from '../../../utils/bridge';
import {
  aiDataStorageBridge,
  parseAiDataDirectoryOperation,
  parseAiDataDirectoryStatus,
} from './aiDataStorageBridge';

vi.mock('../../../utils/bridge', () => ({ sendToJava: vi.fn() }));

const validStatus = {
  platform: 'windows',
  supported: true,
  wsl: false,
  homeDirectory: 'C:/Users/test',
  recovered: false,
  storageRoot: 'D:/AI',
  backupCount: 1,
  directories: [
    { id: 'claude', canonicalPath: 'C:/Users/test/.claude', physicalPath: 'D:/AI/.claude', state: 'linked' },
    { id: 'codemoss', canonicalPath: 'C:/Users/test/.codemoss', physicalPath: 'D:/AI/.codemoss', state: 'linked' },
    { id: 'codex', canonicalPath: 'C:/Users/test/.codex', physicalPath: 'D:/AI/.codex', state: 'linked' },
  ],
  backups: [{ id: 'codex', path: 'C:/Users/test/.codex.cc-gui-backup-1' }],
};

describe('aiDataStorageBridge', () => {
  beforeEach(() => {
    vi.mocked(sendToJava).mockClear();
  });

  it('accepts complete status payloads and rejects incomplete directory sets', () => {
    expect(parseAiDataDirectoryStatus(JSON.stringify(validStatus))).toMatchObject({
      platform: 'windows',
      storageRoot: 'D:/AI',
      backupCount: 1,
    });
    expect(parseAiDataDirectoryStatus(JSON.stringify({
      ...validStatus,
      directories: validStatus.directories.slice(0, 2),
    }))).toBeNull();
    expect(parseAiDataDirectoryStatus(JSON.stringify({
      ...validStatus,
      directories: [validStatus.directories[0], validStatus.directories[0], validStatus.directories[0]],
    }))).toBeNull();
  });

  it('validates operation payloads with nested status', () => {
    expect(parseAiDataDirectoryOperation(JSON.stringify({
      operation: 'migrate', success: true, status: validStatus,
    }))).toMatchObject({ operation: 'migrate', success: true, status: { backupCount: 1 } });
    expect(parseAiDataDirectoryOperation('{"operation":"remove","success":true}')).toBeNull();
  });

  it('sends migration commands as structured bridge messages', () => {
    aiDataStorageBridge.getStatus();
    aiDataStorageBridge.chooseRoot();
    aiDataStorageBridge.migrate('D:/AI Data');
    aiDataStorageBridge.cleanupBackups();

    expect(sendToJava).toHaveBeenNthCalledWith(1, 'get_ai_data_directory_status');
    expect(sendToJava).toHaveBeenNthCalledWith(2, 'choose_ai_data_directory_root');
    expect(sendToJava).toHaveBeenNthCalledWith(
      3, 'migrate_ai_data_directories', { targetRoot: 'D:/AI Data' },
    );
    expect(sendToJava).toHaveBeenNthCalledWith(4, 'cleanup_ai_data_directory_backups');
  });
});

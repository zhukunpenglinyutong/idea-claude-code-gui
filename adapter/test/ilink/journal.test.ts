import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InboxJournal } from '../../src/ilink/journal.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'adapter-journal-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const MESSAGE = {
  message_id: 'm1',
  seq: 1,
  from_user_id: 'user-1',
  message_type: 2,
  item_list: [{ type: 1, text_item: { text: 'hi' } }],
};

describe('InboxJournal', () => {
  it('appends once and dedups by account + message_id', async () => {
    const journal = new InboxJournal(dir);
    expect(await journal.appendInbox('bot-1', MESSAGE)).toBe('new');
    expect(await journal.appendInbox('bot-1', MESSAGE)).toBe('duplicate');
    expect(await journal.appendInbox('bot-2', MESSAGE)).toBe('new');
  });

  it('tracks PENDING/DISPATCHING and loads them for recovery', async () => {
    const journal = new InboxJournal(dir);
    await journal.appendInbox('bot-1', MESSAGE);
    await journal.setStatus('bot-1', 'm1', 'DISPATCHING');
    const pending = await journal.loadPending('bot-1');
    expect(pending.map((entry) => entry.message.message_id)).toEqual(['m1']);
    expect(pending[0]?.status).toBe('DISPATCHING');
    await journal.setStatus('bot-1', 'm1', 'DISPATCHED');
    expect(await journal.loadPending('bot-1')).toEqual([]);
  });

  it('persists the cursor atomically and defaults to empty', async () => {
    const journal = new InboxJournal(dir);
    expect(await journal.loadCursor('bot-1')).toBe('');
    await journal.saveCursor('bot-1', 'cursor-9');
    expect(await journal.loadCursor('bot-1')).toBe('cursor-9');
  });

  it('clear() removes inbox and cursor for one account only', async () => {
    const journal = new InboxJournal(dir);
    await journal.appendInbox('bot-1', MESSAGE);
    await journal.saveCursor('bot-1', 'c1');
    await journal.appendInbox('bot-2', MESSAGE);
    await journal.saveCursor('bot-2', 'c2');
    await journal.clear('bot-1');
    expect(await journal.loadCursor('bot-1')).toBe('');
    expect(await journal.loadPending('bot-1')).toEqual([]);
    expect(await journal.loadCursor('bot-2')).toBe('c2');
  });
});

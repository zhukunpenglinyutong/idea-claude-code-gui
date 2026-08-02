import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { InboundRawMessage } from './types.js';

export type LedgerStatus = 'PENDING' | 'DISPATCHING' | 'DISPATCHED' | 'SKIPPED';

export interface InboxEntry {
  readonly message: InboundRawMessage;
  readonly status: LedgerStatus;
  readonly savedAt: number;
}

/**
 * Durable inbound journal (audit §6):
 *
 * 1. append raw batch (accountId + message_id unique) + fsync-equivalent write;
 * 2. then atomically replace the cursor;
 * 3. command worker replays from the journal, never from network memory.
 *
 * `message_id` dedup absorbs server replays across crashes.
 */
export class InboxJournal {
  readonly #dir: string;

  constructor(dir: string) {
    this.#dir = dir;
  }

  #inboxDir(accountId: string): string {
    return path.join(this.#dir, 'inbox', accountId);
  }

  #cursorDir(): string {
    return path.join(this.#dir, 'cursor');
  }

  async appendInbox(accountId: string, message: InboundRawMessage): Promise<'new' | 'duplicate'> {
    const dir = this.#inboxDir(accountId);
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${message.message_id}.json`);
    try {
      await readFile(file, 'utf8');
      return 'duplicate';
    } catch {
      // New message: fall through.
    }
    const entry: InboxEntry = {
      message,
      status: 'PENDING',
      savedAt: Date.now(),
    };
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(entry), 'utf8');
    await rename(tmp, file);
    return 'new';
  }

  async setStatus(accountId: string, messageId: string, status: LedgerStatus): Promise<void> {
    const file = path.join(this.#inboxDir(accountId), `${messageId}.json`);
    const raw = await readFile(file, 'utf8');
    const entry = JSON.parse(raw) as InboxEntry;
    const updated: InboxEntry = { ...entry, status, savedAt: Date.now() };
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(updated), 'utf8');
    await rename(tmp, file);
  }

  async loadPending(accountId: string): Promise<InboxEntry[]> {
    const dir = this.#inboxDir(accountId);
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      return [];
    }
    const entries: InboxEntry[] = [];
    for (const name of files) {
      if (!name.endsWith('.json')) {
        continue;
      }
      try {
        const raw = await readFile(path.join(dir, name), 'utf8');
        const entry = JSON.parse(raw) as InboxEntry;
        if (entry.status === 'PENDING' || entry.status === 'DISPATCHING') {
          entries.push(entry);
        }
      } catch {
        // Skip corrupt entries; the cursor still advances.
      }
    }
    return entries.sort((a, b) => (a.message.seq ?? 0) - (b.message.seq ?? 0));
  }

  async saveCursor(accountId: string, cursor: string): Promise<void> {
    const dir = this.#cursorDir();
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${accountId}.txt`);
    const tmp = `${file}.tmp`;
    await writeFile(tmp, cursor, 'utf8');
    await rename(tmp, file);
  }

  async loadCursor(accountId: string): Promise<string> {
    try {
      return await readFile(path.join(this.#cursorDir(), `${accountId}.txt`), 'utf8');
    } catch {
      return '';
    }
  }

  async clear(accountId: string): Promise<void> {
    await rm(this.#inboxDir(accountId), { recursive: true, force: true });
    await rm(path.join(this.#cursorDir(), `${accountId}.txt`), { force: true });
  }
}

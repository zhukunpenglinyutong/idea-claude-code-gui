import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface BotCredentials {
  readonly botAccountId: string;
  readonly botToken: string;
  readonly baseUrl: string;
  readonly authorizedWeixinUserId?: string;
  readonly savedAt: number;
}

export interface ContextTokenRecord {
  readonly botAccountId: string;
  readonly fromUserId: string;
  readonly contextToken: string;
  readonly updatedAt: number;
}

/**
 * Atomic JSON file store for bot credentials and per-user context tokens.
 *
 * File-permissions hardening (Windows current-user ACL) is a deployment
 * concern documented in the transport audit; the adapter never writes tokens
 * into logs or reports.
 */
export class CredentialStore {
  readonly #dir: string;

  constructor(dir: string) {
    this.#dir = dir;
  }

  async #writeJson(file: string, value: unknown): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
    await rename(tmp, file);
  }

  async loadBotCredentials(): Promise<BotCredentials | undefined> {
    try {
      const raw = await readFile(path.join(this.#dir, 'bot-account.json'), 'utf8');
      return JSON.parse(raw) as BotCredentials;
    } catch {
      return undefined;
    }
  }

  async saveBotCredentials(credentials: BotCredentials): Promise<void> {
    await this.#writeJson(path.join(this.#dir, 'bot-account.json'), credentials);
  }

  async clearBotCredentials(): Promise<void> {
    await rm(path.join(this.#dir, 'bot-account.json'), { force: true });
  }

  async loadContextToken(botAccountId: string, fromUserId: string): Promise<string | undefined> {
    try {
      const raw = await readFile(path.join(this.#dir, 'context-tokens.json'), 'utf8');
      const map = JSON.parse(raw) as Record<string, ContextTokenRecord>;
      return map[`${botAccountId}:${fromUserId}`]?.contextToken;
    } catch {
      return undefined;
    }
  }

  async saveContextToken(record: ContextTokenRecord): Promise<void> {
    const file = path.join(this.#dir, 'context-tokens.json');
    let map: Record<string, ContextTokenRecord> = {};
    try {
      map = JSON.parse(await readFile(file, 'utf8')) as Record<string, ContextTokenRecord>;
    } catch {
      // First record.
    }
    map[`${record.botAccountId}:${record.fromUserId}`] = record;
    await this.#writeJson(file, map);
  }
}

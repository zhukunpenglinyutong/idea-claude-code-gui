import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CredentialStore } from '../../src/ilink/store.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'adapter-store-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe('CredentialStore', () => {
  it('returns undefined when no bot account exists', async () => {
    const store = new CredentialStore(dir);
    expect(await store.loadBotCredentials()).toBeUndefined();
  });

  it('persists and clears bot credentials', async () => {
    const store = new CredentialStore(dir);
    await store.saveBotCredentials({
      botAccountId: 'bot-1',
      botToken: 'secret',
      baseUrl: 'https://example.test',
      authorizedWeixinUserId: 'user-1',
      savedAt: 123,
    });
    const loaded = await store.loadBotCredentials();
    expect(loaded?.botAccountId).toBe('bot-1');
    expect(loaded?.botToken).toBe('secret');
    await store.clearBotCredentials();
    expect(await store.loadBotCredentials()).toBeUndefined();
  });

  it('stores per-user context tokens separately', async () => {
    const store = new CredentialStore(dir);
    await store.saveContextToken({
      botAccountId: 'bot-1',
      fromUserId: 'user-1',
      contextToken: 'ctx-a',
      updatedAt: 1,
    });
    await store.saveContextToken({
      botAccountId: 'bot-1',
      fromUserId: 'user-2',
      contextToken: 'ctx-b',
      updatedAt: 2,
    });
    expect(await store.loadContextToken('bot-1', 'user-1')).toBe('ctx-a');
    expect(await store.loadContextToken('bot-1', 'user-2')).toBe('ctx-b');
    expect(await store.loadContextToken('bot-1', 'user-3')).toBeUndefined();
  });
});

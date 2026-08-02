import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DiscoveryError,
  loadGatewayCredentials,
  parseDiscovery,
  readDiscovery,
  readToken,
} from '../src/discovery.js';

const VALID_DISCOVERY = {
  version: 1,
  host: '127.0.0.1',
  port: 49267,
  tokenFile: 'token.txt',
  pid: 12345,
};

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'adapter-discovery-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function write(name: string, content: string): Promise<string> {
  const file = path.join(dir, name);
  await writeFile(file, content, 'utf8');
  return file;
}

describe('parseDiscovery', () => {
  it('parses a valid discovery object', () => {
    expect(parseDiscovery(JSON.stringify(VALID_DISCOVERY), 'd.json')).toEqual(VALID_DISCOVERY);
  });

  it('rejects invalid JSON', () => {
    expect(() => parseDiscovery('{oops', 'd.json')).toThrow(DiscoveryError);
  });

  it('rejects a non-object payload', () => {
    expect(() => parseDiscovery('[1,2]', 'd.json')).toThrow(DiscoveryError);
  });

  it('rejects a non-loopback host', () => {
    expect(() =>
      parseDiscovery(JSON.stringify({ ...VALID_DISCOVERY, host: '0.0.0.0' }), 'd.json'),
    ).toThrow(/loopback/);
  });

  it('rejects an unsupported version', () => {
    expect(() =>
      parseDiscovery(JSON.stringify({ ...VALID_DISCOVERY, version: 2 }), 'd.json'),
    ).toThrow(/version/);
  });

  it('rejects an out-of-range port', () => {
    expect(() =>
      parseDiscovery(JSON.stringify({ ...VALID_DISCOVERY, port: 0 }), 'd.json'),
    ).toThrow(/port/);
  });

  it('rejects missing fields', () => {
    expect(() => parseDiscovery(JSON.stringify({ version: 1 }), 'd.json')).toThrow(/missing/);
  });
});

describe('readDiscovery / readToken / loadGatewayCredentials', () => {
  it('reads a discovery file from disk', async () => {
    const file = await write('d.json', JSON.stringify(VALID_DISCOVERY));
    expect(await readDiscovery(file)).toEqual(VALID_DISCOVERY);
  });

  it('raises DiscoveryError when the discovery file is missing', async () => {
    await expect(readDiscovery(path.join(dir, 'missing.json'))).rejects.toBeInstanceOf(DiscoveryError);
  });

  it('trims the token and accepts a trailing newline', async () => {
    const file = await write('token.txt', 'abc123\n');
    expect(await readToken(file)).toBe('abc123');
  });

  it('rejects an empty token', async () => {
    const file = await write('token.txt', '  \n');
    await expect(readToken(file)).rejects.toThrow(/empty/);
  });

  it('rejects an oversized token', async () => {
    const file = await write('token.txt', 'x'.repeat(257));
    await expect(readToken(file, 256)).rejects.toThrow(/exceeds/);
  });

  it('loads credentials using discovery.tokenFile', async () => {
    await write('d.json', JSON.stringify(VALID_DISCOVERY));
    await write('token.txt', 'tok123');
    const credentials = await loadGatewayCredentials(path.join(dir, 'd.json'));
    expect(credentials.discovery.port).toBe(49267);
    expect(credentials.token).toBe('tok123');
  });

  it('honours a token path override', async () => {
    await write('d.json', JSON.stringify(VALID_DISCOVERY));
    await write('other.txt', 'other-token');
    const credentials = await loadGatewayCredentials(path.join(dir, 'd.json'), path.join(dir, 'other.txt'));
    expect(credentials.token).toBe('other-token');
  });
});

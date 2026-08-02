import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Discovery file contract (see `REMOTE_GATEWAY_API_EVENT_CONTRACT_V1.md` §2).
 *
 * The discovery file never contains the token; it points at a separate token
 * file that is also owned by the CC GUI plugin.
 */
export interface GatewayDiscovery {
  readonly version: number;
  readonly host: string;
  readonly port: number;
  readonly tokenFile: string;
  readonly pid: number;
}

export interface GatewayCredentials {
  readonly discovery: GatewayDiscovery;
  readonly token: string;
}

export class DiscoveryError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DiscoveryError';
  }
}

/** Only loopback literals are valid; the Java core never binds 0.0.0.0. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

function requireObject(value: unknown, file: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DiscoveryError(`Discovery file is not a JSON object: ${file}`);
  }
  return value as Record<string, unknown>;
}

function requireString(obj: Record<string, unknown>, field: string, file: string): string {
  const value = obj[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new DiscoveryError(`Discovery field "${field}" is missing or empty: ${file}`);
  }
  return value;
}

function requireInt(obj: Record<string, unknown>, field: string, file: string): number {
  const value = obj[field];
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new DiscoveryError(`Discovery field "${field}" is not an integer: ${file}`);
  }
  return value;
}

export function parseDiscovery(raw: string, file: string): GatewayDiscovery {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new DiscoveryError(`Discovery file is not valid JSON: ${file}`, { cause });
  }
  const obj = requireObject(parsed, file);
  const version = requireInt(obj, 'version', file);
  if (version !== 1) {
    throw new DiscoveryError(`Unsupported discovery version ${version}: ${file}`);
  }
  const host = requireString(obj, 'host', file);
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new DiscoveryError(`Discovery host must be a loopback literal, got "${host}": ${file}`);
  }
  const port = requireInt(obj, 'port', file);
  if (port < 1 || port > 65_535) {
    throw new DiscoveryError(`Discovery port out of range ${port}: ${file}`);
  }
  return {
    version,
    host,
    port,
    tokenFile: requireString(obj, 'tokenFile', file),
    pid: requireInt(obj, 'pid', file),
  };
}

export async function readDiscovery(filePath: string): Promise<GatewayDiscovery> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (cause) {
    throw new DiscoveryError(`Cannot read discovery file: ${filePath}`, { cause });
  }
  return parseDiscovery(raw, filePath);
}

export async function readToken(filePath: string, maxLength = 256): Promise<string> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (cause) {
    throw new DiscoveryError(`Cannot read token file: ${filePath}`, { cause });
  }
  const token = raw.trim();
  if (token.length === 0) {
    throw new DiscoveryError(`Token file is empty: ${filePath}`);
  }
  if (token.length > maxLength) {
    throw new DiscoveryError(`Token file content exceeds ${maxLength} chars: ${filePath}`);
  }
  return token;
}

export async function loadGatewayCredentials(
  discoveryPath: string,
  tokenPathOverride?: string,
): Promise<GatewayCredentials> {
  const discovery = await readDiscovery(discoveryPath);
  const configured = tokenPathOverride ?? discovery.tokenFile;
  const tokenPath = path.isAbsolute(configured)
    ? configured
    : path.join(path.dirname(discoveryPath), configured);
  const token = await readToken(tokenPath);
  return { discovery, token };
}

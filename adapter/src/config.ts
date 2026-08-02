import os from 'node:os';
import path from 'node:path';

/**
 * Runtime configuration for the local adapter.
 *
 * Secrets (gateway token, api keys) never belong here: they are read from the
 * discovery/token files at runtime and kept in memory only.
 */
export interface AdapterConfig {
  /** Path to `remote-gateway.json` written by the CC GUI plugin. */
  readonly discoveryPath: string;
  /** How often the adapter re-verifies a bound target. */
  readonly pollIntervalMs: number;
  /** Per-request timeout for gateway HTTP calls. */
  readonly requestTimeoutMs: number;
  /** Hard cap for a token read from the token file (defensive bound). */
  readonly maxTokenLength: number;
  /** Gateway `/chat` message limit (mirrors `RemoteChatLimits`). */
  readonly maxMessageLength: number;
}

export const DEFAULT_POLL_INTERVAL_MS = 5_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_TOKEN_LENGTH = 256;

/** Mirrors `RemoteChatLimits.MAX_MESSAGE_LENGTH` in the Java core. */
export const GATEWAY_MAX_MESSAGE_LENGTH = 32_000;

export function defaultDiscoveryPath(): string {
  return path.join(os.homedir(), '.codemoss', 'remote-gateway.json');
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AdapterConfig {
  return {
    discoveryPath: env.CCGUI_ADAPTER_DISCOVERY ?? defaultDiscoveryPath(),
    pollIntervalMs: positiveInt(env.CCGUI_ADAPTER_POLL_MS, DEFAULT_POLL_INTERVAL_MS),
    requestTimeoutMs: positiveInt(env.CCGUI_ADAPTER_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS),
    maxTokenLength: positiveInt(env.CCGUI_ADAPTER_MAX_TOKEN_LENGTH, DEFAULT_MAX_TOKEN_LENGTH),
    maxMessageLength: GATEWAY_MAX_MESSAGE_LENGTH,
  };
}

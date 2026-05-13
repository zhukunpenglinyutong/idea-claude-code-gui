import { readFileSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { getClaudeDir, getRealHomeDir } from './path-utils.js';

const CACHE_TTL_MS = 300_000; // 5 minutes
const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CODEX_WHAM_URL = 'https://chatgpt.com/backend-api/wham/usage';

let claudeLastFetchTime = 0;
let claudeCachedResult = undefined;
let codexLastFetchTime = 0;
let codexCachedResult = undefined;

// ── Claude ───────────────────────────────────────────────────────────────────

function readClaudeAccessToken() {
  // setupApiKey() already resolved this from settings.json — reuse it
  if (process.env.ANTHROPIC_AUTH_TOKEN) {
    return process.env.ANTHROPIC_AUTH_TOKEN;
  }
  // CLI login mode: setupApiKey() clears the env var; token lives in macOS Keychain
  if (process.platform === 'darwin') {
    try {
      const raw = execFileSync(
        'security',
        ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
        { encoding: 'utf8', timeout: 3000 }
      ).trim();
      return JSON.parse(raw)?.claudeAiOauth?.accessToken || null;
    } catch { /* not in keychain or not macOS */ }
  }
  return null;
}

async function fetchClaudeLimits(accessToken) {
  try {
    const res = await fetch(CLAUDE_USAGE_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) return null;
    const data = await res.json();
    const fiveHour = data.five_hour;
    const sevenDay = data.seven_day;
    if (!fiveHour && !sevenDay) return null;
    return {
      provider: 'claude',
      fiveHour: fiveHour
        ? { percent: fiveHour.utilization ?? 0, resetsAt: fiveHour.resets_at ?? null }
        : null,
      sevenDay: sevenDay
        ? { percent: sevenDay.utilization ?? 0, resetsAt: sevenDay.resets_at ?? null }
        : null
    };
  } catch {
    return null;
  }
}

export function resetClaudeCache() {
  claudeLastFetchTime = 0;
  claudeCachedResult = undefined;
}

export async function emitClaudeLimitsIfDue() {
  const now = Date.now();
  if (now - claudeLastFetchTime < CACHE_TTL_MS && claudeCachedResult !== undefined) {
    if (claudeCachedResult) process.stdout.write('[LIMITS] ' + JSON.stringify(claudeCachedResult) + '\n');
    return;
  }
  try {
    const token = readClaudeAccessToken();
    if (!token) return;
    const result = await fetchClaudeLimits(token);
    claudeLastFetchTime = Date.now();
    claudeCachedResult = result;
    if (result) process.stdout.write('[LIMITS] ' + JSON.stringify(result) + '\n');
  } catch { /* never throw — best-effort telemetry */ }
}

// ── Codex ────────────────────────────────────────────────────────────────────

function readCodexAccessToken() {
  try {
    const authPath = join(getRealHomeDir(), '.codex', 'auth.json');
    if (!existsSync(authPath)) return null;
    const auth = JSON.parse(readFileSync(authPath, 'utf8'));
    if (auth?.auth_mode !== 'chatgpt') return null;
    return auth?.tokens?.access_token || null;
  } catch {
    return null;
  }
}

async function fetchCodexWhamLimits(accessToken) {
  try {
    const res = await fetch(CODEX_WHAM_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json'
      },
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) return null;
    const data = await res.json();
    const primary = data?.rate_limit?.primary_window;
    const secondary = data?.rate_limit?.secondary_window;
    if (!primary && !secondary) return null;
    const toWindow = (w) =>
      w?.used_percent != null
        ? {
            percent: w.used_percent,
            resetsAt: w.reset_at ? new Date(w.reset_at * 1000).toISOString() : null
          }
        : null;
    return {
      provider: 'codex',
      primaryWindow: toWindow(primary),
      secondaryWindow: toWindow(secondary)
    };
  } catch {
    return null;
  }
}

export function resetCodexCache() {
  codexLastFetchTime = 0;
  codexCachedResult = undefined;
}

export async function emitCodexLimitsIfDue() {
  const now = Date.now();
  if (now - codexLastFetchTime < CACHE_TTL_MS && codexCachedResult !== undefined) {
    if (codexCachedResult) process.stdout.write('[LIMITS] ' + JSON.stringify(codexCachedResult) + '\n');
    return;
  }
  try {
    const token = readCodexAccessToken();
    if (!token) return;
    const result = await fetchCodexWhamLimits(token);
    codexLastFetchTime = Date.now();
    codexCachedResult = result;
    if (result) process.stdout.write('[LIMITS] ' + JSON.stringify(result) + '\n');
  } catch { /* never throw — best-effort telemetry */ }
}

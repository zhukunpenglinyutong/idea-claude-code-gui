/**
 * Antigravity CLI (agy) helpers for the Gemini provider bridge.
 * Docs: https://antigravity.google/docs/cli/headless
 */

import { existsSync, accessSync, constants as fsConstants } from 'node:fs';
import { homedir } from 'node:os';
import { join, delimiter, dirname } from 'node:path';
import { execFile } from 'node:child_process';

import { resolveCliSpawn } from '../../utils/cli-path.js';

const DEFAULT_MAX_TOKENS = 200_000;

export function getAgyHome() {
  return process.env.AGY_HOME
    || process.env.ANTIGRAVITY_CLI_HOME
    || join(homedir(), '.gemini', 'antigravity-cli');
}

/**
 * Resolve agy binary.
 * ONLY the user-facing `agy` binary is allowed — never `agy.real`
 * (internal install artifact; forbidden).
 * Prefer AGY_PATH / AGY_CLI_PATH, then ~/.local/bin/agy,
 * ~/.gemini/antigravity-cli/bin/agy, ~/.antigravity/bin/agy, ~/bin/agy,
 * PATH (agy.exe / agy.cmd on Windows). The home dirs mirror the Java
 * detector's homeBinDirs AGY list — a dir one side probes and the other
 * does not means "available" status with failing sends (envKeysFor rule).
 */
function isForbiddenAgyName(path) {
  const norm = String(path || '').replace(/\\/g, '/');
  return /(^|\/)agy\.real$/i.test(norm);
}

function isExecutableBinary(path) {
  if (!path || isForbiddenAgyName(path) || !existsSync(path)) return false;
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveAgyBinary(platformId = process.platform) {
  // Explicit override:
  // - agy.real is FORBIDDEN: ignore and fall through to discover `agy`
  // - any other path: honor strictly (null if missing) so misconfig fails loudly
  // GEMINI_CLI_PATH deliberately NOT honored: it names Google's gemini CLI
  // in pre-existing setups, and spawning that with agy-only flags breaks.
  const explicit = (process.env.AGY_PATH || process.env.AGY_CLI_PATH || '').trim();
  if (explicit) {
    if (!isForbiddenAgyName(explicit)) {
      return isExecutableBinary(explicit) ? explicit : null;
    }
    // fall through — never invoke agy.real
  }

  // Windows installs land as agy.exe / agy.cmd (npm shim); elsewhere agy.
  // platformId is injectable for cross-platform unit tests (linux CI), same
  // convention as cli-path's forceWindows flag.
  const exeNames = platformId === 'win32' ? ['agy.exe', 'agy.cmd', 'agy'] : ['agy'];

  const candidates = [];
  const home = homedir();
  const agyHome = getAgyHome();
  for (const name of exeNames) {
    candidates.push(
      join(home, '.local', 'bin', name),
      join(agyHome, 'bin', name),
      // ~/.antigravity/bin is an install root the Java detector probes —
      // keep the lists in lockstep (see the docblock above).
      join(home, '.antigravity', 'bin', name),
      join(home, 'bin', name),
    );
  }
  // Unix-only install locations — on win32 these would probe the drive
  // root (C:\usr\local\bin\agy), where a stray file could win resolution.
  if (platformId !== 'win32') {
    candidates.push('/usr/local/bin/agy', '/opt/homebrew/bin/agy');
  }

  const pathEnv = process.env.PATH || '';
  const pathDirs = pathEnv.split(delimiter).filter(Boolean);
  // Name-major across directories (mirrors the home-candidate block above):
  // every dir is probed for agy.exe before any dir is probed for the .cmd
  // shim, so a stray npm shim in an earlier dir cannot shadow a real
  // executable further down the PATH.
  for (const name of exeNames) {
    for (const dir of pathDirs) {
      candidates.push(join(dir, name));
    }
  }

  const seen = new Set();
  for (const c of candidates) {
    if (!c || seen.has(c) || isForbiddenAgyName(c)) continue;
    seen.add(c);
    if (isExecutableBinary(c)) return c;
  }
  return null;
}

export function isAgyAvailable() {
  return !!resolveAgyBinary();
}

/**
 * Map unified plugin permission modes onto agy CLI flags.
 * Headless has no interactive Ask UI — default is soft-deny for Ask tools.
 *
 * @returns {{ skipPermissions: boolean, modeFlag: string, sandbox: boolean }}
 */
export function mapPermissionMode(permissionMode) {
  const m = String(permissionMode || 'default').trim().toLowerCase();
  const out = { skipPermissions: false, modeFlag: '', sandbox: false };

  if (m === 'plan') {
    out.modeFlag = 'plan';
  } else if (m === 'acceptedits' || m === 'accept-edits' || m === 'accept_edits') {
    out.modeFlag = 'accept-edits';
  }

  if (
    m === 'bypasspermissions'
    || m === 'bypass'
    || m === 'yolo'
    || m === 'dontask'
    || m === 'dont_ask'
    || m === 'auto'
    || m === 'always-proceed'
    || m === 'always_proceed'
  ) {
    out.skipPermissions = true;
  }

  if (m === 'sandbox') {
    out.sandbox = true;
  }

  return out;
}

/**
 * Build argv for one headless turn.
 */
export function buildAgyArgs(options = {}) {
  const {
    message = '',
    conversationId = '',
    model = '',
    effort = '',
    agent = '',
    permissionMode = '',
    continueRecent = false,
    printTimeout = '',
    addDirs = [],
  } = options;

  const perm = mapPermissionMode(permissionMode);
  const args = [
    '-p', String(message ?? ''),
    '--output-format', 'stream-json',
  ];

  if (conversationId && String(conversationId).trim()) {
    args.push('--conversation', String(conversationId).trim());
  } else if (continueRecent) {
    args.push('--continue');
  }

  if (model && String(model).trim()) {
    args.push('--model', String(model).trim());
  }
  if (effort && String(effort).trim()) {
    args.push('--effort', String(effort).trim().toLowerCase());
  }
  if (agent && String(agent).trim()) {
    args.push('--agent', String(agent).trim());
  }
  if (perm.modeFlag) {
    args.push('--mode', perm.modeFlag);
  }
  if (perm.skipPermissions) {
    args.push('--dangerously-skip-permissions');
  }
  if (perm.sandbox) {
    args.push('--sandbox');
  }
  if (printTimeout && String(printTimeout).trim()) {
    args.push('--print-timeout', String(printTimeout).trim());
  }

  if (Array.isArray(addDirs)) {
    for (const d of addDirs) {
      if (d && String(d).trim()) {
        args.push('--add-dir', String(d).trim());
      }
    }
  }

  return args;
}

export function buildAgyEnv(baseEnv = process.env) {
  const env = { ...(baseEnv || process.env) };
  env.CI = '1';
  env.NO_COLOR = '1';
  env.TERM = 'dumb';

  const resolved = resolveAgyBinary();
  if (!env.AGY_PATH && resolved) {
    env.AGY_PATH = resolved;
  }

  // Ensure PATH contains all standard binary directories (homebrew, local/bin, node, agy)
  const home = homedir();
  const agyHome = getAgyHome();
  const extraPaths = [
    join(home, '.local', 'bin'),
    join(agyHome, 'bin'),
    join(agyHome, 'bin', 'sys'),
    join(home, 'bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
  ];
  if (resolved) {
    extraPaths.push(dirname(resolved));
  }
  if (process.execPath) {
    extraPaths.push(dirname(process.execPath));
  }

  const currentPath = env.PATH || '';
  const currentDirs = new Set(currentPath.split(delimiter).filter(Boolean));
  for (const p of extraPaths) {
    if (p && !currentDirs.has(p) && existsSync(p)) {
      currentDirs.add(p);
    }
  }
  env.PATH = Array.from(currentDirs).join(delimiter);

  return env;
}

/** Effort suffixes baked into agy model slugs (longest first). */
export const AGY_EFFORT_SUFFIXES = ['thinking', 'max', 'xhigh', 'medium', 'high', 'low'];

/**
 * Parse one `agy models` line: "id   Human Label (Effort)".
 * @returns {{ id: string, label: string } | null}
 */
export function parseAgyModelLine(line) {
  const raw = String(line || '').trim();
  if (!raw || raw.startsWith('Usage') || raw.startsWith('CLI') || raw.startsWith('Flags')) {
    return null;
  }
  const m = raw.match(/^(\S+)\s+(.*)$/);
  if (m) {
    const id = m[1].trim();
    const label = m[2].trim() || id;
    if (!id) return null;
    return { id, label };
  }
  // id-only line
  if (/^\S+$/.test(raw)) {
    return { id: raw, label: raw };
  }
  return null;
}

/**
 * Parse full `agy models` stdout into [{ id, label }, ...].
 */
export function parseAgyModelsOutput(text) {
  const out = String(text || '');
  const entries = [];
  const seen = new Set();
  for (const line of out.split(/\r?\n/)) {
    const parsed = parseAgyModelLine(line);
    if (!parsed || seen.has(parsed.id)) continue;
    seen.add(parsed.id);
    entries.push(parsed);
  }
  return entries;
}

/**
 * Split an agy model slug into base family + effort suffix.
 * e.g. gemini-3.6-flash-high → { baseId, effort: 'high' }
 *      claude-opus-4-6-thinking → { baseId: 'claude-opus-4-6', effort: 'thinking' }
 *      claude-sonnet-4-6 → { baseId: 'claude-sonnet-4-6', effort: '' }
 */
export function splitAgyModelId(modelId) {
  const id = String(modelId || '').trim();
  if (!id) return { baseId: '', effort: '' };
  for (const effort of AGY_EFFORT_SUFFIXES) {
    const suffix = `-${effort}`;
    if (id.endsWith(suffix) && id.length > suffix.length) {
      return { baseId: id.slice(0, -suffix.length), effort };
    }
  }

  // Handle custom model variants like -latest, -preview, -exp, -20240229 for ANY model
  const match = id.match(/-(latest|preview|exp|\d{8})$/i);
  if (match && id.length > match[0].length) {
    return { baseId: id.slice(0, -match[0].length), effort: match[1] };
  }

  return { baseId: id, effort: '' };
}

/**
 * Compose full agy model slug from family base + effort.
 * If effort is empty, returns baseId. If baseId already ends with an effort, replaces it.
 */
export function composeAgyModelId(baseId, effort) {
  const base = String(baseId || '').trim();
  if (!base) return '';
  const { baseId: stripped } = splitAgyModelId(base);
  const family = stripped || base;
  const e = String(effort || '').trim().toLowerCase();
  if (!e) return family;
  return `${family}-${e}`;
}

/**
 * Resolve what to pass to agy spawn: full catalog slug preferred.
 *
 * agy rejects bare family ids that require effort:
 *   --model gemini-3.6-flash  → needs --effort or full slug …-medium
 * and rejects --effort on bare single-slug models:
 *   --model claude-sonnet-4-6 --effort medium  → invalid
 *
 * Strategy: always prefer a full model id with effort in the slug. Never rely
 * on a separate --effort flag for spawn (caller should pass effort: '').
 * Fast path — no `agy models` spawn (agy-runner passes the cached families
 * from getCachedAgyModelFamilies so bare ids resolve to offered tiers).
 *
 * @param {string} model family id or full slug
 * @param {string} [effort] preferred effort when model is a family base
 * @param {Array<{id:string,label?:string,defaultModelId?:string,defaultEffort?:string,efforts?:Array}>} [catalogOrFamilies]
 * @returns {{ model: string, effort: string }}
 */
export function resolveAgySpawnModel(model, effort = '', catalogOrFamilies = null) {
  const raw = String(model || '').trim();
  if (!raw) {
    return { model: '', effort: '' };
  }

  const { baseId, effort: embedded } = splitAgyModelId(raw);
  // Already a full effort slug (gemini-3.6-flash-medium, claude-opus-4-6-thinking)
  if (embedded) {
    return { model: raw, effort: '' };
  }

  const wantEffort = String(effort || '').trim().toLowerCase();

  // Optional catalog/families for precise defaultModelId
  if (Array.isArray(catalogOrFamilies) && catalogOrFamilies.length > 0) {
    const looksLikeFamilies = catalogOrFamilies.some(
      (e) => e && (Array.isArray(e.efforts) || e.defaultModelId),
    );
    const families = looksLikeFamilies
      ? catalogOrFamilies
      : groupAgyModelFamilies(catalogOrFamilies);
    const fam = families.find((f) => f && (f.id === raw || f.id === baseId));
    if (fam) {
      const match =
        (wantEffort && fam.efforts?.find((e) => e.id === wantEffort))
        || fam.efforts?.find((e) => e.id === fam.defaultEffort)
        || fam.efforts?.find((e) => e.id === 'medium')
        || fam.efforts?.find((e) => e.id === 'high')
        || fam.efforts?.[0];
      if (match?.modelId) {
        return { model: match.modelId, effort: '' };
      }
      if (fam.defaultModelId) {
        return { model: fam.defaultModelId, effort: '' };
      }
    }
    // Exact flat catalog id (e.g. claude-sonnet-4-6)
    const exact = catalogOrFamilies.find((e) => e && e.id === raw);
    if (exact?.id) {
      return { model: exact.id, effort: '' };
    }
  }

  const isGeminiOrGpt = /^gemini-/i.test(raw) || /^gpt-oss-/i.test(raw);
  const isClaude = /opus-|sonnet-|haiku-|^claude-/i.test(raw);
  const isCustomSuffix = wantEffort === 'thinking' || /^(latest|preview|exp|\d{8})$/i.test(wantEffort);

  if (wantEffort && (isGeminiOrGpt || (isClaude && isCustomSuffix))) {
    return { model: composeAgyModelId(raw, wantEffort), effort: '' };
  }

  // Gemini flash/pro bare family always needs a default effort tier. No
  // catalog in reach — fall back to -high: every gemini family ships a
  // -high tier, while some (e.g. gemini-3.1-pro) have no -medium at all
  // and reject the invented slug outright.
  if (/^gemini-/i.test(raw)) {
    return { model: `${raw}-high`, effort: '' };
  }

  // gpt-oss bare family → medium slug
  if (/^gpt-oss-/i.test(raw)) {
    return { model: `${raw}-medium`, effort: '' };
  }

  // Bare single-slug models (claude-sonnet-4-6): pass as-is — never attach --effort
  // or invent -medium (agy rejects both for these ids).
  return { model: raw, effort: '' };
}

/**
 * Strip trailing " (High|Medium|Low|Thinking)" style effort from display labels.
 */
export function stripEffortFromLabel(label) {
  const s = String(label || '').trim();
  if (!s) return s;
  return s
    .replace(/\s*\((?:Very\s+)?(?:High|Medium|Low|XHigh|Max|Thinking)\)\s*$/i, '')
    .trim() || s;
}

/**
 * Group flat agy catalog into UI families with subordinate effort options.
 * @param {Array<{id:string,label:string}>} entries
 * @returns {Array<{id:string,label:string,description:string,efforts:Array<{id:string,label:string,modelId:string}>,defaultEffort:string,defaultModelId:string}>}
 */
export function groupAgyModelFamilies(entries) {
  const list = Array.isArray(entries) ? entries : [];
  /** @type {Map<string, { id: string, label: string, efforts: Array<{id:string,label:string,modelId:string}>, order: number }>} */
  const families = new Map();
  let order = 0;

  for (const entry of list) {
    if (!entry || !entry.id) continue;
    const { baseId, effort } = splitAgyModelId(entry.id);
    const familyId = baseId || entry.id;
    let fam = families.get(familyId);
    if (!fam) {
      fam = {
        id: familyId,
        label: stripEffortFromLabel(entry.label) || familyId,
        efforts: [],
        order: order++,
      };
      families.set(familyId, fam);
    } else if (effort) {
      // Prefer non-effort label when we already have a bare entry, else strip
      const stripped = stripEffortFromLabel(entry.label);
      if (stripped && stripped.length < fam.label.length) {
        fam.label = stripped;
      }
    } else if (entry.label) {
      fam.label = stripEffortFromLabel(entry.label) || fam.label;
    }

    if (effort) {
      if (!fam.efforts.some((e) => e.id === effort)) {
        fam.efforts.push({
          id: effort,
          label: effortLabel(effort),
          modelId: entry.id,
        });
      }
    } else {
      // Bare slug (no effort suffix) — treat as sole "default" option
      if (!fam.efforts.some((e) => e.modelId === entry.id)) {
        fam.efforts.push({
          id: '',
          label: 'Default',
          modelId: entry.id,
        });
      }
    }
  }

  const EFFORT_RANK = { low: 1, medium: 2, high: 3, xhigh: 4, max: 5, thinking: 6, '': 0 };
  const result = [];
  for (const fam of [...families.values()].sort((a, b) => a.order - b.order)) {
    fam.efforts.sort((a, b) => (EFFORT_RANK[a.id] ?? 50) - (EFFORT_RANK[b.id] ?? 50));
    const defaultEffort =
      fam.efforts.find((e) => e.id === 'medium')?.id
      ?? fam.efforts.find((e) => e.id === 'high')?.id
      ?? fam.efforts.find((e) => e.id === 'thinking')?.id
      ?? fam.efforts[0]?.id
      ?? '';
    const defaultModelId =
      fam.efforts.find((e) => e.id === defaultEffort)?.modelId
      ?? fam.efforts[0]?.modelId
      ?? fam.id;
    result.push({
      id: fam.id,
      label: fam.label,
      description: fam.efforts.length > 1
        ? `${fam.efforts.length} effort levels`
        : (fam.efforts[0]?.label || ''),
      efforts: fam.efforts,
      defaultEffort,
      defaultModelId,
    });
  }
  return result;
}

function effortLabel(effort) {
  const e = String(effort || '').toLowerCase();
  if (e === 'low') return 'Low';
  if (e === 'medium') return 'Medium';
  if (e === 'high') return 'High';
  if (e === 'xhigh') return 'XHigh';
  if (e === 'max') return 'Max';
  if (e === 'thinking') return 'Thinking';
  if (!e) return 'Default';
  return e.charAt(0).toUpperCase() + e.slice(1);
}

/**
 * List models via `agy models` (id + human label per line).
 * Async on purpose: this runs inside the shared daemon, where a sync spawn
 * would block the event loop (heartbeats + all providers) for up to 15s.
 * @returns {Promise<Array<{id:string,label:string}>>}
 */
export async function listAgyModels() {
  const bin = resolveAgyBinary();
  if (!bin) return [];
  try {
    // Route through the shared cmd.exe wrapper so a discovered Windows
    // `agy.cmd` shim actually runs — a direct execFile of a .cmd throws
    // EINVAL on patched Node (CVE-2024-27980). Posix: passthrough.
    const invocation = resolveCliSpawn(bin, ['models'], {
      encoding: 'utf8',
      timeout: 15_000,
      env: buildAgyEnv(),
      maxBuffer: 4 * 1024 * 1024,
    });
    // agy (≥1.1.x) waits for stdin EOF on non-interactive subcommands before
    // printing; execFile's default stdin pipe never closes (a custom stdio
    // option is silently ignored), so the spawn would sit until the 15s
    // timeout and return []. End the pipe explicitly — the same stdin-closed
    // discipline as agy-runner's spawn stdio:['ignore','pipe','pipe'].
    const { stdout } = await new Promise((resolve, reject) => {
      const child = execFile(
        invocation.file,
        invocation.args,
        invocation.options,
        (err, out) => (err ? reject(err) : resolve({ stdout: out })),
      );
      child.stdin?.end?.();
    });
    return parseAgyModelsOutput(String(stdout || ''));
  } catch {
    return [];
  }
}

// Last families catalog seen by this process (populated by the listModels
// channel command). The send path reuses it to resolve bare family ids
// against real effort tiers instead of re-spawning `agy models`
// (spawnSync — blocks the daemon event loop) on every turn.
let cachedAgyModelFamilies = null;

/**
 * Seed the catalog cache from an externally built families list.
 * @param {Array<object>|null} families grouped families (groupAgyModelFamilies
 *   shape); null/empty resets the cache (test-isolation seam — no production
 *   caller passes null; the send path warms via buildAgyModelsCatalog)
 */
export function cacheAgyModelFamilies(families) {
  cachedAgyModelFamilies = Array.isArray(families) && families.length > 0
    ? families
    : null;
}

/**
 * @returns {Array<object>|null} cached families, or null when no catalog
 * has been fetched in this process yet.
 */
export function getCachedAgyModelFamilies() {
  return cachedAgyModelFamilies;
}

/**
 * Full catalog for the plugin UI: flat models + grouped families.
 * Also refreshes the families cache above for the send path.
 * @returns {Promise<{models: Array<{id:string,label:string}>, families: Array<object>, binary: string}>}
 */
export async function buildAgyModelsCatalog() {
  const models = await listAgyModels();
  const families = groupAgyModelFamilies(models);
  cachedAgyModelFamilies = families.length > 0 ? families : cachedAgyModelFamilies;
  return {
    models,
    families,
    binary: resolveAgyBinary() || '',
  };
}

/**
 * Warm the families cache for a send turn when needed.
 *
 * The channel-manager is one-shot — one process per command — so the cache
 * seeded by a listModels process is never visible to a later send process.
 * Without this warm, `resolveAgySpawnModel` sees a null catalog in every
 * production send and bare family ids fall back to the guessed `-high`
 * slug instead of the family's real offered tiers.
 *
 * No-op for empty models (no --model flag to resolve), full effort slugs
 * (nothing to look up) and when the cache is already warm; a failed
 * `agy models` probe leaves the guess fallback.
 * @param {string} model family id or full slug about to be spawned
 */
export async function warmAgyModelCatalogForModel(model) {
  const { baseId, effort } = splitAgyModelId(String(model || ''));
  if (!baseId || effort) return; // no model, or a full slug — the catalog adds nothing
  if (getCachedAgyModelFamilies()) return;
  try {
    await buildAgyModelsCatalog();
  } catch {
    // probe failed — callers keep the safe -high fallback
  }
}

export function normalizeUsageToSnakeCase(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const input = num(usage.input_tokens ?? usage.inputTokens);
  const output = num(usage.output_tokens ?? usage.outputTokens);
  const thinking = num(usage.thinking_tokens ?? usage.thinkingTokens);
  // agy uses cache_read_tokens; Claude/webview status bar expects cache_read_input_tokens
  const cacheRead = num(
    usage.cache_read_input_tokens
    ?? usage.cacheReadInputTokens
    ?? usage.cache_read_tokens
    ?? usage.cacheReadTokens
    ?? usage.cached_input_tokens
    ?? usage.cachedInputTokens,
  );
  const cacheCreation = num(
    usage.cache_creation_input_tokens
    ?? usage.cacheCreationInputTokens
    ?? usage.cache_write_tokens
    ?? usage.cacheWriteTokens,
  );
  const total = num(usage.total_tokens ?? usage.totalTokens)
    || (input + output + thinking);
  if (input === 0 && output === 0 && thinking === 0 && total === 0 && cacheRead === 0 && cacheCreation === 0) {
    return null;
  }
  // Context occupancy for the status ring is input + cache (not total/output).
  // Emit both agy and Claude field names so Java TokenUsageUtils can read either.
  return {
    input_tokens: input,
    output_tokens: output,
    thinking_tokens: thinking,
    cache_read_tokens: cacheRead,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheCreation,
    total_tokens: total,
  };
}

/**
 * Context-window occupancy (status bar / context %).
 * Prefer input (+ cache); never use total_tokens (includes output) as context fill.
 */
export function extractAgyContextTokens(usage) {
  const u = usage && typeof usage === 'object' && !Array.isArray(usage)
    ? usage
    : null;
  if (!u) return 0;
  const normalized = normalizeUsageToSnakeCase(u) || u;
  const input = num(normalized.input_tokens ?? normalized.inputTokens);
  const cacheRead = num(
    normalized.cache_read_input_tokens
    ?? normalized.cache_read_tokens
    ?? normalized.cacheReadTokens,
  );
  const cacheCreation = num(
    normalized.cache_creation_input_tokens
    ?? normalized.cacheCreationInputTokens,
  );
  const total = num(normalized.total_tokens ?? normalized.totalTokens);
  const sum = input + cacheRead + cacheCreation;
  if (total > 0 && sum > total) {
    return Math.max(input, cacheRead + cacheCreation);
  }
  return sum;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function buildGeminiContextUsagePayload({ usedTokens = 0, maxTokens = DEFAULT_MAX_TOKENS, model = '' } = {}) {
  const used = Math.max(0, Number(usedTokens) || 0);
  const max = Math.max(1, Number(maxTokens) || DEFAULT_MAX_TOKENS);
  const percentage = Math.min(100, Math.round((used / max) * 1000) / 10);
  return {
    success: true,
    data: {
      usedTokens: used,
      maxTokens: max,
      percentage,
      model: model || '',
      source: 'gemini-bridge',
    },
  };
}

export function buildErrorPayload(error, extras = {}) {
  const message = error?.message || String(error || 'Unknown error');
  return {
    success: false,
    error: message,
    ...extras,
  };
}

export { DEFAULT_MAX_TOKENS };

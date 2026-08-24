import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { join, delimiter } from 'path';
import { tmpdir } from 'os';
import {
  buildAgyArgs,
  mapPermissionMode,
  normalizeUsageToSnakeCase,
  extractAgyContextTokens,
  buildGeminiContextUsagePayload,
  buildErrorPayload,
  buildAgyEnv,
  resolveAgyBinary,
  parseAgyModelLine,
  parseAgyModelsOutput,
  splitAgyModelId,
  composeAgyModelId,
  resolveAgySpawnModel,
  groupAgyModelFamilies,
  stripEffortFromLabel,
  warmAgyModelCatalogForModel,
  cacheAgyModelFamilies,
  getCachedAgyModelFamilies,
  listAgyModels,
} from './agy-utils.js';

test('resolveAgyBinary honors explicit AGY_PATH without fallback', () => {
  const prev = process.env.AGY_PATH;
  const prevG = process.env.GEMINI_CLI_PATH;
  const prevA = process.env.AGY_CLI_PATH;
  process.env.AGY_PATH = '/nonexistent/agy-binary-xyz';
  process.env.GEMINI_CLI_PATH = '';
  process.env.AGY_CLI_PATH = '';
  try {
    assert.equal(resolveAgyBinary(), null);
  } finally {
    if (prev === undefined) delete process.env.AGY_PATH;
    else process.env.AGY_PATH = prev;
    if (prevG === undefined) delete process.env.GEMINI_CLI_PATH;
    else process.env.GEMINI_CLI_PATH = prevG;
    if (prevA === undefined) delete process.env.AGY_CLI_PATH;
    else process.env.AGY_CLI_PATH = prevA;
  }
});

test('resolveAgyBinary never returns agy.real even if AGY_PATH points at it', () => {
  const prev = process.env.AGY_PATH;
  const prevG = process.env.GEMINI_CLI_PATH;
  const prevA = process.env.AGY_CLI_PATH;
  process.env.AGY_PATH = '/Users/nobody/.local/bin/agy.real';
  process.env.GEMINI_CLI_PATH = '';
  process.env.AGY_CLI_PATH = '';
  try {
    const resolved = resolveAgyBinary();
    if (resolved) {
      assert.ok(!/agy\.real$/i.test(resolved), `must not resolve agy.real, got ${resolved}`);
    }
  } finally {
    if (prev === undefined) delete process.env.AGY_PATH;
    else process.env.AGY_PATH = prev;
    if (prevG === undefined) delete process.env.GEMINI_CLI_PATH;
    else process.env.GEMINI_CLI_PATH = prevG;
    if (prevA === undefined) delete process.env.AGY_CLI_PATH;
    else process.env.AGY_CLI_PATH = prevA;
  }
});

test('resolveAgyBinary ignores GEMINI_CLI_PATH (Google gemini CLI)', () => {
  const prev = process.env.AGY_PATH;
  const prevG = process.env.GEMINI_CLI_PATH;
  const prevA = process.env.AGY_CLI_PATH;
  // An existing executable — must NOT be picked just because the var is set:
  // in pre-existing setups it names Google's gemini CLI, which rejects agy flags.
  process.env.GEMINI_CLI_PATH = process.execPath;
  delete process.env.AGY_PATH;
  delete process.env.AGY_CLI_PATH;
  try {
    assert.notEqual(resolveAgyBinary(), process.execPath);
  } finally {
    if (prev === undefined) delete process.env.AGY_PATH;
    else process.env.AGY_PATH = prev;
    if (prevG === undefined) delete process.env.GEMINI_CLI_PATH;
    else process.env.GEMINI_CLI_PATH = prevG;
    if (prevA === undefined) delete process.env.AGY_CLI_PATH;
    else process.env.AGY_CLI_PATH = prevA;
  }
});

test('mapPermissionMode default does not skip permissions', () => {
  const m = mapPermissionMode('default');
  assert.equal(m.skipPermissions, false);
  assert.equal(m.modeFlag, '');
  assert.equal(m.sandbox, false);
});

test('mapPermissionMode bypass/yolo/dontAsk/auto skips permissions', () => {
  assert.equal(mapPermissionMode('bypassPermissions').skipPermissions, true);
  assert.equal(mapPermissionMode('bypass').skipPermissions, true);
  assert.equal(mapPermissionMode('yolo').skipPermissions, true);
  assert.equal(mapPermissionMode('dontAsk').skipPermissions, true);
  assert.equal(mapPermissionMode('dont_ask').skipPermissions, true);
  assert.equal(mapPermissionMode('auto').skipPermissions, true);
  assert.equal(mapPermissionMode('always-proceed').skipPermissions, true);
});

test('mapPermissionMode plan and accept-edits set mode flags', () => {
  assert.equal(mapPermissionMode('plan').modeFlag, 'plan');
  assert.equal(mapPermissionMode('acceptEdits').modeFlag, 'accept-edits');
  assert.equal(mapPermissionMode('accept-edits').modeFlag, 'accept-edits');
  assert.equal(mapPermissionMode('accept_edits').modeFlag, 'accept-edits');
});

test('mapPermissionMode sandbox sets sandbox flag', () => {
  assert.equal(mapPermissionMode('sandbox').sandbox, true);
  assert.equal(mapPermissionMode('sandbox').skipPermissions, false);
});

test('buildAgyArgs includes stream-json and conversation resume', () => {
  const args = buildAgyArgs({
    message: 'hello',
    conversationId: 'cid-1',
    model: 'gemini-3.5-flash-medium',
    effort: 'high',
    permissionMode: 'bypassPermissions',
  });
  assert.ok(args.includes('-p'));
  assert.ok(args.includes('hello'));
  assert.ok(args.includes('--output-format'));
  assert.ok(args.includes('stream-json'));
  assert.ok(args.includes('--conversation'));
  assert.ok(args.includes('cid-1'));
  assert.ok(args.includes('--model'));
  assert.ok(args.includes('gemini-3.5-flash-medium'));
  assert.ok(args.includes('--effort'));
  assert.ok(args.includes('high'));
  assert.ok(args.includes('--dangerously-skip-permissions'));
  assert.ok(!args.includes('--continue'));
});

test('buildAgyArgs uses --continue when no conversation id', () => {
  const args = buildAgyArgs({
    message: 'hi',
    continueRecent: true,
  });
  assert.ok(args.includes('--continue'));
  assert.ok(!args.includes('--conversation'));
});

test('buildAgyArgs plan mode and add-dir and agent and print-timeout', () => {
  const args = buildAgyArgs({
    message: 'x',
    permissionMode: 'plan',
    agent: 'explorer',
    printTimeout: '30s',
    addDirs: ['/tmp/a', '', '/tmp/b'],
  });
  assert.ok(args.includes('--mode'));
  assert.ok(args.includes('plan'));
  assert.ok(args.includes('--agent'));
  assert.ok(args.includes('explorer'));
  assert.ok(args.includes('--print-timeout'));
  assert.ok(args.includes('30s'));
  assert.ok(args.includes('--add-dir'));
  assert.ok(args.includes('/tmp/a'));
  assert.ok(args.includes('/tmp/b'));
});

test('buildAgyArgs effort is lowercased', () => {
  const args = buildAgyArgs({ message: 'm', effort: 'HIGH' });
  const i = args.indexOf('--effort');
  assert.ok(i >= 0);
  assert.equal(args[i + 1], 'high');
});

test('normalizeUsageToSnakeCase maps fields and camelCase', () => {
  const u = normalizeUsageToSnakeCase({
    input_tokens: 10,
    output_tokens: 5,
    thinking_tokens: 2,
    cache_read_tokens: 3,
    total_tokens: 17,
  });
  assert.deepEqual(u, {
    input_tokens: 10,
    output_tokens: 5,
    thinking_tokens: 2,
    cache_read_tokens: 3,
    cache_read_input_tokens: 3,
    cache_creation_input_tokens: 0,
    total_tokens: 17,
  });

  const camel = normalizeUsageToSnakeCase({
    inputTokens: 1,
    outputTokens: 2,
    thinkingTokens: 3,
  });
  assert.equal(camel.input_tokens, 1);
  assert.equal(camel.output_tokens, 2);
  assert.equal(camel.thinking_tokens, 3);
  assert.equal(camel.total_tokens, 6);
});

test('normalizeUsageToSnakeCase returns null for empty usage', () => {
  assert.equal(normalizeUsageToSnakeCase(null), null);
  assert.equal(normalizeUsageToSnakeCase({}), null);
  assert.equal(normalizeUsageToSnakeCase({ input_tokens: 0, output_tokens: 0 }), null);
});

test('extractAgyContextTokens uses input+cache not total/output', () => {
  assert.equal(extractAgyContextTokens({
    input_tokens: 27793,
    output_tokens: 18,
    total_tokens: 27811,
  }), 27793);
  assert.equal(extractAgyContextTokens({
    input_tokens: 100,
    cache_read_tokens: 50,
    cache_creation_input_tokens: 25,
    output_tokens: 999,
    total_tokens: 1174,
  }), 175);
  assert.equal(extractAgyContextTokens(null), 0);
});

test('resolveAgySpawnModel upgrades bare gemini family to effort slug', () => {
  // No catalog in reach: fall back to -high (every gemini family ships it;
  // some, like gemini-3.1-pro, have no -medium at all).
  assert.deepEqual(resolveAgySpawnModel('gemini-3.6-flash', ''), {
    model: 'gemini-3.6-flash-high',
    effort: '',
  });
  assert.deepEqual(resolveAgySpawnModel('gemini-3.6-flash', 'high'), {
    model: 'gemini-3.6-flash-high',
    effort: '',
  });
  assert.deepEqual(resolveAgySpawnModel('gemini-3.6-flash-low', 'high'), {
    model: 'gemini-3.6-flash-low',
    effort: '',
  });
  // Bare Claude models must never get a fake -medium suffix or --effort
  assert.deepEqual(resolveAgySpawnModel('claude-sonnet-4-6', 'medium'), {
    model: 'claude-sonnet-4-6',
    effort: '',
  });
  assert.deepEqual(resolveAgySpawnModel('claude-sonnet-4-6', ''), {
    model: 'claude-sonnet-4-6',
    effort: '',
  });
  assert.deepEqual(resolveAgySpawnModel('claude-opus-4-6', 'thinking'), {
    model: 'claude-opus-4-6-thinking',
    effort: '',
  });
});

test('resolveAgySpawnModel prefers cached catalog families over suffix guessing', () => {
  // Families shape produced by groupAgyModelFamilies (cached from listModels).
  const families = [
    {
      id: 'gemini-3.1-pro',
      defaultEffort: 'high',
      defaultModelId: 'gemini-3.1-pro-high',
      efforts: [
        { id: 'low', label: 'Low', modelId: 'gemini-3.1-pro-low' },
        { id: 'high', label: 'High', modelId: 'gemini-3.1-pro-high' },
      ],
    },
  ];
  // Requested effort not offered → family default wins; a bare -medium guess
  // would invent a slug agy rejects (family has no medium tier).
  assert.deepEqual(resolveAgySpawnModel('gemini-3.1-pro', 'medium', families), {
    model: 'gemini-3.1-pro-high',
    effort: '',
  });
  assert.deepEqual(resolveAgySpawnModel('gemini-3.1-pro', 'low', families), {
    model: 'gemini-3.1-pro-low',
    effort: '',
  });
  assert.deepEqual(resolveAgySpawnModel('gemini-3.1-pro', '', families), {
    model: 'gemini-3.1-pro-high',
    effort: '',
  });
});

test('agy model families cache round-trips through agy-runner resolution', async () => {
  const { cacheAgyModelFamilies, getCachedAgyModelFamilies } = await import('./agy-utils.js');
  assert.equal(getCachedAgyModelFamilies(), null, 'cache starts empty');
  cacheAgyModelFamilies(null);
  assert.equal(getCachedAgyModelFamilies(), null, 'null leaves an empty cache empty');
  const families = [
    { id: 'gemini-3.1-pro', defaultEffort: 'high', defaultModelId: 'gemini-3.1-pro-high',
      efforts: [{ id: 'high', label: 'High', modelId: 'gemini-3.1-pro-high' }] },
  ];
  cacheAgyModelFamilies(families);
  assert.deepEqual(getCachedAgyModelFamilies(), families);
  assert.deepEqual(resolveAgySpawnModel('gemini-3.1-pro', '', getCachedAgyModelFamilies()), {
    model: 'gemini-3.1-pro-high',
    effort: '',
  });
  cacheAgyModelFamilies(null);
  assert.equal(getCachedAgyModelFamilies(), null, 'null resets the cache (test-isolation seam)');
});

test('buildGeminiContextUsagePayload percentage', () => {
  const p = buildGeminiContextUsagePayload({ usedTokens: 50, maxTokens: 200, model: 'm' });
  assert.equal(p.success, true);
  assert.equal(p.data.percentage, 25);
  assert.equal(p.data.model, 'm');
  assert.equal(p.data.source, 'gemini-bridge');
});

test('buildGeminiContextUsagePayload clamps percentage at 100', () => {
  const p = buildGeminiContextUsagePayload({ usedTokens: 9999, maxTokens: 100 });
  assert.equal(p.data.percentage, 100);
});

test('buildErrorPayload extracts message', () => {
  const p = buildErrorPayload(new Error('boom'), { code: 1 });
  assert.equal(p.success, false);
  assert.equal(p.error, 'boom');
  assert.equal(p.code, 1);
});

test('buildAgyEnv sets non-interactive defaults', () => {
  const env = buildAgyEnv({ PATH: '/bin', HOME: '/tmp' });
  assert.equal(env.CI, '1');
  assert.equal(env.NO_COLOR, '1');
  assert.equal(env.TERM, 'dumb');
});

test('parseAgyModelLine reads id and label', () => {
  const p = parseAgyModelLine('gemini-3.6-flash-high     Gemini 3.6 Flash (High)');
  assert.deepEqual(p, { id: 'gemini-3.6-flash-high', label: 'Gemini 3.6 Flash (High)' });
  assert.equal(parseAgyModelLine('Usage of agy'), null);
  assert.deepEqual(parseAgyModelLine('claude-sonnet-4-6'), {
    id: 'claude-sonnet-4-6',
    label: 'claude-sonnet-4-6',
  });
});

test('groupAgyModelFamilies nests effort under family base', () => {
  const sample = `
gemini-3.6-flash-high     Gemini 3.6 Flash (High)
gemini-3.6-flash-medium   Gemini 3.6 Flash (Medium)
gemini-3.6-flash-low      Gemini 3.6 Flash (Low)
gemini-3.5-flash-high     Gemini 3.5 Flash (High)
gemini-3.5-flash-medium   Gemini 3.5 Flash (Medium)
gemini-3.5-flash-low      Gemini 3.5 Flash (Low)
gemini-3.1-pro-high       Gemini 3.1 Pro (High)
gemini-3.1-pro-low        Gemini 3.1 Pro (Low)
claude-sonnet-4-6         Claude Sonnet 4.6 (Thinking)
claude-opus-4-6-thinking  Claude Opus 4.6 (Thinking)
gpt-oss-120b-medium       GPT-OSS 120B (Medium)
`.trim();
  const entries = parseAgyModelsOutput(sample);
  const families = groupAgyModelFamilies(entries);

  // Gemini 3.6 Flash
  const flash36 = families.find((f) => f.id === 'gemini-3.6-flash');
  assert.ok(flash36);
  assert.equal(flash36.label, 'Gemini 3.6 Flash');
  assert.deepEqual(flash36.efforts.map((e) => e.id), ['low', 'medium', 'high']);
  assert.equal(flash36.defaultEffort, 'medium');

  // Gemini 3.5 Flash
  const flash35 = families.find((f) => f.id === 'gemini-3.5-flash');
  assert.ok(flash35);
  assert.equal(flash35.label, 'Gemini 3.5 Flash');
  assert.deepEqual(flash35.efforts.map((e) => e.id), ['low', 'medium', 'high']);
  assert.equal(flash35.defaultEffort, 'medium');

  // Gemini 3.1 Pro
  const pro31 = families.find((f) => f.id === 'gemini-3.1-pro');
  assert.ok(pro31);
  assert.equal(pro31.label, 'Gemini 3.1 Pro');
  assert.deepEqual(pro31.efforts.map((e) => e.id), ['low', 'high']);
  assert.equal(pro31.defaultEffort, 'high'); // high since no medium

  // Claude Sonnet 4.6
  const sonnet = families.find((f) => f.id === 'claude-sonnet-4-6');
  assert.ok(sonnet);
  assert.equal(sonnet.label, 'Claude Sonnet 4.6');
  assert.equal(sonnet.efforts.length, 1);
  assert.equal(sonnet.efforts[0].id, '');
  assert.equal(sonnet.efforts[0].modelId, 'claude-sonnet-4-6');
  assert.equal(sonnet.defaultEffort, '');

  // Claude Opus 4.6
  const opus = families.find((f) => f.id === 'claude-opus-4-6');
  assert.ok(opus);
  assert.equal(opus.label, 'Claude Opus 4.6');
  assert.deepEqual(opus.efforts.map((e) => e.id), ['thinking']);
  assert.equal(opus.defaultEffort, 'thinking');

  // GPT-OSS 120B
  const gpt = families.find((f) => f.id === 'gpt-oss-120b');
  assert.ok(gpt);
  assert.equal(gpt.label, 'GPT-OSS 120B');
  assert.deepEqual(gpt.efforts.map((e) => e.id), ['medium']);
  assert.equal(gpt.defaultEffort, 'medium');
});

test('split/compose agy model ids', () => {
  assert.deepEqual(splitAgyModelId('gemini-3.5-flash-high'), {
    baseId: 'gemini-3.5-flash',
    effort: 'high',
  });
  assert.equal(composeAgyModelId('gemini-3.5-flash', 'low'), 'gemini-3.5-flash-low');
  assert.equal(stripEffortFromLabel('Gemini 3.6 Flash (High)'), 'Gemini 3.6 Flash');
});

/**
 * Isolates agy binary discovery so only the AGY_HOME/bin tree can match:
 * clears overrides/env homes and points $HOME at an empty temp dir (os.homedir()
 * reads $HOME on POSIX). Cross-platform win32 probing is exercised via the
 * injectable platformId — same convention as cli-path's forceWindows flag.
 */
function withIsolatedAgyDiscovery(fn) {
  const keys = ['AGY_PATH', 'AGY_CLI_PATH', 'GEMINI_CLI_PATH', 'AGY_HOME', 'ANTIGRAVITY_CLI_HOME', 'HOME'];
  const saved = {};
  for (const k of keys) saved[k] = process.env[k];
  const dir = fs.mkdtempSync(join(tmpdir(), 'agy-discovery-'));
  process.env.AGY_HOME = join(dir, 'agyhome');
  process.env.HOME = join(dir, 'home');
  delete process.env.AGY_PATH;
  delete process.env.AGY_CLI_PATH;
  delete process.env.GEMINI_CLI_PATH;
  delete process.env.ANTIGRAVITY_CLI_HOME;
  fs.mkdirSync(join(dir, 'home'), { recursive: true });
  try {
    return fn(join(dir, 'agyhome', 'bin'));
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function makeExecutable(filePath) {
  fs.mkdirSync(join(filePath, '..'), { recursive: true });
  fs.writeFileSync(filePath, '#!/bin/sh\n');
  fs.chmodSync(filePath, 0o755);
}

test('resolveAgyBinary win32 probe prefers agy.exe over agy.cmd (cross-platform)', () => {
  withIsolatedAgyDiscovery((binDir) => {
    const exe = join(binDir, 'agy.exe');
    const cmd = join(binDir, 'agy.cmd');
    makeExecutable(exe);
    makeExecutable(cmd);
    assert.equal(resolveAgyBinary('win32'), exe);
  });
});

test('resolveAgyBinary win32 probe discovers a lone agy.cmd npm shim', () => {
  withIsolatedAgyDiscovery((binDir) => {
    const cmd = join(binDir, 'agy.cmd');
    makeExecutable(cmd);
    assert.equal(resolveAgyBinary('win32'), cmd);
  });
});

test('resolveAgyBinary win32 PATH scan is name-major across directories', () => {
  // agy.exe in a LATER PATH dir must beat agy.cmd in an earlier one — the
  // scan tries every dir for agy.exe before any dir for the shim, so a
  // stray npm shim cannot shadow a real executable further down the PATH.
  withIsolatedAgyDiscovery(() => {
    const dirA = fs.mkdtempSync(join(tmpdir(), 'agy-path-a-'));
    const dirB = fs.mkdtempSync(join(tmpdir(), 'agy-path-b-'));
    const exe = join(dirB, 'agy.exe');
    makeExecutable(join(dirA, 'agy.cmd'));
    makeExecutable(exe);
    const savedPath = process.env.PATH;
    process.env.PATH = [dirA, dirB].join(delimiter);
    try {
      assert.equal(resolveAgyBinary('win32'), exe);
    } finally {
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
      fs.rmSync(dirA, { recursive: true, force: true });
      fs.rmSync(dirB, { recursive: true, force: true });
    }
  });
});

test('resolveAgyBinary non-win32 platforms never pick agy.cmd', () => {
  withIsolatedAgyDiscovery((binDir) => {
    const cmd = join(binDir, 'agy.cmd');
    makeExecutable(cmd);
    // A system agy elsewhere may legitimately resolve, but the .cmd shim
    // must not be a candidate outside win32.
    assert.notEqual(resolveAgyBinary('linux'), cmd);
    assert.notEqual(resolveAgyBinary('darwin'), cmd);
  });
});

test('resolveAgyBinary probes the ~/.antigravity/bin install dir', () => {
  // The Java detector probes ~/.antigravity/bin (homeBinDirs AGY case);
  // the resolver must find agy there too, else status says "available"
  // while every send fails "not found".
  withIsolatedAgyDiscovery(() => {
    const homeBin = join(process.env.HOME, '.antigravity', 'bin', 'agy');
    makeExecutable(homeBin);
    assert.equal(resolveAgyBinary('linux'), homeBin);
  });
});

// The positive case seeds the module-level families cache; reset first so
// earlier tests in this file cannot mask the probe assertions.
test('warmAgyModelCatalogForModel probes only for bare family ids', async () => {
  cacheAgyModelFamilies(null);
  const dir = fs.mkdtempSync(join(tmpdir(), 'agy-warm-'));
  const bin = join(dir, 'agy-fake');
  const logPath = join(dir, 'calls.log');
  fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require('fs');
if (process.argv[2] === 'models') {
  fs.appendFileSync(${JSON.stringify(logPath)}, 'models\\n');
  console.log('gemini-3.5-flash-low Low');
  process.exit(0);
}
process.exit(1);
`, 'utf8');
  fs.chmodSync(bin, 0o755);
  const prev = process.env.AGY_PATH;
  process.env.AGY_PATH = bin;
  try {
    // Empty model and full slugs must not spawn `agy models` at all.
    await warmAgyModelCatalogForModel('');
    await warmAgyModelCatalogForModel('gemini-3.5-flash-high');
    assert.equal(fs.existsSync(logPath), false, 'no `agy models` probe expected');

    // Bare family id warms the cache from the fake catalog.
    await warmAgyModelCatalogForModel('gemini-3.5-flash');
    assert.equal(fs.existsSync(logPath), true, 'expected one `agy models` probe');
    assert.ok(getCachedAgyModelFamilies(), 'expected the families cache seeded');

    // Warm cache short-circuits further probes.
    const sizeBefore = fs.statSync(logPath).size;
    await warmAgyModelCatalogForModel('gemini-3.5-flash');
    assert.equal(fs.statSync(logPath).size, sizeBefore, 'warm cache must not re-probe');
  } finally {
    if (prev === undefined) delete process.env.AGY_PATH;
    else process.env.AGY_PATH = prev;
    // This test seeds the module-level families cache — reset it so later
    // tests in this file cannot inherit a warm cache (the masking the
    // file's leading comment warns about).
    cacheAgyModelFamilies(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('listAgyModels spawns the resolved binary and parses its output', async () => {
  // End-to-end over the spawn plumbing (resolveCliSpawn invocation +
  // execFileAsync): a broken composition returns [] via the catch and fails.
  // Manual env isolation (not withIsolatedAgyDiscovery — its finally rmSync
  // runs at the first internal await and deletes the fake binary mid-spawn;
  // same manual idiom as the warmAgyModelCatalogForModel test above).
  const dir = fs.mkdtempSync(join(tmpdir(), 'agy-list-'));
  const bin = join(dir, 'agy-fake');
  fs.writeFileSync(bin, '#!/bin/sh\n'
    + 'echo "claude-sonnet-4-6  Claude Sonnet 4.6 (High)"\n'
    + 'echo "gemini-3.6-flash  Gemini 3.6 Flash (Medium)"\n');
  fs.chmodSync(bin, 0o755);
  const prev = process.env.AGY_PATH;
  process.env.AGY_PATH = bin;
  try {
    const models = await listAgyModels();
    assert.deepEqual(
      models.map((m) => m.id),
      ['claude-sonnet-4-6', 'gemini-3.6-flash'],
    );
    assert.equal(models[1].label, 'Gemini 3.6 Flash (Medium)');
  } finally {
    if (prev === undefined) delete process.env.AGY_PATH;
    else process.env.AGY_PATH = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('listAgyModels closes child stdin — agy waits for EOF (regression: 15s timeout, empty catalog)', async () => {
  // agy ≥1.1.x prints nothing while its stdin pipe stays open. `cat` blocks
  // the same way, so the fake binary reproduces the hang without the real
  // CLI: without the stdin.end() fix this times out at 15s and returns [].
  const dir = fs.mkdtempSync(join(tmpdir(), 'agy-stdin-'));
  const bin = join(dir, 'agy-fake');
  fs.writeFileSync(bin, '#!/bin/sh\n'
    + 'cat > /dev/null\n'
    + 'echo "claude-sonnet-4-6  Claude Sonnet 4.6 (Thinking)"\n');
  fs.chmodSync(bin, 0o755);
  const prev = process.env.AGY_PATH;
  process.env.AGY_PATH = bin;
  try {
    const models = await listAgyModels();
    assert.equal(models.length, 1, 'must resolve after stdin EOF, got: ' + JSON.stringify(models));
    assert.equal(models[0].id, 'claude-sonnet-4-6');
  } finally {
    if (prev === undefined) delete process.env.AGY_PATH;
    else process.env.AGY_PATH = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

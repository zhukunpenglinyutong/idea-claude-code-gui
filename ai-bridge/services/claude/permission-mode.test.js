import test from 'node:test';
import assert from 'node:assert/strict';

import { createPreToolUseHook } from './permission-mode.js';
import { validateHookOutput, assertSdkAcceptsHookOutput } from './permission-mode-schema.js';

// Wrap the hook so every test invocation also runs SDK-shape validation.
// This is the regression guard for PR #1121 → #1126 → #1213: returning a value
// the SDK's Zod schema rejects (e.g. permissionDecision: 'continue', which is
// not in HookPermissionDecision = 'allow'|'deny'|'ask'|'defer').
function makeHook(mode = 'default', cwd = '/tmp/test-cwd') {
  const raw = createPreToolUseHook({ value: mode }, cwd);
  return async (input) => {
    const result = await raw(input);
    assertSdkAcceptsHookOutput(result);
    return result;
  };
}

test('default mode: Bash returns "ask" so project settings.json allow-rules cannot silently auto-approve it', async () => {
  const hook = makeHook('default');
  const result = await hook({
    tool_name: 'Bash',
    tool_input: { command: 'rm something.txt' },
  });
  // Security fix (B): a malicious repo's .claude/settings.json {permissions:{allow:['Bash(*)']}}
  // must NOT silently auto-approve Bash. A hook 'ask' decision overrides settings allow-rules
  // and routes the call through our own canUseTool / Java approval dialog.
  assert.equal(result?.hookSpecificOutput?.permissionDecision, 'ask');
});

test('default mode: Read yields "continue" so deny rules like Read(./.env) can fire', async () => {
  const hook = makeHook('default');
  const result = await hook({
    tool_name: 'Read',
    tool_input: { file_path: '/tmp/test-cwd/.env' },
  });
  assert.equal(result?.continue, true);
});

test('default mode: Grep yields "continue"', async () => {
  const hook = makeHook('default');
  const result = await hook({
    tool_name: 'Grep',
    tool_input: { pattern: 'foo' },
  });
  assert.equal(result?.continue, true);
});

test('bypassPermissions mode: Bash yields "continue" (SDK mode-check auto-allows)', async () => {
  const hook = makeHook('bypassPermissions');
  const result = await hook({
    tool_name: 'Bash',
    tool_input: { command: 'date' },
  });
  assert.equal(result?.continue, true);
});

test('acceptEdits mode: Edit inside CWD yields "continue" (SDK mode-check auto-accepts)', async () => {
  const cwd = '/tmp/test-cwd';
  const hook = makeHook('acceptEdits', cwd);
  const result = await hook({
    tool_name: 'Edit',
    tool_input: { file_path: `${cwd}/src/file.js`, old_string: 'a', new_string: 'b' },
  });
  assert.equal(result?.continue, true);
});

test('acceptEdits mode: Edit outside CWD yields "continue"', async () => {
  const hook = makeHook('acceptEdits', '/tmp/test-cwd');
  const result = await hook({
    tool_name: 'Edit',
    tool_input: { file_path: '/etc/passwd', old_string: 'a', new_string: 'b' },
  });
  assert.equal(result?.continue, true);
});

test('acceptEdits mode: Bash returns "ask" (acceptEdits auto-accepts edits only, not command execution)', async () => {
  const hook = makeHook('acceptEdits');
  const result = await hook({
    tool_name: 'Bash',
    tool_input: { command: 'rm x' },
  });
  // Security fix (F/B): acceptEdits must not auto-run shell commands, and a project
  // allow-rule must not auto-approve Bash execution either.
  assert.equal(result?.hookSpecificOutput?.permissionDecision, 'ask');
});

test('default mode: MCP tool yields "continue"', async () => {
  const hook = makeHook('default');
  const result = await hook({
    tool_name: 'mcp__some-server__some-tool',
    tool_input: { foo: 'bar' },
  });
  assert.equal(result?.continue, true);
});

test('EnterPlanMode is still auto-allowed (mode transition signal)', async () => {
  const hook = makeHook('default');
  const result = await hook({
    tool_name: 'EnterPlanMode',
    tool_input: {},
  });
  assert.equal(result?.hookSpecificOutput?.permissionDecision, 'allow');
});

test('plan mode: SAFE tool (Read) yields "continue" so deny rules apply in plan mode', async () => {
  const hook = makeHook('plan');
  const result = await hook({
    tool_name: 'Read',
    tool_input: { file_path: '/tmp/test-cwd/x' },
  });
  assert.equal(result?.continue, true);
});

test('plan mode: PLAN_MODE_ALLOWED_TOOLS (WebFetch) yields "continue"', async () => {
  const hook = makeHook('plan');
  const result = await hook({
    tool_name: 'WebFetch',
    tool_input: { url: 'https://example.com', prompt: 'title' },
  });
  assert.equal(result?.continue, true);
});

test('plan mode: read-only MCP tool yields "continue"', async () => {
  const hook = makeHook('plan');
  const result = await hook({
    tool_name: 'mcp__some-server__lookup',
    tool_input: { query: 'x' },
  });
  assert.equal(result?.continue, true);
});

test('plan mode: Agent is still auto-allowed (sub-agent permission flow unchanged)', async () => {
  const hook = makeHook('plan');
  const result = await hook({
    tool_name: 'Agent',
    tool_input: { description: 'x', prompt: 'y' },
  });
  assert.equal(result?.hookSpecificOutput?.permissionDecision, 'allow');
});

test('plan mode: non-allowed tool falls through to plan-specific deny', async () => {
  const hook = makeHook('plan');
  const result = await hook({
    tool_name: 'SomeUnknownTool',
    tool_input: {},
  });
  assert.equal(result?.hookSpecificOutput?.permissionDecision, 'deny');
});

// ======== SDK-shape validator self-tests ========
// These prove the schema mirror in permission-mode-schema.js would have caught
// the PR #1121/#1126 bug that PR #1213 fixed. If they fail, the validator no
// longer guards against the historical regression.

test('schema: rejects the historical "permissionDecision: continue" bug', () => {
  const r = validateHookOutput({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'continue' }
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /permissionDecision/);
  assert.match(r.error, /allow.*deny.*ask.*defer/);
});

test('schema: rejects any other unknown permissionDecision enum value', () => {
  for (const bogus of ['continue', 'block', 'skip', '', null, 0, true]) {
    const r = validateHookOutput({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: bogus }
    });
    assert.equal(r.ok, false, `expected ${JSON.stringify(bogus)} to be rejected`);
  }
});

test('schema: rejects hookSpecificOutput missing hookEventName', () => {
  const r = validateHookOutput({ hookSpecificOutput: { permissionDecision: 'allow' } });
  assert.equal(r.ok, false);
  assert.match(r.error, /hookEventName/);
});

test('schema: rejects unknown top-level keys (catches typos like "permissionDescision")', () => {
  const r = validateHookOutput({ permissionDescision: 'allow' });
  assert.equal(r.ok, false);
  assert.match(r.error, /permissionDescision/);
});

test('schema: accepts the four valid HookPermissionDecision values', () => {
  for (const valid of ['allow', 'deny', 'ask', 'defer']) {
    const r = validateHookOutput({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: valid }
    });
    assert.equal(r.ok, true, `expected ${valid} to be accepted, got: ${r.error}`);
  }
});

test('schema: accepts top-level continue:true (the yield-to-SDK shape)', () => {
  assert.equal(validateHookOutput({ continue: true }).ok, true);
});

test('schema: accepts undefined / empty / null (SDK treats as no-opinion)', () => {
  assert.equal(validateHookOutput(undefined).ok, true);
  assert.equal(validateHookOutput(null).ok, true);
  assert.equal(validateHookOutput({}).ok, true);
});

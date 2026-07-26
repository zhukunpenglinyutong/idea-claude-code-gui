import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractPatchFromResponseItemPayload,
  parseApplyPatchToOperations,
} from './codex-patch-parser.js';

const PATCH = [
  '*** Begin Patch',
  '*** Update File: hbapp/src/example.js',
  '@@ -1 +1 @@',
  '-const size = 30;',
  '+const size = 32;',
  '*** End Patch',
].join('\n');

test('extracts a raw patch from custom_tool_call apply_patch', () => {
  const patch = extractPatchFromResponseItemPayload({
    type: 'custom_tool_call',
    name: 'apply_patch',
    input: PATCH,
  });

  assert.equal(patch, PATCH);
});

test('extracts and decodes an escaped patch from custom_tool_call exec source', () => {
  const source = `const patch = ${JSON.stringify(PATCH)}; text(await tools.apply_patch(patch));`;
  const patch = extractPatchFromResponseItemPayload({
    type: 'custom_tool_call',
    name: 'exec',
    input: source,
  });

  assert.equal(patch, PATCH);
  assert.deepEqual(parseApplyPatchToOperations(patch), [{
    filePath: 'hbapp/src/example.js',
    kind: 'update',
    oldString: 'const size = 30;',
    newString: 'const size = 32;',
    toolName: 'edit',
    startLine: 1,
    endLine: undefined,
  }]);
});

test('extracts a patch from object-shaped custom_tool_call exec input', () => {
  const patch = extractPatchFromResponseItemPayload({
    type: 'custom_tool_call',
    name: 'exec',
    input: { code: `await tools.apply_patch(${JSON.stringify(PATCH)})` },
  });

  assert.equal(patch, PATCH);
});

test('does not classify unrelated custom_tool_call exec source as a patch', () => {
  const patch = extractPatchFromResponseItemPayload({
    type: 'custom_tool_call',
    name: 'exec',
    input: 'text(await tools.shell_command({ command: "git status" }));',
  });

  assert.equal(patch, '');
});

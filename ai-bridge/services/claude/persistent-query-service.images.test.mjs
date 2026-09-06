// Keep request construction independent of the developer's credentials.
import './testing/cli-login-home.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { __testing } from './persistent-query-service.js';
import { createScriptedQuery, RESULT_OK } from './testing/scripted-query.js';

for (const resolvedModel of ['claude-sonnet-4-6', 'custom-vision-model', 'qwen-vl', 'sonnet']) {
  test(`delivers image blocks to the SDK when the provider maps to ${resolvedModel}`, async () => {
    const data = Buffer.alloc(128 * 1024, 0xab).toString('base64');
    const context = await __testing.buildRequestContext({
      model: 'claude-sonnet-4-6',
      message: 'Describe the photo',
      attachments: [{ fileName: 'photo.png', mediaType: 'image/png', data }],
    }, true, {
      settings: { env: { ANTHROPIC_DEFAULT_SONNET_MODEL: resolvedModel } },
    });

    assert.equal(context.resolvedModelId, resolvedModel);
    const blocks = context.userMessage.message.content;
    assert.equal(blocks[0].type, 'image', 'provider aliases must not turn images into file paths');
    assert.equal(blocks[0].source.data === data, true, 'image data must remain complete');
    assert.deepEqual(blocks[1], { type: 'text', text: 'Describe the photo' });
  });
}

test('preserves @ reference text when constructing plain messages', async () => {
  const message = '@"/tmp/photo with spaces.jpg" Describe this image';
  const context = await __testing.buildRequestContext({ message }, false);
  assert.deepEqual(context.userMessage.message.content, [{ type: 'text', text: message }]);
});

test('passes image-only uploads through the persistent runtime input stream', { timeout: 5000 }, async () => {
  const data = Buffer.alloc(1024 * 1024, 0xab).toString('base64');
  let query;
  __testing.setQueryFn(args => {
    query = createScriptedQuery(args, [[RESULT_OK]]);
    return query;
  });
  try {
    const context = await __testing.buildRequestContext({
      model: 'custom-vision-model',
      attachments: [{ mediaType: 'image/jpeg', fileName: 'photo.jpg', data }],
    }, true, { settings: { env: {} } });
    const runtime = await __testing.acquireRuntime(context);
    await __testing.executeTurn(runtime, context);

    assert.equal(query.inputs.length, 1);
    const blocks = query.inputs[0].message.content;
    assert.equal(blocks[0].type, 'image');
    assert.equal(blocks[0].source.data === data, true);
    assert.deepEqual(blocks[1], { type: 'text', text: '[Uploaded 1 image(s)]' });
  } finally {
    await __testing.resetState();
  }
});

import { testHomeDir } from './testing/cli-login-home.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { __testing } from './persistent-query-service.js';
import { createImageFixture } from './testing/image-fixture.js';

const sdkPath = process.env.CLAUDE_IMAGE_TEST_SDK_PATH;

// The optional SDK lives outside this repository. Only use an explicitly selected
// installation, with isolated settings, a dummy key and a loopback API endpoint.
test('sends uploads and @ Read results through the real persistent SDK to the API', {
  skip: !sdkPath && 'Set CLAUDE_IMAGE_TEST_SDK_PATH to an installed sdk.mjs',
  timeout: 60000,
}, async t => {
  const { query } = await import(pathToFileURL(sdkPath).href);
  const originalCwd = process.cwd();
  const previousCliPath = process.env.CLAUDE_CODE_PATH;
  // Exercise isolation even on machines without a custom CLI configured.
  process.env.CLAUDE_CODE_PATH = path.join(testHomeDir, 'unrelated-cli');
  t.after(() => {
    if (previousCliPath === undefined) delete process.env.CLAUDE_CODE_PATH;
    else process.env.CLAUDE_CODE_PATH = previousCliPath;
  });
  let requests = [];
  let referencePath;
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const part of req) raw += part;
    res.setHeader('Content-Type', 'application/json');
    if (!req.url.startsWith('/v1/messages') || req.url.includes('count_tokens')) {
      res.end(JSON.stringify({ input_tokens: 1 }));
      return;
    }
    const payload = JSON.parse(raw);
    requests.push(payload);
    const requestRead = referencePath && requests.length === 1;
    const block = requestRead
      ? { type: 'tool_use', id: 'tool_image_test', name: 'Read', input: { file_path: referencePath } }
      : { type: 'text', text: 'ok' };
    const message = {
      id: 'msg_image_test', type: 'message', role: 'assistant', model: payload.model,
      content: [block], stop_reason: requestRead ? 'tool_use' : 'end_turn', stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    if (!payload.stream) {
      res.end(JSON.stringify(message));
      return;
    }
    res.setHeader('Content-Type', 'text/event-stream');
    const events = [
      { type: 'message_start', message: { ...message, content: [], stop_reason: null } },
      { type: 'content_block_start', index: 0, content_block: requestRead
        ? { ...block, input: {} } : { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: requestRead
        ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) }
        : { type: 'text_delta', text: 'ok' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null },
        usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ];
    for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  t.after(async () => {
    await __testing.resetState();
    process.chdir(originalCwd);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const env = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
    TEMP: testHomeDir, TMP: testHomeDir, HOME: testHomeDir, USERPROFILE: testHomeDir,
    CLAUDE_CONFIG_DIR: testHomeDir,
    ANTHROPIC_API_KEY: 'local-image-test-key',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'custom-vision-model',
    CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', USER_TYPE: 'external',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
  };

  const imageDirectory = path.join(testHomeDir, 'issue 1725 image fixtures');
  await mkdir(imageDirectory, { recursive: true });
  for (const width of [128, 132, 600, 2100]) {
    const png = createImageFixture(width);
    const filename = path.join(imageDirectory, `photo-${width}.png`);
    await writeFile(filename, png);
    for (const kind of ['upload', 'reference']) {
      await t.test(`${kind}: ${png.length} byte PNG through a provider model alias`, { timeout: 15000 }, async () => {
        requests = [];
        referencePath = kind === 'reference' ? filename : undefined;
        const context = await __testing.buildRequestContext({
          cwd: testHomeDir, model: 'claude-sonnet-4-6', disableThinking: true,
          message: kind === 'reference' ? `@${filename} Describe this image` : 'Describe this image',
          attachments: kind === 'upload' ? [{ mediaType: 'image/png', data: png.toString('base64') }] : [],
        }, kind === 'upload', { settings: { env } });
        const abortController = new AbortController();
        const timeout = setTimeout(() => abortController.abort(), 12000);
        __testing.setQueryFn(args => query({ ...args, options: {
          ...args.options, env, settingSources: [], persistSession: false, enableFileCheckpointing: false,
          // Keep a developer's custom CLI override from replacing the selected SDK's binary.
          pathToClaudeCodeExecutable: undefined,
          tools: ['Read'], mcpServers: {}, maxTurns: 2, abortController,
        } }));
        try {
          const runtime = await __testing.acquireRuntime(context);
          await __testing.executeTurn(runtime, context);
          assert.equal(requests.length, kind === 'reference' ? 2 : 1);
          const lastRequest = requests.at(-1);
          assert.equal(lastRequest.model, 'custom-vision-model');
          const blocks = lastRequest.messages.flatMap(message => message.content);
          const images = kind === 'reference'
            ? blocks.filter(block => block.type === 'tool_result' && block.tool_use_id === 'tool_image_test')
              .flatMap(block => block.content).filter(block => block.type === 'image')
            : blocks.filter(block => block.type === 'image');
          assert.equal(images.length, 1, 'The API must receive visual content, not just a file path');
          const image = images[0].source;
          assert.equal(image.type, 'base64');
          const bytes = Buffer.from(image.data, 'base64');
          assert.ok(bytes.length > 0);
          if (image.media_type === 'image/png') {
            assert.deepEqual(bytes.subarray(0, 8), png.subarray(0, 8));
          } else {
            assert.equal(image.media_type, 'image/jpeg');
            assert.equal(bytes.subarray(0, 2).toString('hex'), 'ffd8');
            assert.equal(bytes.subarray(-2).toString('hex'), 'ffd9');
          }
        } finally {
          clearTimeout(timeout);
          await __testing.resetState();
        }
      });
    }
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildContentBlocks, loadAttachments, cleanupStaleTempImages } from './attachment-service.js';

test('keeps image bytes and MIME types intact across the reported size boundary', async () => {
  for (const size of [1024, 49 * 1024, 51 * 1024, 1024 * 1024, 12 * 1024 * 1024]) {
    const data = Buffer.alloc(size, 0xab).toString('base64');
    for (const mediaType of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) {
      const attachments = await loadAttachments(JSON.parse(JSON.stringify({
        attachments: [{ fileName: 'photo', mediaType, data }],
      })));
      const blocks = await buildContentBlocks(attachments, 'Describe this image');
      assert.equal(blocks[0].type, 'image');
      assert.equal(blocks[0].source.type, 'base64');
      assert.equal(blocks[0].source.media_type, mediaType);
      assert.equal(blocks[0].source.data === data, true, `${size} bytes must survive unchanged`);
      assert.deepEqual(blocks[1], { type: 'text', text: 'Describe this image' });
    }
  }
});

test('preserves multiple images and provides text for image-only messages', async () => {
  const attachments = [
    { fileName: 'first.png', mediaType: 'image/png', data: 'AQ==' },
    { fileName: 'second.jpg', mediaType: 'image/jpeg', data: 'Ag==' },
  ];
  assert.deepEqual(await loadAttachments(attachments), attachments);
  const blocks = await buildContentBlocks(attachments, '  ');
  assert.deepEqual(blocks.map(block => block.type), ['image', 'image', 'text']);
  assert.equal(blocks[2].text, '[Uploaded 2 image(s)]');
});

test('preserves non-image attachment and empty-message fallbacks', async () => {
  assert.deepEqual(await buildContentBlocks([], ''), [{ type: 'text', text: '[Empty message]' }]);
  assert.deepEqual(await buildContentBlocks([{ fileName: 'notes.txt' }, {}], ''), [
    { type: 'text', text: '[Attachment: notes.txt]' },
    { type: 'text', text: '[Attachment: Attachment]' },
    { type: 'text', text: '[Uploaded attachment(s)]' },
  ]);
});

test('reads a large attachment through the bridge stdin protocol without truncation', () => {
  const data = Buffer.alloc(1024 * 1024, 0xab).toString('base64');
  const moduleUrl = new URL('./attachment-service.js', import.meta.url).href;
  const stdinModuleUrl = new URL('../../utils/stdin-utils.js', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { loadAttachments, buildContentBlocks } from ${JSON.stringify(moduleUrl)};
    import { readStdinData } from ${JSON.stringify(stdinModuleUrl)};
    const input = await readStdinData();
    const blocks = await buildContentBlocks(await loadAttachments(input), input.message);
    process.stdout.write(JSON.stringify(blocks));
  `], {
    env: { ...process.env, CLAUDE_USE_STDIN: 'true' },
    input: JSON.stringify({
      message: 'Describe the image',
      attachments: [{ mediaType: 'image/png', data }],
    }),
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    timeout: 10000,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  const blocks = JSON.parse(child.stdout);
  assert.equal(blocks[0].type, 'image');
  assert.equal(blocks[0].source.data === data, true);
});

test('retains legacy attachment-file loading while preferring explicit stdin attachments', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-gui-attachment-test-'));
  const file = path.join(directory, 'attachments.json');
  const previous = process.env.CLAUDE_ATTACHMENTS_FILE;
  t.after(async () => {
    if (previous === undefined) delete process.env.CLAUDE_ATTACHMENTS_FILE;
    else process.env.CLAUDE_ATTACHMENTS_FILE = previous;
    await fs.unlink(file);
    await fs.rmdir(directory);
  });
  delete process.env.CLAUDE_ATTACHMENTS_FILE;
  assert.deepEqual(await loadAttachments(null), []);
  process.env.CLAUDE_ATTACHMENTS_FILE = file;
  const attachments = [{ mediaType: 'image/png', data: 'AQ==' }];
  await fs.writeFile(file, JSON.stringify(attachments));
  assert.deepEqual(await loadAttachments(null), attachments);
  assert.deepEqual(await loadAttachments({ attachments: [] }), []);
  await fs.writeFile(file, '{}');
  assert.deepEqual(await loadAttachments({}), []);
  await fs.writeFile(file, '{');
  assert.deepEqual(await loadAttachments(null), []);
});

test('cleans legacy temporary images without deleting recent uploads', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-gui-image-cleanup-test-'));
  const images = path.join(directory, 'cc-gui-images');
  const stale = path.join(images, 'stale.png');
  const recent = path.join(images, 'recent.png');
  t.mock.method(os, 'tmpdir', () => directory);
  t.after(async () => {
    await fs.unlink(stale).catch(() => {});
    await fs.unlink(recent).catch(() => {});
    await fs.rmdir(images);
    await fs.rmdir(directory);
  });
  await cleanupStaleTempImages();
  await fs.mkdir(images);
  await fs.writeFile(stale, 'old image');
  await fs.writeFile(recent, 'recent image');
  const oldTime = new Date(Date.now() - 48 * 60 * 60 * 1000);
  await fs.utimes(stale, oldTime, oldTime);
  await cleanupStaleTempImages();
  await assert.rejects(fs.stat(stale), { code: 'ENOENT' });
  assert.equal(await fs.readFile(recent, 'utf8'), 'recent image');
});

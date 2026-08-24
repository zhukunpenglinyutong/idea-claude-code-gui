import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, chmodSync, mkdtempSync, rmSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sendMessage } from './message-service.js';

// Fake agy answering `models` with low+medium tiers only (no -high): after a
// successful warm the spawn resolves bare `gemini-3.5-flash` to ...-medium,
// while the no-catalog guess fallback would be ...-high. That difference is
// exactly what the warm-path assertions below detect.
function makeFakeAgy(dir) {
  const bin = join(dir, 'agy-fake');
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require('fs');
const argv = process.argv.slice(2);
if (argv[0] === 'models') {
  console.log('gemini-3.5-flash-low Low');
  console.log('gemini-3.5-flash-medium Medium');
  process.exit(0);
}
fs.writeFileSync(process.env.AGY_ARGV_LOG, JSON.stringify(argv));
console.log(JSON.stringify({ event: 'result', result: { conversation_id: 'c', status: 'SUCCESS', response: 'ok' } }));
process.exit(0);
`, { encoding: 'utf8' });
  chmodSync(bin, 0o755);
  return bin;
}

/**
 * Run sendMessage against the fake agy and return the captured spawn argv.
 * @returns {Promise<string[]>}
 */
async function runWithArgvCapture(options) {
  const dir = mkdtempSync(join(tmpdir(), 'agy-msg-'));
  const bin = makeFakeAgy(dir);
  const logPath = join(dir, 'argv.json');
  const prev = process.env.AGY_PATH;
  const prevLog = process.env.AGY_ARGV_LOG;
  process.env.AGY_PATH = bin;
  process.env.AGY_ARGV_LOG = logPath;
  const logs = [];
  const origLog = console.log;
  console.log = (...a) => logs.push(a.map(String).join(' '));
  let argv = [];
  try {
    await sendMessage(options);
    argv = JSON.parse(readFileSync(logPath, 'utf8'));
  } finally {
    console.log = origLog;
    if (prev === undefined) delete process.env.AGY_PATH;
    else process.env.AGY_PATH = prev;
    if (prevLog === undefined) delete process.env.AGY_ARGV_LOG;
    else process.env.AGY_ARGV_LOG = prevLog;
    rmSync(dir, { recursive: true, force: true });
  }
  const prompt = String(argv[argv.indexOf('-p') + 1] || '');
  return { argv, prompt, logs };
}

test('sendMessage surfaces skipped non-image attachments in the prompt (AC3)', async () => {
  // A daemon-only console log is invisible to the user — the conversation
  // itself must say the attachment was not delivered, and say WHY.
  const { prompt } = await runWithArgvCapture({
    message: 'analyze the attached content',
    attachments: [
      { fileName: 'report.pdf', mimeType: 'application/pdf' },
    ],
  });
  assert.ok(
    prompt.includes('[System note: 1 non-image attachment(s) were not delivered'),
    'expected a system note about the skipped pdf, got: ' + prompt,
  );
  assert.ok(prompt.includes('analyze the attached content'));
});

test('sendMessage distinguishes oversized images from non-image files in the note', async () => {
  // A valid image over the 2 MB limit must not be told "not an image file".
  const { prompt } = await runWithArgvCapture({
    message: 'look',
    attachments: [
      { fileName: 'big.png', mimeType: 'image/png', data: `data:image/png;base64,${'A'.repeat(3 * 1024 * 1024)}` },
    ],
  });
  assert.ok(
    prompt.includes('1 image attachment(s) with invalid data or over the 2 MB limit'),
    'expected an oversized-image note, got: ' + prompt,
  );
  assert.ok(!prompt.includes('non-image'), 'an image file must not be called non-image');
});

test('sendMessage materializes image attachments into Read-tool references (AC3)', async () => {
  const { prompt } = await runWithArgvCapture({
    message: 'what is in this picture',
    attachments: [
      { fileName: 'shot.png', mimeType: 'image/png', data: 'data:image/png;base64,iVBORw0KGgo=' },
    ],
  });
  assert.ok(prompt.includes('[Image #1:'), 'expected a materialized image reference, got: ' + prompt);
  assert.ok(prompt.includes('what is in this picture'));
  assert.ok(!prompt.includes('[System note:'), 'no skip note expected for a valid image');
});

test('sendMessage removes materialized image temp files after the turn', async () => {
  // The finally-block cleanup is the only thing standing between every image
  // turn and an unbounded tmpdir leak.
  const tmpBase = join(tmpdir(), 'cc-gui-cli-images');
  const before = existsSync(tmpBase) ? readdirSync(tmpBase) : [];
  await runWithArgvCapture({
    message: 'cleanup check',
    attachments: [
      { fileName: 'shot.png', mimeType: 'image/png', data: 'data:image/png;base64,iVBORw0KGgo=' },
    ],
  });
  const after = existsSync(tmpBase) ? readdirSync(tmpBase) : [];
  assert.deepEqual(after, before, `expected temp dir unchanged after cleanup, got ${after}`);
});

test('sendMessage warms the catalog and resolves bare families to offered tiers (AC2)', async () => {
  // One-shot channel-manager: the send process never sees the listModels
  // cache — the send path must warm it itself via `agy models` (the fake
  // binary answers `models` with low/medium tiers and NO -high tier). The
  // guess fallback would pass --model gemini-3.5-flash-high, which this
  // fake catalog deliberately does not offer.
  const { argv } = await runWithArgvCapture({
    message: 'hi',
    model: 'gemini-3.5-flash',
    reasoningEffort: '',
  });
  const modelFlag = String(argv[argv.indexOf('--model') + 1] || '');
  assert.equal(
    modelFlag,
    'gemini-3.5-flash-medium',
    'expected the catalog tier from the warmed cache, got: ' + modelFlag,
  );
});

test('sendMessage combines mixed-attachment failures into one system note (T3)', async () => {
  // 1 non-image + 1 oversized image → exactly ONE note carrying both counts.
  const { prompt } = await runWithArgvCapture({
    message: 'look',
    attachments: [
      { fileName: 'report.pdf', mimeType: 'application/pdf' },
      { fileName: 'big.png', mimeType: 'image/png', data: `data:image/png;base64,${'A'.repeat(3 * 1024 * 1024)}` },
    ],
  });
  const noteCount = prompt.split('[System note:').length - 1;
  assert.equal(noteCount, 1, `expected exactly one system note, got ${noteCount}: ${prompt}`);
  assert.ok(prompt.includes('1 non-image attachment(s)'), 'note must carry the non-image count: ' + prompt);
  assert.ok(
    prompt.includes('1 image attachment(s) with invalid data or over the 2 MB limit'),
    'note must carry the failed-image count: ' + prompt,
  );
});

test('sendMessage counts mediaType-hinted attachments as images, not as skipped (P3)', async () => {
  // mediaType-only attachment (no mimeType field): the old inline counter
  // misreported it as "non-image … not delivered" while the materializer
  // delivered it — the shared predicate must keep them in agreement.
  const { prompt } = await runWithArgvCapture({
    message: 'what is in this picture',
    attachments: [
      { fileName: 'shot.png', mediaType: 'image/png', data: 'data:image/png;base64,iVBORw0KGgo=' },
    ],
  });
  assert.ok(prompt.includes('[Image #1:'), 'expected the mediaType-hinted image to be delivered: ' + prompt);
  assert.ok(!prompt.includes('[System note:'), 'a delivered image must not be reported as skipped: ' + prompt);
});

test('sendMessage counts path attachments as images, not as skipped (P3)', async () => {
  const { prompt } = await runWithArgvCapture({
    message: 'check this file',
    attachments: [
      { fileName: 'local.png', path: join(tmpdir(), 'local.png') },
    ],
  });
  assert.ok(prompt.includes('[Image #1:'), 'expected the path attachment to be referenced: ' + prompt);
  assert.ok(!prompt.includes('[System note:'), 'a path attachment must not be reported as skipped: ' + prompt);
});

test('sendMessage surfaces a materialization-failure note when the temp dir is unusable (T4)', async () => {
  // TMPDIR pointed at an existing regular file forces the materializer's
  // temp-dir mkdir to throw (ENOTDIR) — the catch must tell the user their
  // attachments are gone instead of silently dropping the chips.
  const dir = mkdtempSync(join(tmpdir(), 'agy-msg-'));
  const bin = makeFakeAgy(dir);
  const logPath = join(dir, 'argv.json');
  const blocker = join(dir, 'tmpdir-blocker');
  writeFileSync(blocker, 'not a directory');
  const prev = process.env.AGY_PATH;
  const prevLog = process.env.AGY_ARGV_LOG;
  const prevTmp = process.env.TMPDIR;
  process.env.AGY_PATH = bin;
  process.env.AGY_ARGV_LOG = logPath;
  const origLog = console.log;
  console.log = () => {};
  try {
    process.env.TMPDIR = blocker;
    await sendMessage({
      message: 'look',
      attachments: [
        { fileName: 'shot.png', mimeType: 'image/png', data: 'data:image/png;base64,iVBORw0KGgo=' },
      ],
    });
    const argv = JSON.parse(readFileSync(logPath, 'utf8'));
    const prompt = String(argv[argv.indexOf('-p') + 1] || '');
    assert.ok(
      prompt.includes('[System note:') && prompt.includes('materialization failed'),
      'expected a materialization-failure note, got: ' + prompt,
    );
  } finally {
    console.log = origLog;
    if (prev === undefined) delete process.env.AGY_PATH;
    else process.env.AGY_PATH = prev;
    if (prevLog === undefined) delete process.env.AGY_ARGV_LOG;
    else process.env.AGY_ARGV_LOG = prevLog;
    if (prevTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = prevTmp;
    rmSync(dir, { recursive: true, force: true });
  }
});

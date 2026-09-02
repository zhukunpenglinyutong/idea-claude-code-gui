import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildSessionMessagesPayload, buildSessionMessagesPagePayload, isUserTextMessage, isInterruptionMarker } from './session-service.js';

test('buildSessionMessagesPayload returns an empty history when the session file is missing', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gui-claude-session-'));
  try {
    const missing = path.join(tempDir, 'does-not-exist.jsonl');
    assert.deepEqual(buildSessionMessagesPayload(missing), {
      success: true,
      messages: [],
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('buildSessionMessagesPayload rewrites a queued_command attachment carrier into a user message', () => {
  // A background Agent's terminal report can land as a queued_command
  // attachment rather than a user message. Java's MessageParser drops
  // non-user/assistant rows, so the reader must reshape it into a user message
  // or the subagent card stays stuck on the launch ack text after a reload.
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gui-claude-session-'));
  try {
    const file = path.join(tempDir, 'session.jsonl');
    const xml = '<task-notification>\n<tool-use-id>toolu_att</tool-use-id>\n<status>completed</status>\n<result>the report</result>\n</task-notification>';
    fs.writeFileSync(file, [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
      JSON.stringify({
        type: 'attachment',
        attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: xml },
      }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'ok' } }),
    ].join('\n') + '\n');

    const { success, messages } = buildSessionMessagesPayload(file);
    assert.equal(success, true);
    // The attachment row is reshaped into a user message carrying the XML, so
    // it survives MessageParser's user/assistant-only filter and reaches the
    // frontend's collectTaskEventsFromMessages.
    assert.equal(messages.length, 3);
    assert.deepEqual(messages[1], {
      type: 'user',
      message: { role: 'user', content: xml },
    });
    // User-message and assistant rows pass through unchanged.
    assert.equal(messages[0].type, 'user');
    assert.equal(messages[2].type, 'assistant');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('buildSessionMessagesPayload keeps a parent-linked queued command attachment on the effective chain', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gui-claude-session-'));
  try {
    const file = path.join(tempDir, 'session.jsonl');
    const xml = '<task-notification>do the thing</task-notification>';
    fs.writeFileSync(file, [
      JSON.stringify({
        type: 'user',
        uuid: 'u1',
        timestamp: '2026-01-01T10:00:00Z',
        message: { role: 'user', content: 'start' },
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        timestamp: '2026-01-01T10:00:01Z',
        message: { role: 'assistant', content: 'working' },
      }),
      JSON.stringify({
        type: 'attachment',
        uuid: 'attachment-1',
        parentUuid: 'a1',
        timestamp: '2026-01-01T10:00:02Z',
        attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: xml },
      }),
    ].join('\n') + '\n');

    const { messages } = buildSessionMessagesPayload(file);
    assert.deepEqual(messages.map((message) => message.message.content), ['start', 'working', xml]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('buildSessionMessagesPayload leaves a non-task-notification queued_command attachment untouched', () => {
  // An enqueued user prompt is also a queued_command attachment but not a
  // task-notification carrier; it must not be rewritten into a user message.
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gui-claude-session-'));
  try {
    const file = path.join(tempDir, 'session.jsonl');
    const queuedPrompt = {
      type: 'attachment',
      attachment: { type: 'queued_command', commandMode: 'user-prompt', prompt: 'do something' },
    };
    fs.writeFileSync(file, JSON.stringify(queuedPrompt) + '\n');

    const { messages } = buildSessionMessagesPayload(file);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].type, 'attachment');
    assert.equal(messages[0].attachment.commandMode, 'user-prompt');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('buildSessionMessagesPayload drops the CLI interruption marker rows', () => {
  // The CLI persists synthetic "[Request interrupted by user]" user rows when
  // a turn is aborted. They are turn-abort bookkeeping, not real input: if
  // they reach the chat they render as a phantom user message, and their uuid
  // hijacks getLatestUserMessage so the rewind uuid-sync starves the user's
  // real last message. Both marker variants must be dropped.
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gui-claude-session-'));
  try {
    const file = path.join(tempDir, 'session.jsonl');
    fs.writeFileSync(file, [
      JSON.stringify({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'hi' } }),
      JSON.stringify({ type: 'user', uuid: 'u2', message: { role: 'user', content: '[Request interrupted by user]' } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'ok' } }),
      JSON.stringify({ type: 'user', uuid: 'u3', message: { role: 'user', content: '[Request interrupted by user for tool use]' } }),
    ].join('\n') + '\n');

    const { success, messages } = buildSessionMessagesPayload(file);
    assert.equal(success, true);
    assert.deepEqual(messages.map((m) => m.uuid), ['u1', undefined]);
    assert.equal(messages[0].type, 'user');
    assert.equal(messages[1].type, 'assistant');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('buildSessionMessagesPayload keeps a user message that merely mentions the marker text', () => {
  // Only whole content exactly equal to the marker is synthetic; a real user
  // prompt that mentions it must survive.
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gui-claude-session-'));
  try {
    const file = path.join(tempDir, 'session.jsonl');
    fs.writeFileSync(file, JSON.stringify({
      type: 'user',
      uuid: 'u1',
      message: { role: 'user', content: 'why did you print [Request interrupted by user]?' },
    }) + '\n');

    const { messages } = buildSessionMessagesPayload(file);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].uuid, 'u1');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('buildSessionMessagesPayload drops rewound branches of the transcript', () => {
  // Rewind never deletes rows: the CLI forks in place, so the next user
  // message parents onto the pre-rewind assistant and the discarded span
  // stays on disk as a dead branch. Reading line-by-line would render it;
  // only the parentUuid chain from the newest leaf is live.
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gui-claude-session-'));
  try {
    const file = path.join(tempDir, 'session.jsonl');
    fs.writeFileSync(file, [
      JSON.stringify({ type: 'user', uuid: 'u1', parentUuid: null, timestamp: '2026-01-01T10:00:00Z', message: { role: 'user', content: 'first' } }),
      JSON.stringify({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: '2026-01-01T10:00:05Z', message: { id: 'm1', role: 'assistant', content: 'answer one' } }),
      JSON.stringify({ type: 'user', uuid: 'u2', parentUuid: 'a1', timestamp: '2026-01-01T10:01:00Z', message: { role: 'user', content: 'rewound question' } }),
      JSON.stringify({ type: 'assistant', uuid: 'a2', parentUuid: 'u2', timestamp: '2026-01-01T10:01:05Z', message: { id: 'm2', role: 'assistant', content: 'rewound answer' } }),
      JSON.stringify({ type: 'user', uuid: 'u3', parentUuid: 'a1', timestamp: '2026-01-01T10:02:00Z', message: { role: 'user', content: 'retry question' } }),
      JSON.stringify({ type: 'assistant', uuid: 'a3', parentUuid: 'u3', timestamp: '2026-01-01T10:02:05Z', message: { id: 'm3', role: 'assistant', content: 'retry answer' } }),
    ].join('\n') + '\n');

    const { success, messages } = buildSessionMessagesPayload(file);
    assert.equal(success, true);
    assert.deepEqual(messages.map((m) => m.uuid), ['u1', 'a1', 'u3', 'a3']);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('isUserTextMessage rejects the interruption markers', () => {
  // getLatestUserMessage feeds the rewind uuid-sync: the interruption row must
  // never be picked as the "latest user message", or the user's real last
  // message keeps its uuid unpatched and rewind loses the anchor.
  assert.equal(isUserTextMessage({
    type: 'user',
    uuid: 'u1',
    message: { role: 'user', content: '[Request interrupted by user]' },
  }), false);
  assert.equal(isUserTextMessage({
    type: 'user',
    uuid: 'u2',
    message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] },
  }), false);
  assert.equal(isUserTextMessage({
    type: 'user',
    uuid: 'u3',
    message: { role: 'user', content: 'hi' },
  }), true);
});

test('isInterruptionMarker matches only the synthetic markers', () => {
  assert.equal(isInterruptionMarker({
    type: 'user',
    message: { role: 'user', content: '[Request interrupted by user]' },
  }), true);
  assert.equal(isInterruptionMarker({
    type: 'user',
    message: { role: 'user', content: '[Request interrupted by user for tool use]' },
  }), true);
  assert.equal(isInterruptionMarker({
    type: 'user',
    message: { role: 'user', content: 'why did you print [Request interrupted by user]?' },
  }), false);
  assert.equal(isInterruptionMarker({ type: 'assistant', message: { role: 'assistant', content: '[Request interrupted by user]' } }), false);
  assert.equal(isInterruptionMarker(null), false);
});

// ===== buildSessionMessagesPagePayload (turn-based pagination) =====

/**
 * Helper: write a JSONL session with `turnCount` user/assistant pairs.
 * Each user message gets a uuid so it counts as a turn start.
 */
function writeTurnFixture(turnCount) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gui-claude-page-'));
  const file = path.join(tempDir, 'session.jsonl');
  const lines = [];
  for (let i = 0; i < turnCount; i++) {
    lines.push(JSON.stringify({ type: 'user', uuid: `u${i}`, message: { role: 'user', content: `q${i}` } }));
    lines.push(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: `a${i}` } }));
  }
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return { tempDir, file };
}

test('buildSessionMessagesPagePayload returns the latest page when beforeTurn is omitted', () => {
  const { tempDir, file } = writeTurnFixture(10);
  try {
    const page = buildSessionMessagesPagePayload(file, null, 3);
    assert.equal(page.success, true);
    assert.equal(page.totalTurns, 10);
    assert.equal(page.fromTurn, 7);
    assert.equal(page.toTurn, 10);
    assert.equal(page.hasMore, true);
    assert.equal(page.cursorReset, false);
    // 3 turns x 2 messages each
    assert.equal(page.messages.length, 6);
    assert.equal(page.messages[0].message.content, 'q7');
    assert.equal(page.messages[page.messages.length - 1].message.content, 'a9');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('buildSessionMessagesPagePayload returns an earlier page with beforeTurn', () => {
  const { tempDir, file } = writeTurnFixture(10);
  try {
    const page = buildSessionMessagesPagePayload(file, 7, 3);
    assert.equal(page.success, true);
    assert.equal(page.fromTurn, 4);
    assert.equal(page.toTurn, 7);
    assert.equal(page.hasMore, true);
    assert.equal(page.messages[0].message.content, 'q4');
    assert.equal(page.messages[page.messages.length - 1].message.content, 'a6');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('buildSessionMessagesPagePayload reports hasMore=false on the first page', () => {
  const { tempDir, file } = writeTurnFixture(10);
  try {
    // Walk to the first page: latest(7..10) -> (4..7) -> (1..4) -> (0..1)
    const page = buildSessionMessagesPagePayload(file, 1, 3);
    assert.equal(page.fromTurn, 0);
    assert.equal(page.toTurn, 1);
    assert.equal(page.hasMore, false);
    assert.equal(page.messages[0].message.content, 'q0');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('buildSessionMessagesPagePayload sets cursorReset when beforeTurn exceeds history', () => {
  const { tempDir, file } = writeTurnFixture(5);
  try {
    const page = buildSessionMessagesPagePayload(file, 99, 3);
    assert.equal(page.success, true);
    assert.equal(page.cursorReset, true);
    // Falls back to the latest page
    assert.equal(page.toTurn, 5);
    assert.equal(page.fromTurn, 2);
    assert.equal(page.messages[0].message.content, 'q2');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('buildSessionMessagesPagePayload never splits a turn across pages', () => {
  // A turn = user + assistant + tool rows. The page boundary must align to
  // the user message, never cut between a tool_use and its tool_result.
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gui-claude-page-'));
  try {
    const file = path.join(tempDir, 'session.jsonl');
    const lines = [];
    for (let i = 0; i < 5; i++) {
      lines.push(JSON.stringify({ type: 'user', uuid: `u${i}`, message: { role: 'user', content: `q${i}` } }));
      // Assistant turn with two content rows (e.g. text + tool_use)
      lines.push(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `a${i}-1` }] } }));
      lines.push(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'Bash' }] } }));
    }
    fs.writeFileSync(file, lines.join('\n') + '\n');

    const page = buildSessionMessagesPagePayload(file, null, 2);
    assert.equal(page.success, true);
    assert.equal(page.totalTurns, 5);
    assert.equal(page.fromTurn, 3);
    assert.equal(page.toTurn, 5);
    // 2 turns x 3 messages each — the whole assistant group stays together
    assert.equal(page.messages.length, 6);
    assert.equal(page.messages[0].message.content, 'q3');
    assert.equal(page.messages[page.messages.length - 1].message.content[0].name, 'Bash');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('buildSessionMessagesPagePayload returns empty page for missing file', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gui-claude-page-'));
  try {
    const page = buildSessionMessagesPagePayload(path.join(tempDir, 'nope.jsonl'), null, 30);
    assert.equal(page.success, true);
    assert.equal(page.messages.length, 0);
    assert.equal(page.totalTurns, 0);
    assert.equal(page.hasMore, false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('buildSessionMessagesPagePayload keeps short sessions in one page', () => {
  const { tempDir, file } = writeTurnFixture(5);
  try {
    const page = buildSessionMessagesPagePayload(file, null, 30);
    assert.equal(page.fromTurn, 0);
    assert.equal(page.toTurn, 5);
    assert.equal(page.hasMore, false);
    assert.equal(page.messages.length, 10);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

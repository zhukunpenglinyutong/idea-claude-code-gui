import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createInitialEventState,
  isWindowsTaskkillParseNoise,
  prepareSessionReplayBoundary,
  processCodexEventStream,
} from './codex-event-handler.js';

async function* eventsFrom(items) {
  for (const item of items) {
    yield item;
  }
}

async function captureStdout(fn) {
  const original = process.stdout.write.bind(process.stdout);
  const captured = [];
  process.stdout.write = (chunk, ...rest) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString();
    captured.push(text);
    return true;
  };
  try {
    await fn();
  } finally {
    process.stdout.write = original;
  }
  return captured;
}

function tagLines(captured, tag) {
  return captured.filter((line) => line.startsWith(tag));
}

function makeConfig() {
  return {
    cwd: undefined,
    threadId: null,
    threadOptions: {},
    normalizedPermissionMode: 'default',
    turnAbortController: new AbortController(),
  };
}

const CUSTOM_EXEC_PATCH = [
  '*** Begin Patch',
  '*** Update File: hbapp/src/example.js',
  '@@ -1 +1 @@',
  '-const size = 30;',
  '+const size = 32;',
  '*** End Patch',
].join('\n');

const CUSTOM_EXEC_SOURCE = `const patch = ${JSON.stringify(CUSTOM_EXEC_PATCH)}; text(await tools.apply_patch(patch));`;

test('custom_tool_call exec apply_patch emits edit and result messages without file_change', async () => {
  const emittedMessages = [];
  const state = createInitialEventState((message) => emittedMessages.push(message));

  await captureStdout(async () => {
    await processCodexEventStream(
      eventsFrom([
        {
          type: 'response_item',
          payload: { type: 'custom_tool_call', call_id: 'patch-1', name: 'exec', input: CUSTOM_EXEC_SOURCE },
        },
        {
          type: 'response_item',
          payload: { type: 'custom_tool_call_output', call_id: 'patch-1', output: 'Done' },
        },
      ]),
      state,
      makeConfig(),
    );
  });

  assert.equal(emittedMessages.length, 2);
  assert.deepEqual(emittedMessages[0].message.content[0], {
    type: 'tool_use',
    id: 'codex_patch_patch-1_0',
    name: 'edit',
    input: {
      file_path: 'hbapp/src/example.js',
      old_string: 'const size = 30;',
      new_string: 'const size = 32;',
      start_line: 1,
      end_line: undefined,
      replace_all: false,
      source: 'codex_session_patch',
    },
  });
  assert.deepEqual(emittedMessages[1].message.content[0], {
    type: 'tool_result',
    tool_use_id: 'codex_patch_patch-1_0',
    is_error: false,
    content: 'Patch applied',
  });
});

test('current-turn session replay emits custom_tool_call exec patches found only in JSONL', async () => {
  const tempDirectory = await mkdtemp(join(tmpdir(), 'codex-custom-patch-replay-'));
  const tempSessionPath = join(tempDirectory, 'fixture-session.jsonl');
  await writeFile(tempSessionPath, '', 'utf8');

  try {
    const emittedMessages = [];
    const state = createInitialEventState((message) => emittedMessages.push(message));
    state.sessionFilePath = tempSessionPath;
    await prepareSessionReplayBoundary(state, 'fixture-thread');

    await appendFile(
      tempSessionPath,
      [
        { type: 'turn_context', payload: { cwd: 'C:/fixture' } },
        {
          type: 'response_item',
          payload: {
            type: 'custom_tool_call',
            call_id: 'session-patch-1',
            name: 'exec',
            input: CUSTOM_EXEC_SOURCE,
          },
        },
        {
          type: 'response_item',
          payload: { type: 'custom_tool_call_output', call_id: 'session-patch-1', output: 'Done' },
        },
      ].map((entry) => JSON.stringify(entry)).join('\n') + '\n',
      'utf8',
    );

    await captureStdout(async () => {
      await processCodexEventStream(
        eventsFrom([
          { type: 'event_msg', payload: { type: 'patch_apply_end' } },
          { type: 'turn.completed' },
        ]),
        state,
        { ...makeConfig(), threadId: 'fixture-thread' },
      );
    });

    const blocks = emittedMessages.flatMap((message) => message?.message?.content ?? []);
    assert.equal(blocks.filter((block) => block.type === 'tool_use').length, 1);
    assert.equal(blocks.filter((block) => block.type === 'tool_result').length, 1);
    assert.equal(blocks[0].name, 'edit');
    assert.equal(blocks[0].input.file_path, 'hbapp/src/example.js');
    assert.equal(blocks[1].tool_use_id, 'codex_patch_session-patch-1_0');
    assert.equal(blocks[1].is_error, false);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('Codex item.updated agent_message emits incremental content deltas before completion', async () => {
  const emittedMessages = [];
  const state = createInitialEventState((message) => emittedMessages.push(message));

  const captured = await captureStdout(async () => {
    await processCodexEventStream(
      eventsFrom([
        {
          type: 'item.updated',
          item: { id: 'msg-1', type: 'agent_message', text: 'Hel' },
        },
        {
          type: 'item.updated',
          item: { id: 'msg-1', type: 'agent_message', text: 'Hello' },
        },
        {
          type: 'item.completed',
          item: { id: 'msg-1', type: 'agent_message', text: 'Hello' },
        },
      ]),
      state,
      makeConfig(),
    );
  });

  const deltaLines = tagLines(captured, '[CONTENT_DELTA]');

  assert.equal(deltaLines.length, 2);
  assert.match(deltaLines[0], /"Hel"/);
  assert.match(deltaLines[1], /"lo"/);
  assert.equal(state.assistantText, 'Hello');
  assert.equal(emittedMessages.length, 1);
  assert.deepEqual(emittedMessages[0], {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello' }],
    },
  });
});

test('Codex session replay does not emit historical function calls before turn.started', async () => {
  const tempDirectory = await mkdtemp(join(tmpdir(), 'codex-history-replay-'));
  const tempSessionPath = join(tempDirectory, 'fixture-session.jsonl');
  const historicalEntries = [
    {
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'shell_command',
        call_id: 'old-call-1',
        arguments: JSON.stringify({ command: 'echo OLD_COMMAND' }),
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'old-call-1',
        output: 'OLD_OUTPUT',
      },
    },
  ];

  await writeFile(
    tempSessionPath,
    `${historicalEntries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
    'utf8',
  );

  try {
    const emittedMessages = [];
    const state = createInitialEventState((message) => emittedMessages.push(message));
    state.sessionFilePath = tempSessionPath;
    await prepareSessionReplayBoundary(state, 'fixture-thread');

    await captureStdout(async () => {
      await processCodexEventStream(
        eventsFrom([
          { type: 'event_msg', payload: { type: 'status' } },
          { type: 'turn.started' },
          { type: 'turn.completed' },
        ]),
        state,
        { ...makeConfig(), threadId: 'fixture-thread' },
      );
    });

    const historicalToolUses = emittedMessages.filter((message) =>
      message?.message?.content?.some((block) =>
        block.type === 'tool_use' && block.input?.command === 'echo OLD_COMMAND'
      )
    );

    assert.equal(
      historicalToolUses.length,
      0,
      'event_msg before turn.started replayed the historical OLD_COMMAND tool call',
    );
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('Codex session replay emits only current-turn function calls after a delayed turn_context', async () => {
  const tempDirectory = await mkdtemp(join(tmpdir(), 'codex-current-turn-replay-'));
  const tempSessionPath = join(tempDirectory, 'fixture-session.jsonl');
  const historicalEntry = {
    type: 'response_item',
    payload: {
      type: 'function_call',
      name: 'shell_command',
      call_id: 'old-call-1',
      arguments: JSON.stringify({ command: 'echo OLD_COMMAND' }),
    },
  };
  await writeFile(tempSessionPath, `${JSON.stringify(historicalEntry)}\n`, 'utf8');

  try {
    const emittedMessages = [];
    const state = createInitialEventState((message) => emittedMessages.push(message));
    state.sessionFilePath = tempSessionPath;
    await prepareSessionReplayBoundary(state, 'fixture-thread');

    async function* delayedCurrentTurnEvents() {
      yield { type: 'turn.started' };
      await appendFile(
        tempSessionPath,
        [
          { type: 'turn_context', payload: { cwd: 'C:/fixture' } },
          {
            type: 'response_item',
            payload: {
              type: 'function_call',
              name: 'shell_command',
              call_id: 'current-call-1',
              arguments: JSON.stringify({ command: 'echo CURRENT_COMMAND' }),
            },
          },
          {
            type: 'response_item',
            payload: {
              type: 'function_call_output',
              call_id: 'current-call-1',
              output: 'CURRENT_OUTPUT',
            },
          },
        ].map((entry) => JSON.stringify(entry)).join('\n') + '\n',
        'utf8',
      );
      yield { type: 'event_msg', payload: { type: 'status' } };
      yield { type: 'event_msg', payload: { type: 'status' } };
      yield { type: 'turn.completed' };
    }

    await captureStdout(async () => {
      await processCodexEventStream(
        delayedCurrentTurnEvents(),
        state,
        { ...makeConfig(), threadId: 'fixture-thread' },
      );
    });

    const toolUseCommands = emittedMessages.flatMap((message) =>
      message?.message?.content
        ?.filter((block) => block.type === 'tool_use')
        .map((block) => block.input?.command) ?? []
    );
    const currentResults = emittedMessages.flatMap((message) =>
      message?.message?.content
        ?.filter((block) => block.type === 'tool_result' && block.tool_use_id === 'current-call-1') ?? []
    );

    assert.deepEqual(toolUseCommands, ['echo CURRENT_COMMAND']);
    assert.equal(currentResults.length, 1);
    assert.equal(currentResults[0].content, 'CURRENT_OUTPUT');
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('Codex session replay accepts a verified current turn before turn.started is observed', async () => {
  const tempDirectory = await mkdtemp(join(tmpdir(), 'codex-early-current-turn-'));
  const tempSessionPath = join(tempDirectory, 'fixture-session.jsonl');
  await writeFile(
    tempSessionPath,
    `${JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'shell_command',
        call_id: 'old-call-1',
        arguments: JSON.stringify({ command: 'echo OLD_COMMAND' }),
      },
    })}\n`,
    'utf8',
  );

  try {
    const emittedMessages = [];
    const state = createInitialEventState((message) => emittedMessages.push(message));
    state.sessionFilePath = tempSessionPath;
    await prepareSessionReplayBoundary(state, 'fixture-thread');

    await appendFile(
      tempSessionPath,
      [
        { type: 'turn_context', payload: { cwd: 'C:/fixture' } },
        {
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'shell_command',
            call_id: 'current-call-early',
            arguments: JSON.stringify({ command: 'echo EARLY_CURRENT_COMMAND' }),
          },
        },
      ].map((entry) => JSON.stringify(entry)).join('\n') + '\n',
      'utf8',
    );

    await captureStdout(async () => {
      await processCodexEventStream(
        eventsFrom([
          { type: 'event_msg', payload: { type: 'status' } },
          { type: 'turn.started' },
          { type: 'turn.completed' },
        ]),
        state,
        { ...makeConfig(), threadId: 'fixture-thread' },
      );
    });

    const commands = emittedMessages.flatMap((message) =>
      message?.message?.content
        ?.filter((block) => block.type === 'tool_use')
        .map((block) => block.input?.command) ?? []
    );
    assert.deepEqual(commands, ['echo EARLY_CURRENT_COMMAND']);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('Codex direct response items and JSONL replay emit the same call_id only once', async () => {
  const tempDirectory = await mkdtemp(join(tmpdir(), 'codex-replay-dedup-'));
  const tempSessionPath = join(tempDirectory, 'fixture-session.jsonl');
  await writeFile(tempSessionPath, '', 'utf8');

  try {
    const emittedMessages = [];
    const state = createInitialEventState((message) => emittedMessages.push(message));
    state.sessionFilePath = tempSessionPath;
    await prepareSessionReplayBoundary(state, 'fixture-thread');

    const functionCall = {
      type: 'function_call',
      name: 'shell_command',
      call_id: 'dedup-call-1',
      arguments: JSON.stringify({ command: 'echo DEDUP_COMMAND' }),
    };
    const functionOutput = {
      type: 'function_call_output',
      call_id: 'dedup-call-1',
      output: 'DEDUP_OUTPUT',
    };
    await appendFile(
      tempSessionPath,
      [
        { type: 'turn_context', payload: { cwd: 'C:/fixture' } },
        { type: 'response_item', payload: functionCall },
        { type: 'response_item', payload: functionOutput },
      ].map((entry) => JSON.stringify(entry)).join('\n') + '\n',
      'utf8',
    );

    await captureStdout(async () => {
      await processCodexEventStream(
        eventsFrom([
          { type: 'response_item', payload: functionCall },
          { type: 'response_item', payload: functionOutput },
          { type: 'event_msg', payload: { type: 'status' } },
          { type: 'turn.completed' },
        ]),
        state,
        { ...makeConfig(), threadId: 'fixture-thread' },
      );
    });

    const matchingBlocks = emittedMessages.flatMap((message) =>
      message?.message?.content?.filter((block) =>
        block.id === 'dedup-call-1' || block.tool_use_id === 'dedup-call-1'
      ) ?? []
    );
    assert.equal(matchingBlocks.filter((block) => block.type === 'tool_use').length, 1);
    assert.equal(matchingBlocks.filter((block) => block.type === 'tool_result').length, 1);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('isWindowsTaskkillParseNoise: matches English SUCCESS taskkill output', () => {
  const message =
    'Failed to parse item: SUCCESS: The process with PID 12345 (child process of PID 67890) has been terminated.';
  assert.equal(isWindowsTaskkillParseNoise(message), true);
});

test('isWindowsTaskkillParseNoise: matches Chinese 成功 taskkill output', () => {
  const message = 'Failed to parse item: 成功: 进程 PID 12345 (PID 67890 的子进程) 已被终止';
  assert.equal(isWindowsTaskkillParseNoise(message), true);
});

test('isWindowsTaskkillParseNoise: matches mojibake (replacement char) with PID pair', () => {
  const message = 'Failed to parse item: ���: PID 12345 PID 67890 ��';
  assert.equal(isWindowsTaskkillParseNoise(message), true);
});

test('isWindowsTaskkillParseNoise: ignores message without "Failed to parse item:" prefix', () => {
  const message = 'SUCCESS: process PID 12345 (child PID 67890) terminated';
  assert.equal(isWindowsTaskkillParseNoise(message), false);
});

test('isWindowsTaskkillParseNoise: ignores message with only a single PID', () => {
  const message = 'Failed to parse item: SUCCESS: process PID 12345 terminated';
  assert.equal(isWindowsTaskkillParseNoise(message), false);
});

test('isWindowsTaskkillParseNoise: ignores real Codex parse errors without taskkill keywords', () => {
  const message = 'Failed to parse item: {"id":"msg-1","type":"agent_message"';
  assert.equal(isWindowsTaskkillParseNoise(message), false);
});

test('isWindowsTaskkillParseNoise: returns false for non-string input', () => {
  assert.equal(isWindowsTaskkillParseNoise(null), false);
  assert.equal(isWindowsTaskkillParseNoise(undefined), false);
  assert.equal(isWindowsTaskkillParseNoise(42), false);
  assert.equal(isWindowsTaskkillParseNoise({ msg: 'x' }), false);
});

test('isWindowsTaskkillParseNoise: returns false for empty payload after prefix', () => {
  assert.equal(isWindowsTaskkillParseNoise('Failed to parse item:'), false);
  assert.equal(isWindowsTaskkillParseNoise('Failed to parse item:   '), false);
});

test('isWindowsTaskkillParseNoise: matches when only "terminated" keyword present with PID pair', () => {
  const message = 'Failed to parse item: PID 100 PID 200 process tree terminated';
  assert.equal(isWindowsTaskkillParseNoise(message), true);
});

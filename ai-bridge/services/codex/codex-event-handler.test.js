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
  shouldBridgeCodexApproval,
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

test('native auto review does not invoke the late Java approval bridge', () => {
  assert.equal(
    shouldBridgeCodexApproval({
      normalizedPermissionMode: 'auto',
      threadOptions: { approvalPolicy: 'on-request' },
    }),
    false,
  );
  assert.equal(
    shouldBridgeCodexApproval({
      normalizedPermissionMode: 'default',
      threadOptions: { approvalPolicy: 'on-request' },
    }),
    true,
  );
  assert.equal(
    shouldBridgeCodexApproval({
      normalizedPermissionMode: 'bypassPermissions',
      threadOptions: { approvalPolicy: 'never' },
    }),
    false,
  );
});

const CUSTOM_EXEC_PATCH = [
  '*** Begin Patch',
  '*** Update File: hbapp/src/example.js',
  '@@ -1 +1 @@',
  '-const size = 30;',
  '+const size = 32;',
  '*** End Patch',
].join('\n');

const CUSTOM_EXEC_SOURCE = `const patch = ${JSON.stringify(CUSTOM_EXEC_PATCH)}; text(await tools.apply_patch(patch));`;
const CUSTOM_EXEC_PLAN_SOURCE = [
  'const result = await tools.update_plan({',
  '  explanation: "Implement and verify",',
  '  plan: [',
  '    { step: "Inspect current behavior", status: "completed" },',
  "    { step: 'Implement parser', status: 'in_progress' },",
  '    { step: `Run tests`, status: "pending" },',
  '  ],',
  '});',
  'text(result);',
].join('\n');

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

test('custom_tool_call exec update_plan emits normalized plan and result messages', async () => {
  const emittedMessages = [];
  const state = createInitialEventState((message) => emittedMessages.push(message));

  await captureStdout(async () => {
    await processCodexEventStream(
      eventsFrom([
        {
          type: 'response_item',
          payload: { type: 'custom_tool_call', call_id: 'plan-1', name: 'exec', input: CUSTOM_EXEC_PLAN_SOURCE },
        },
        {
          type: 'response_item',
          payload: { type: 'custom_tool_call_output', call_id: 'plan-1', output: '{}' },
        },
      ]),
      state,
      makeConfig(),
    );
  });

  assert.equal(emittedMessages.length, 2);
  assert.deepEqual(emittedMessages[0].message.content[0], {
    type: 'tool_use',
    id: 'codex_plan_plan-1',
    name: 'update_plan',
    input: {
      explanation: 'Implement and verify',
      plan: [
        { step: 'Inspect current behavior', status: 'completed', content: 'Inspect current behavior' },
        { step: 'Implement parser', status: 'in_progress', content: 'Implement parser' },
        { step: 'Run tests', status: 'pending', content: 'Run tests' },
      ],
    },
  });
  assert.deepEqual(emittedMessages[1].message.content[0], {
    type: 'tool_result',
    tool_use_id: 'codex_plan_plan-1',
    is_error: false,
    content: 'Plan updated',
  });
});

test('custom_tool_call exec update_plan treats array script failure output as an error', async () => {
  const emittedMessages = [];
  const state = createInitialEventState((message) => emittedMessages.push(message));

  await captureStdout(async () => {
    await processCodexEventStream(
      eventsFrom([
        {
          type: 'response_item',
          payload: { type: 'custom_tool_call', call_id: 'plan-failure', name: 'exec', input: CUSTOM_EXEC_PLAN_SOURCE },
        },
        {
          type: 'response_item',
          payload: {
            type: 'custom_tool_call_output',
            call_id: 'plan-failure',
            output: [
              { type: 'input_text', text: 'Script failed\nThe update was not applied.' },
              { type: 'input_text', text: 'Script error:\nExit code: 1' },
            ],
          },
        },
      ]),
      state,
      makeConfig(),
    );
  });

  assert.equal(emittedMessages.length, 2);
  assert.deepEqual(emittedMessages[1].message.content[0], {
    type: 'tool_result',
    tool_use_id: 'codex_plan_plan-failure',
    is_error: true,
    content: 'Plan update failed',
  });
});

test('custom_tool_call exec apply_patch ignores exit-code noise inside successful output', async () => {
  // Regression test: apply_patch output may echo command output containing
  // phrases like "exit code: 1" even when the patch itself succeeded. Only
  // start-of-output error prefixes (or an explicit error status) may fail it.
  const emittedMessages = [];
  const state = createInitialEventState((message) => emittedMessages.push(message));

  await captureStdout(async () => {
    await processCodexEventStream(
      eventsFrom([
        {
          type: 'response_item',
          payload: { type: 'custom_tool_call', call_id: 'patch-noisy', name: 'exec', input: CUSTOM_EXEC_SOURCE },
        },
        {
          type: 'response_item',
          payload: {
            type: 'custom_tool_call_output',
            call_id: 'patch-noisy',
            output: 'Applied patch cleanly.\nVerification script reported exit code: 1 but was non-blocking.',
          },
        },
      ]),
      state,
      makeConfig(),
    );
  });

  assert.equal(emittedMessages.length, 2);
  assert.deepEqual(emittedMessages[1].message.content[0], {
    type: 'tool_result',
    tool_use_id: 'codex_patch_patch-noisy_0',
    is_error: false,
    content: 'Patch applied',
  });
});

test('current-turn session replay emits custom_tool_call exec plans found only in JSONL', async () => {
  const tempDirectory = await mkdtemp(join(tmpdir(), 'codex-custom-plan-replay-'));
  const tempSessionPath = join(tempDirectory, 'fixture-session.jsonl');
  await writeFile(tempSessionPath, '', 'utf8');

  const emittedMessages = [];
  const state = createInitialEventState((message) => emittedMessages.push(message));
  state.sessionFilePath = tempSessionPath;
  state.sessionTurnBoundaryReady = true;
  state.sessionTurnStartCursor = 0;
  state.sessionFunctionCursor = 0;

  try {
    await writeFile(
      tempSessionPath,
      [
        { type: 'turn_context', payload: { cwd: 'C:/fixture' } },
        {
          type: 'response_item',
          payload: {
            type: 'custom_tool_call',
            call_id: 'session-plan-1',
            name: 'exec',
            input: CUSTOM_EXEC_PLAN_SOURCE,
          },
        },
        {
          type: 'response_item',
          payload: { type: 'custom_tool_call_output', call_id: 'session-plan-1', output: '{}' },
        },
      ].map((entry) => JSON.stringify(entry)).join('\n') + '\n',
      'utf8',
    );

    await captureStdout(async () => {
      await processCodexEventStream(
        eventsFrom([{ type: 'event_msg', payload: { type: 'status' } }, { type: 'turn.completed' }]),
        state,
        makeConfig(),
      );
    });

    assert.equal(emittedMessages.length, 2);
    assert.equal(emittedMessages[0].message.content[0].name, 'update_plan');
    assert.equal(emittedMessages[0].message.content[0].id, 'codex_plan_session-plan-1');
    assert.deepEqual(
      emittedMessages[0].message.content[0].input.plan.map(({ step, status }) => ({ step, status })),
      [
        { step: 'Inspect current behavior', status: 'completed' },
        { step: 'Implement parser', status: 'in_progress' },
        { step: 'Run tests', status: 'pending' },
      ],
    );
    assert.equal(emittedMessages[1].message.content[0].tool_use_id, 'codex_plan_session-plan-1');
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
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

test('token_count forwards current context and derives turn usage from cumulative deltas', async () => {
  const emittedMessages = [];
  const state = createInitialEventState((message) => emittedMessages.push(message));

  await captureStdout(async () => {
    await processCodexEventStream(
      eventsFrom([
        { type: 'turn.started' },
        {
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: {
                input_tokens: 150,
                cached_input_tokens: 60,
                output_tokens: 15,
                total_tokens: 165,
              },
              last_token_usage: {
                input_tokens: 50,
                cached_input_tokens: 20,
                output_tokens: 5,
                total_tokens: 55,
              },
              model_context_window: 258400,
            },
          },
        },
        {
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: {
                input_tokens: 220,
                cached_input_tokens: 90,
                output_tokens: 30,
                total_tokens: 250,
              },
              last_token_usage: {
                input_tokens: 70,
                cached_input_tokens: 30,
                output_tokens: 15,
                total_tokens: 85,
              },
              model_context_window: 258400,
            },
          },
        },
        {
          type: 'turn.completed',
          usage: { input_tokens: 220, cached_input_tokens: 90, output_tokens: 30 },
        },
      ]),
      state,
      makeConfig(),
    );
  });

  const contextMessages = emittedMessages.filter((message) => message.type === 'event_msg');
  assert.equal(contextMessages.length, 2);
  assert.deepEqual(contextMessages[1].payload.info.last_token_usage, {
    input_tokens: 70,
    cached_input_tokens: 30,
    output_tokens: 15,
    total_tokens: 85,
  });
  assert.equal(contextMessages[1].payload.info.model_context_window, 258400);

  const result = emittedMessages.find((message) => message.type === 'result');
  assert.deepEqual(result.usage, {
    input_tokens: 120,
    output_tokens: 20,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 50,
  });
});

test('turn.completed recovers omitted SDK token_count events from current-turn JSONL', async () => {
  const tempDirectory = await mkdtemp(join(tmpdir(), 'codex-token-count-replay-'));
  const tempSessionPath = join(tempDirectory, 'fixture-session.jsonl');
  await writeFile(
    tempSessionPath,
    `${JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 343224,
            cached_input_tokens: 300544,
            output_tokens: 2150,
            total_tokens: 345374,
          },
          last_token_usage: {
            input_tokens: 49060,
            cached_input_tokens: 46848,
            output_tokens: 231,
            total_tokens: 49291,
          },
          model_context_window: 258400,
        },
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
        { type: 'turn_context', payload: { cwd: '/fixture' } },
        {
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: {
                input_tokens: 396607,
                cached_input_tokens: 349440,
                output_tokens: 2219,
                total_tokens: 398826,
              },
              last_token_usage: {
                input_tokens: 53383,
                cached_input_tokens: 48896,
                output_tokens: 69,
                total_tokens: 53452,
              },
              model_context_window: 258400,
            },
          },
        },
      ].map((entry) => JSON.stringify(entry)).join('\n') + '\n',
      'utf8',
    );

    await captureStdout(async () => {
      await processCodexEventStream(
        eventsFrom([
          { type: 'turn.started' },
          {
            type: 'turn.completed',
            usage: { input_tokens: 396607, cached_input_tokens: 349440, output_tokens: 2219 },
          },
        ]),
        state,
        { ...makeConfig(), threadId: 'fixture-thread' },
      );
    });

    const contextMessages = emittedMessages.filter((message) => message.type === 'event_msg');
    assert.equal(contextMessages.length, 1);
    assert.equal(contextMessages[0].payload.info.last_token_usage.total_tokens, 53452);
    assert.equal(contextMessages[0].payload.info.model_context_window, 258400);
    const result = emittedMessages.find((message) => message.type === 'result');
    assert.deepEqual(result.usage, {
      input_tokens: 53383,
      output_tokens: 69,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 48896,
    });
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('event_msg forwarding excludes non-token events and pre-turn replay', async () => {
  const emittedMessages = [];
  const state = createInitialEventState((message) => emittedMessages.push(message));
  const tokenCount = {
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { input_tokens: 10, output_tokens: 1 },
        last_token_usage: { input_tokens: 10, output_tokens: 1 },
        model_context_window: 258400,
      },
    },
  };

  await captureStdout(async () => {
    await processCodexEventStream(
      eventsFrom([
        tokenCount,
        { type: 'turn.started' },
        { type: 'event_msg', payload: { type: 'status' } },
        tokenCount,
        { type: 'turn.completed' },
      ]),
      state,
      makeConfig(),
    );
  });

  const contextMessages = emittedMessages.filter((message) => message.type === 'event_msg');
  assert.equal(contextMessages.length, 1);
  assert.equal(contextMessages[0].payload.type, 'token_count');
});

test('turn.completed does not fabricate usage when no trusted token_count is available', async () => {
  const emittedMessages = [];
  const state = createInitialEventState((message) => emittedMessages.push(message));

  await captureStdout(async () => {
    await processCodexEventStream(
      eventsFrom([
        { type: 'turn.started' },
        {
          type: 'turn.completed',
          usage: { input_tokens: 37, cached_input_tokens: 11, output_tokens: 3 },
        },
      ]),
      state,
      makeConfig(),
    );
  });

  assert.equal(emittedMessages.some((message) => message.type === 'result'), false);
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

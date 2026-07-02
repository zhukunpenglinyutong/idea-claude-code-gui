import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createTurnState,
  processMessageContent,
  processStreamEvent,
  shouldOutputMessage,
} from './stream-event-processor.js';

function makeTurnState(streamingEnabled = true) {
  return createTurnState(
    { streamingEnabled, requestedSessionId: 'sess-test' },
    null
  );
}

function captureStdout(fn) {
  const original = process.stdout.write.bind(process.stdout);
  const captured = [];
  process.stdout.write = (chunk, ...rest) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString();
    captured.push(text);
    return true;
  };
  try {
    fn();
  } finally {
    process.stdout.write = original;
  }
  return captured;
}

function tagLines(captured, tag) {
  return captured.filter((line) => line.startsWith(tag));
}

test('shouldOutputMessage: streaming assistant without tool_use returns false', () => {
  const state = makeTurnState(true);
  state.hasStreamEvents = true;
  const msg = {
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'Hello' }] },
  };
  assert.equal(shouldOutputMessage(msg, state), false);
});

test('shouldOutputMessage: streaming assistant with tool_use returns true', () => {
  const state = makeTurnState(true);
  state.hasStreamEvents = true;
  const msg = {
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'Calling tool' },
        { type: 'tool_use', id: 't1', name: 'Read', input: {} },
      ],
    },
  };
  assert.equal(shouldOutputMessage(msg, state), true);
});

test('shouldOutputMessage: streaming assistant with thinking + text but no tool_use returns false', () => {
  const state = makeTurnState(true);
  state.hasStreamEvents = true;
  const msg = {
    type: 'assistant',
    message: {
      content: [
        { type: 'thinking', thinking: 'pondering' },
        { type: 'text', text: 'answer' },
      ],
    },
  };
  assert.equal(shouldOutputMessage(msg, state), false);
});

test('shouldOutputMessage: non-streaming assistant always returns true', () => {
  const state = makeTurnState(false);
  const msg = {
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'X' }] },
  };
  assert.equal(shouldOutputMessage(msg, state), true);
});

test('shouldOutputMessage: non-streaming assistant with tool_use returns true', () => {
  const state = makeTurnState(false);
  const msg = {
    type: 'assistant',
    message: {
      content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }],
    },
  };
  assert.equal(shouldOutputMessage(msg, state), true);
});

test('shouldOutputMessage: non-assistant messages always returned regardless of streaming', () => {
  const state = makeTurnState(true);
  assert.equal(shouldOutputMessage({ type: 'user', message: {} }, state), true);
  assert.equal(shouldOutputMessage({ type: 'system', session_id: 's' }, state), true);
  assert.equal(shouldOutputMessage({ type: 'result', is_error: false }, state), true);
});

test('shouldOutputMessage: streaming assistant with content as plain string returns false (no tool_use possible)', () => {
  const state = makeTurnState(true);
  state.hasStreamEvents = true;
  const msg = {
    type: 'assistant',
    message: { content: 'plain string content' },
  };
  assert.equal(shouldOutputMessage(msg, state), false);
});

test('shouldOutputMessage: streaming assistant with empty/missing content returns false', () => {
  const state = makeTurnState(true);
  state.hasStreamEvents = true;
  assert.equal(shouldOutputMessage({ type: 'assistant', message: {} }, state), false);
  assert.equal(shouldOutputMessage({ type: 'assistant' }, state), false);
  assert.equal(
    shouldOutputMessage({ type: 'assistant', message: { content: [] } }, state),
    false
  );
});

test('shouldOutputMessage: streaming assistant with multiple tool_use blocks returns true', () => {
  const state = makeTurnState(true);
  state.hasStreamEvents = true;
  const msg = {
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'Running tools' },
        { type: 'tool_use', id: 't1', name: 'Read', input: {} },
        { type: 'tool_use', id: 't2', name: 'Write', input: {} },
      ],
    },
  };
  assert.equal(shouldOutputMessage(msg, state), true);
});

test('end-to-end: streaming pure-text response emits no [MESSAGE], no duplicate [CONTENT_DELTA]', () => {
  const state = makeTurnState(true);

  const captured = captureStdout(() => {
    // Simulate SDK stream_event sequence
    processStreamEvent(
      {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } },
      },
      state
    );
    state.hasStreamEvents = true;
    processStreamEvent(
      {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: ' world' } },
      },
      state
    );

    // SDK then delivers accumulated assistant snapshot
    const assistantMsg = {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Hello world' }] },
    };

    // Replay persistent-query-service.executeTurn flow
    if (shouldOutputMessage(assistantMsg, state)) {
      process.stdout.write(`[MESSAGE] ${JSON.stringify(assistantMsg)}\n`);
    }
    processMessageContent(assistantMsg, state);
  });

  const messageLines = tagLines(captured, '[MESSAGE]');
  const deltaLines = tagLines(captured, '[CONTENT_DELTA]');

  assert.equal(messageLines.length, 0, 'pure-text streaming must not emit [MESSAGE]');
  assert.equal(
    deltaLines.length,
    2,
    'expected 2 deltas (Hello, world), got: ' + JSON.stringify(deltaLines)
  );
  assert.match(deltaLines[0], /"Hello"/);
  assert.match(deltaLines[1], /" world"/);
});

test('end-to-end: streaming with tool_use emits one [MESSAGE] so Java can route the tool call', () => {
  const state = makeTurnState(true);
  state.hasStreamEvents = true;

  const captured = captureStdout(() => {
    processStreamEvent(
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'Reading file' },
        },
      },
      state
    );

    const assistantMsg = {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Reading file' },
          { type: 'tool_use', id: 't1', name: 'Read', input: { path: 'a.txt' } },
        ],
      },
    };

    if (shouldOutputMessage(assistantMsg, state)) {
      process.stdout.write(`[MESSAGE] ${JSON.stringify(assistantMsg)}\n`);
    }
    processMessageContent(assistantMsg, state);
  });

  const messageLines = tagLines(captured, '[MESSAGE]');
  assert.equal(messageLines.length, 1, 'tool_use streaming must emit exactly one [MESSAGE]');
  assert.match(messageLines[0], /"tool_use"/);
});

test('end-to-end: non-streaming pure-text response still emits [MESSAGE] (legacy path)', () => {
  const state = makeTurnState(false);

  const captured = captureStdout(() => {
    const assistantMsg = {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Hello' }] },
    };
    if (shouldOutputMessage(assistantMsg, state)) {
      process.stdout.write(`[MESSAGE] ${JSON.stringify(assistantMsg)}\n`);
    }
  });

  const messageLines = tagLines(captured, '[MESSAGE]');
  assert.equal(messageLines.length, 1, 'non-streaming must keep emitting [MESSAGE]');
});

test('end-to-end: streaming tail-fill snapshot still triggers [CONTENT_DELTA] even when [MESSAGE] suppressed', () => {
  // Verifies that suppressing [MESSAGE] does not break conservative sync:
  // when stream_event coverage lags behind the assistant snapshot,
  // processMessageContent must still emit the missing tail delta.
  const state = makeTurnState(true);

  const captured = captureStdout(() => {
    processStreamEvent(
      {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } },
      },
      state
    );
    state.hasStreamEvents = true;

    // Snapshot has more content than stream_event delivered
    const assistantMsg = {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Hello world' }] },
    };

    if (shouldOutputMessage(assistantMsg, state)) {
      process.stdout.write(`[MESSAGE] ${JSON.stringify(assistantMsg)}\n`);
    }
    processMessageContent(assistantMsg, state);
  });

  const messageLines = tagLines(captured, '[MESSAGE]');
  const deltaLines = tagLines(captured, '[CONTENT_DELTA]');

  assert.equal(messageLines.length, 0, 'pure-text streaming must not emit [MESSAGE]');
  assert.equal(deltaLines.length, 2, 'stream_event delta + tail-fill delta');
  assert.match(deltaLines[0], /"Hello"/);
  assert.match(deltaLines[1], /" world"/);
  assert.equal(state.lastAssistantContent, 'Hello world');
});

test('processStreamEvent: cumulative text deltas only emit the novel suffix', () => {
  const state = makeTurnState(true);

  const captured = captureStdout(() => {
    processStreamEvent(
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Now I need to add' },
        },
      },
      state
    );
    processStreamEvent(
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Now I need to add the handler' },
        },
      },
      state
    );
  });

  const deltaLines = tagLines(captured, '[CONTENT_DELTA]');

  assert.equal(deltaLines.length, 2);
  assert.match(deltaLines[0], /"Now I need to add"/);
  assert.match(deltaLines[1], /" the handler"/);
  assert.equal(state.lastAssistantContent, 'Now I need to add the handler');
});

test('processStreamEvent: cumulative thinking deltas are tracked per block index', () => {
  const state = makeTurnState(true);

  const captured = captureStdout(() => {
    processStreamEvent(
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'Plan step one.' },
        },
      },
      state
    );
    processStreamEvent(
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: '2',
          delta: { type: 'thinking_delta', thinking: 'Plan step two.' },
        },
      },
      state
    );
    processStreamEvent(
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: '2',
          delta: { type: 'thinking_delta', thinking: 'Plan step two. Continue.' },
        },
      },
      state
    );
  });

  const deltaLines = tagLines(captured, '[THINKING_DELTA]');

  assert.equal(deltaLines.length, 3);
  assert.match(deltaLines[0], /"Plan step one\."/);
  assert.match(deltaLines[1], /"Plan step two\."/);
  assert.match(deltaLines[2], /" Continue\."/);
  assert.equal(state.lastThinkingContent, 'Plan step one.Plan step two. Continue.');
});

test('processStreamEvent: snapshot-mode block absorbs corrective rewrites without duplication', () => {
  // Reproduces the duplication observed with mimo-v2.5-pro / GLM / MiniMax: once
  // the provider has confirmed cumulative-snapshot mode (via a startsWith match),
  // a later snapshot that diverges from the accumulated value mid-string (a partial
  // rewrite, typo correction, or token re-translation) must NOT be re-emitted as
  // a fresh delta — that would visibly double every character before the
  // divergence point in the UI.
  const state = makeTurnState(true);

  const captured = captureStdout(() => {
    // Delta 1: bootstrap the block
    processStreamEvent(
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'Now I can see' },
        },
      },
      state
    );
    // Delta 2: cumulative snapshot extending delta 1 — confirms snapshot mode
    processStreamEvent(
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'Now I can see the actual code. Let me implement' },
        },
      },
      state
    );
    // Delta 3: corrective rewrite — model changed an earlier word (e.g. "actual" →
    // "actuall" with a typo, or paraphrased mid-block).  Neither startsWith nor
    // endsWith matches, so the legacy fall-through emits the entire string.
    // After our fix this branch must absorb the rewrite silently.
    processStreamEvent(
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'thinking_delta',
            thinking: 'Now I can see the actuall code. Let me implement the changes.',
          },
        },
      },
      state
    );
  });

  const deltaLines = tagLines(captured, '[THINKING_DELTA]');
  const totalEmitted = deltaLines
    .map((line) => JSON.parse(line.replace(/^\[THINKING_DELTA\]\s+/, '').trim()))
    .join('');

  // Pre-fix output would be:
  //   "Now I can see"
  // + " the actual code. Let me implement"
  // + "Now I can see the actuall code. Let me implement the changes."  ← duplicates!
  // After fix the corrective snapshot is absorbed silently and the front-end keeps
  // the longest non-divergent prefix it already accumulated.
  assert.ok(
    !totalEmitted.includes('Now I can seeNow I can see'),
    'Snapshot rewrite must not double the block content. Emitted: ' + JSON.stringify(totalEmitted),
  );
  assert.ok(
    !totalEmitted.includes('Let me implementNow I can see'),
    'Snapshot rewrite must not splice duplicated content (boundary signature). Emitted: ' + JSON.stringify(totalEmitted),
  );
});

test('processStreamEvent: incremental-mode block keeps appending novel deltas', () => {
  // Anthropic-standard providers send genuine incremental fragments where
  // each delta is shorter than the cumulative content.  These must continue
  // to flow through the fall-through path unchanged after the snapshot-mode
  // detection is added.
  const state = makeTurnState(true);

  const captured = captureStdout(() => {
    processStreamEvent(
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Hello' },
        },
      },
      state
    );
    processStreamEvent(
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: ' world' },
        },
      },
      state
    );
    processStreamEvent(
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: '!' },
        },
      },
      state
    );
  });

  const deltaLines = tagLines(captured, '[CONTENT_DELTA]');

  assert.equal(deltaLines.length, 3, 'each incremental fragment should emit');
  assert.match(deltaLines[0], /"Hello"/);
  assert.match(deltaLines[1], /" world"/);
  assert.match(deltaLines[2], /"!"/);
  assert.equal(state.lastAssistantContent, 'Hello world!');
});

// =========================================================================
// REGRESSION TESTS for PR #1205 — character loss + duplication fixes.
//
// These two scenarios are the exact bugs the PR claims to fix.  Without
// dedicated unit coverage the same regression has re-shipped multiple times
// (cf. .claude/rules/codex-history-replay-pitfalls.md "修复 PR 长期未合入
// 主线 = 必然回归" lesson).  Keep these green.
// =========================================================================

test('REGRESSION (PR#1205 bug 1): incremental stream "1","5","0","0" must NOT lose trailing "0" via endsWith match', () => {
  // Pre-fix behaviour: once accumulated content is "150", a subsequent
  // incremental delta "0" was absorbed because previous.endsWith(incoming).
  // The stale-replay check is now gated on snapshot mode, so incremental
  // fragments are emitted intact.
  const state = makeTurnState(true);

  const captured = captureStdout(() => {
    for (const fragment of ['1', '5', '0', '0']) {
      processStreamEvent(
        {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: fragment },
          },
        },
        state,
      );
    }
  });

  const deltaLines = tagLines(captured, '[CONTENT_DELTA]');
  const emitted = deltaLines
    .map((line) => JSON.parse(line.replace(/^\[CONTENT_DELTA\]\s+/, '').trim()))
    .join('');

  assert.equal(emitted, '1500', `expected concatenated deltas to equal "1500", got "${emitted}"`);
  assert.equal(deltaLines.length, 4, 'each fragment should emit its own delta');
  assert.equal(state.lastAssistantContent, '1500');
});

test('REGRESSION (PR#1205 bug 1): mid-word incremental fragment whose tail matches previous tail must not be absorbed', () => {
  // Generalisation of the 1500 bug: any incremental fragment that happens
  // to be a suffix of the accumulated content used to be silently dropped.
  // Example: accumulated "abc", next fragment "c" — pre-fix returned "".
  const state = makeTurnState(true);

  const captured = captureStdout(() => {
    for (const fragment of ['a', 'b', 'c', 'c']) {
      processStreamEvent(
        {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: fragment },
          },
        },
        state,
      );
    }
  });

  const emitted = tagLines(captured, '[CONTENT_DELTA]')
    .map((line) => JSON.parse(line.replace(/^\[CONTENT_DELTA\]\s+/, '').trim()))
    .join('');

  assert.equal(emitted, 'abcc', `expected "abcc", got "${emitted}"`);
});

test('REGRESSION (PR#1205 bug 2): assistant snapshot for a brand-new block must NOT emit while stream events are active', () => {
  // Pre-fix behaviour: when an interim assistant snapshot delivered content
  // for a block that the stream had not yet populated (typical multi-block
  // response where block 1 starts after block 0 finished), the snapshot
  // emitted the full block text as a [CONTENT_DELTA].  The stream then
  // delivered the same content again → user saw garbled / duplicated output.
  // After the fix, the snapshot path suppresses the emit when the per-block
  // accumulator is still empty and stream events are active.
  const state = makeTurnState(true);

  const captured = captureStdout(() => {
    // Block 0 has been fully delivered via stream events.
    processStreamEvent(
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Hello' },
        },
      },
      state,
    );
    state.hasStreamEvents = true;

    // Interim assistant snapshot arrives carrying block 0 + a brand-new
    // block 1 whose stream events have not started yet.
    const interimSnapshot = {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Hello' },
          { type: 'text', text: 'Brand new block 1 content' },
        ],
      },
    };
    processMessageContent(interimSnapshot, state);

    // Stream events for block 1 then arrive piece-by-piece.
    for (const fragment of ['Brand ', 'new ', 'block ', '1 ', 'content']) {
      processStreamEvent(
        {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 1,
            delta: { type: 'text_delta', text: fragment },
          },
        },
        state,
      );
    }
  });

  const deltaPayloads = tagLines(captured, '[CONTENT_DELTA]')
    .map((line) => JSON.parse(line.replace(/^\[CONTENT_DELTA\]\s+/, '').trim()));

  // No delta should equal the full block-1 snapshot — that would be the
  // duplicate emit the PR fixes.
  assert.ok(
    !deltaPayloads.includes('Brand new block 1 content'),
    `snapshot must not emit the whole new block as a single delta; got payloads: ${JSON.stringify(deltaPayloads)}`,
  );
  // Concatenated stream of block 1 must equal the expected content exactly
  // once — no doubling, no garbled prefix.
  const concatenated = deltaPayloads.join('');
  assert.equal(
    concatenated,
    'HelloBrand new block 1 content',
    `expected exactly one delivery of block 0 + block 1, got "${concatenated}"`,
  );
});

test('REGRESSION (snapshot single-source): processMessageContent absorbs a snapshot-mode mid-stream rewrite instead of mis-slicing it', () => {
  // The snapshot path used to derive its delta with a naive
  // currentText.substring(previousBlock.length), which assumes the snapshot is
  // always a prefix-extension of the accumulated content. When a Claude-compatible
  // provider in cumulative-snapshot mode emits a FINAL assistant message that
  // rewrites the middle of a block (shared prefix, divergent middle, longer
  // overall), the substring sliced an arbitrary tail ("es") and emitted garbage,
  // diverging from the live processStreamEvent path which absorbs the rewrite.
  // Routing the snapshot through resolveSnapshotDelta (the same engine) makes the
  // two paths single-sourced: the corrective rewrite is absorbed (novel === '').
  const state = makeTurnState(true);

  const captured = captureStdout(() => {
    // Two live deltas: the second extends the first → confirms snapshot mode.
    processStreamEvent(
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0,
        delta: { type: 'text_delta', text: 'The result is ' } } },
      state,
    );
    processStreamEvent(
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0,
        delta: { type: 'text_delta', text: 'The result is 42 items' } } },
      state,
    );
    state.hasStreamEvents = true;

    // Final snapshot rewrites the middle: "42 items" → "43 oranges".
    const finalSnapshot = {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'The result is 43 oranges' }] },
    };
    processMessageContent(finalSnapshot, state);
  });

  const emitted = tagLines(captured, '[CONTENT_DELTA]')
    .map((line) => JSON.parse(line.replace(/^\[CONTENT_DELTA\]\s+/, '').trim()))
    .join('');

  // Live path emitted "The result is " + "42 items"; the corrective snapshot is
  // absorbed rather than appending a mis-sliced "es" tail (the pre-refactor bug).
  assert.equal(
    emitted,
    'The result is 42 items',
    `snapshot rewrite must be absorbed, not mis-sliced; got "${emitted}"`,
  );
  assert.ok(!emitted.includes('oranges'), 'must not splice the divergent rewrite tail');
});

test('REGRESSION (PR#1205 bug 2): tail-fill is still emitted when block has prior partial content', () => {
  // The suppression in bug 2 must NOT block legitimate tail-fill: when the
  // block already has streamed content and the snapshot extends it, the
  // missing tail must be emitted (otherwise content is silently dropped).
  const state = makeTurnState(true);

  const captured = captureStdout(() => {
    processStreamEvent(
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Hello' },
        },
      },
      state,
    );
    state.hasStreamEvents = true;

    const finalSnapshot = {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Hello world' }] },
    };
    processMessageContent(finalSnapshot, state);
  });

  const deltaLines = tagLines(captured, '[CONTENT_DELTA]');
  assert.equal(deltaLines.length, 2, 'stream fragment + tail-fill');
  assert.match(deltaLines[0], /"Hello"/);
  assert.match(deltaLines[1], /" world"/);
});

// =========================================================================
// REGRESSION (eb1786 cross-turn pollution).
//
// turnState (blockMap + modeMap) lives for the WHOLE request, but a single
// request runs many assistant turns (every tool_use loop iteration is its own
// assistant message whose content blocks re-number from index 0). The maps are
// keyed by block INDEX, so without a turn-boundary reset the previous turn's
// index-0 state leaks into the next turn:
//
//   - eb1786 routed the snapshot path through normalizeStreamDelta, which locks
//     'snapshot' mode whenever incoming.startsWith(previous) — TRUE for every
//     normal turn end (snapshot === accumulated). 'snapshot' mode is an absorber
//     state: the next turn's genuine deltas hit the correction branch and are
//     dropped (novel=''), producing the fragmented thinking the user saw
//     ("--if}", "ifconstifreturn}", "constifprev" — space/char loss + gaps).
//   - A stale accumulator left in the map also makes the tail-fill snapshot
//     re-emit a whole block, i.e. duplicated text.
//
// The fix resets the per-block maps at each message_start. Keep these green.
// =========================================================================

test('REGRESSION (eb1786): second assistant turn reusing thinking index 0 streams intact (not swallowed by prior-turn snapshot mode)', () => {
  const state = makeTurnState(true);

  const captured = captureStdout(() => {
    // ---- Turn 1: message_start -> thinking deltas -> assistant snapshot + tool_use ----
    processStreamEvent(
      { type: 'stream_event', event: { type: 'message_start', message: { usage: {} } } },
      state,
    );
    state.hasStreamEvents = true;
    processStreamEvent(
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0,
        delta: { type: 'thinking_delta', thinking: 'Analyzing' } } },
      state,
    );
    processStreamEvent(
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0,
        delta: { type: 'thinking_delta', thinking: ' the code' } } },
      state,
    );
    // Final assistant snapshot for turn 1 (thinking === accumulated) + tool_use.
    // Pre-fix this locked thinking:0 into 'snapshot' mode for the rest of the request.
    processMessageContent(
      { type: 'assistant', message: { content: [
        { type: 'thinking', thinking: 'Analyzing the code' },
        { type: 'tool_use', id: 't1', name: 'Read', input: {} },
      ] } },
      state,
    );

    // ---- Turn 2: a NEW assistant message_start, same block index 0 ----
    processStreamEvent(
      { type: 'stream_event', event: { type: 'message_start', message: { usage: {} } } },
      state,
    );
    processStreamEvent(
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0,
        delta: { type: 'thinking_delta', thinking: 'Now I' } } },
      state,
    );
    processStreamEvent(
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0,
        delta: { type: 'thinking_delta', thinking: ' understand' } } },
      state,
    );
  });

  const emitted = tagLines(captured, '[THINKING_DELTA]')
    .map((line) => JSON.parse(line.replace(/^\[THINKING_DELTA\]\s+/, '').trim()))
    .join('');

  // Pre-fix: Turn 2 deltas were dropped (snapshot-mode absorber) -> emitted ===
  // 'Analyzing the code'. The new turn's thinking simply vanished / fragmented.
  assert.equal(
    emitted,
    'Analyzing the codeNow I understand',
    `Turn 2 thinking must stream intact across the tool_use boundary; got "${emitted}"`,
  );
});

test('REGRESSION (eb1786): second assistant turn reusing text index 0 streams intact', () => {
  const state = makeTurnState(true);

  const captured = captureStdout(() => {
    // ---- Turn 1 ----
    processStreamEvent(
      { type: 'stream_event', event: { type: 'message_start', message: { usage: {} } } },
      state,
    );
    state.hasStreamEvents = true;
    processStreamEvent(
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0,
        delta: { type: 'text_delta', text: 'First turn answer' } } },
      state,
    );
    processMessageContent(
      { type: 'assistant', message: { content: [
        { type: 'text', text: 'First turn answer' },
        { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
      ] } },
      state,
    );

    // ---- Turn 2: same text block index 0, brand-new content ----
    processStreamEvent(
      { type: 'stream_event', event: { type: 'message_start', message: { usage: {} } } },
      state,
    );
    for (const fragment of ['Let me ', 'check the ', 'logic.']) {
      processStreamEvent(
        { type: 'stream_event', event: { type: 'content_block_delta', index: 0,
          delta: { type: 'text_delta', text: fragment } } },
        state,
      );
    }
    // Turn 2 final snapshot (text === accumulated). Must NOT re-emit (no duplication).
    processMessageContent(
      { type: 'assistant', message: { content: [
        { type: 'text', text: 'Let me check the logic.' },
      ] } },
      state,
    );
  });

  const payloads = tagLines(captured, '[CONTENT_DELTA]')
    .map((line) => JSON.parse(line.replace(/^\[CONTENT_DELTA\]\s+/, '').trim()));
  const emitted = payloads.join('');

  assert.equal(
    emitted,
    'First turn answerLet me check the logic.',
    `Turn 2 text must stream intact and exactly once; got "${emitted}"`,
  );
  // No single delta may be the whole turn-2 block (that would be the duplicate emit).
  assert.ok(
    !payloads.includes('Let me check the logic.'),
    `snapshot must not re-emit the whole turn-2 block; payloads: ${JSON.stringify(payloads)}`,
  );
});

test('REGRESSION (eb1786): message_start reset preserves cross-turn usage accumulation', () => {
  // The fix clears block maps at message_start but must NOT touch accumulatedUsage,
  // which carries across all turns of a multi-turn tool_use run (mergeUsage keeps
  // output_tokens from prior turns and takes the latest positive input_tokens).
  const state = makeTurnState(true);

  // Turn 1
  processStreamEvent(
    { type: 'stream_event', event: { type: 'message_start', message: { usage: { input_tokens: 10 } } } },
    state,
  );
  processStreamEvent(
    { type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 20 } } },
    state,
  );
  // Turn 2 — message_start is where the block-map reset fires.
  processStreamEvent(
    { type: 'stream_event', event: { type: 'message_start', message: { usage: { input_tokens: 8 } } } },
    state,
  );

  assert.equal(state.accumulatedUsage?.output_tokens, 20, 'prior-turn output_tokens must survive the reset');
  assert.equal(state.accumulatedUsage?.input_tokens, 8, 'input_tokens follows mergeUsage latest-value semantics');
});

// =========================================================================
// BLOCK_RESET SIGNAL TESTS.
//
// message_start now emits a [BLOCK_RESET] signal to notify frontend that
// streaming content refs should be cleared. This prevents cross-turn
// content merging when a new assistant message starts within an ongoing
// stream (e.g., after a tool_use loop iteration).
// =========================================================================

test('BLOCK_RESET: message_start emits [BLOCK_RESET] signal before subsequent deltas', () => {
  const state = makeTurnState(true);

  const captured = captureStdout(() => {
    // message_start should emit BLOCK_RESET BEFORE any deltas
    processStreamEvent(
      { type: 'stream_event', event: { type: 'message_start', message: { usage: {} } } },
      state,
    );
    // Subsequent deltas arrive
    processStreamEvent(
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0,
        delta: { type: 'thinking_delta', thinking: 'New thinking' } } },
      state,
    );
  });

  const blockResetLines = tagLines(captured, '[BLOCK_RESET]');
  const thinkingDeltaLines = tagLines(captured, '[THINKING_DELTA]');

  // BLOCK_RESET must be emitted exactly once at message_start
  assert.equal(blockResetLines.length, 1, 'message_start must emit one [BLOCK_RESET]');
  // Thinking delta must be emitted after BLOCK_RESET
  assert.equal(thinkingDeltaLines.length, 1, 'thinking delta must be emitted');

  // Verify ordering: BLOCK_RESET comes before THINKING_DELTA
  const blockResetIdx = captured.findIndex((line) => line.startsWith('[BLOCK_RESET]'));
  const thinkingDeltaIdx = captured.findIndex((line) => line.startsWith('[THINKING_DELTA]'));
  assert.ok(blockResetIdx < thinkingDeltaIdx, 'BLOCK_RESET must come before subsequent deltas');
});

test('BLOCK_RESET: not emitted when streaming is disabled', () => {
  const state = makeTurnState(false); // streamingEnabled = false

  const captured = captureStdout(() => {
    processStreamEvent(
      { type: 'stream_event', event: { type: 'message_start', message: { usage: {} } } },
      state,
    );
  });

  const blockResetLines = tagLines(captured, '[BLOCK_RESET]');
  assert.equal(blockResetLines.length, 0, 'BLOCK_RESET must not be emitted when streaming is disabled');
});

test('BLOCK_RESET: emitted at each message_start in multi-turn tool_use loop', () => {
  const state = makeTurnState(true);

  const captured = captureStdout(() => {
    // Turn 1 message_start
    processStreamEvent(
      { type: 'stream_event', event: { type: 'message_start', message: { usage: {} } } },
      state,
    );
    state.hasStreamEvents = true;
    processStreamEvent(
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0,
        delta: { type: 'thinking_delta', thinking: 'Turn 1' } } },
      state,
    );

    // Turn 2 message_start (after tool_use loop iteration)
    processStreamEvent(
      { type: 'stream_event', event: { type: 'message_start', message: { usage: {} } } },
      state,
    );
    processStreamEvent(
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0,
        delta: { type: 'thinking_delta', thinking: 'Turn 2' } } },
      state,
    );
  });

  const blockResetLines = tagLines(captured, '[BLOCK_RESET]');
  assert.equal(blockResetLines.length, 2, 'BLOCK_RESET must be emitted at each message_start in multi-turn loop');
});

// =========================================================================
// REGRESSION (issue #1371 — duplicate-leading-char absorber lock).
//
// Pre-fix: computeNovelDelta's `incoming.startsWith(previous)` branch
// unconditionally locked the block into 'snapshot' mode, EVEN WHEN the
// computed novel slice was empty (incoming === previous). That ambiguous
// signal — far more often a coincidental duplicate from an incremental
// provider (repeated characters like "刚刚", "谢谢", "慢慢", or any
// tokenizer that emits the same delta twice) than an actual snapshot
// heartbeat — flipped the absorber on, and every following genuine
// incremental delta hit the snapshot-mode correction branch and was
// silently swallowed. User-visible: only the first character of the reply
// rendered. Keep these green.
// =========================================================================

test('REGRESSION (#1371): duplicate-leading-char incremental stream "刚","刚","我","在" streams every char', () => {
  // The exact reproduction from the bug report. "刚刚我在" — the first two
  // deltas are identical ("刚"), then truly novel content follows. Pre-fix
  // the second "刚" locked snapshot mode and the rest of the message was
  // absorbed. After the fix, the second "刚" is recognised as zero-novel
  // and mode stays unconfirmed, so subsequent incremental deltas flow.
  const state = makeTurnState(true);

  const captured = captureStdout(() => {
    for (const fragment of ['刚', '刚', '我', '在']) {
      processStreamEvent(
        {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: fragment },
          },
        },
        state,
      );
    }
  });

  const emitted = tagLines(captured, '[CONTENT_DELTA]')
    .map((line) => JSON.parse(line.replace(/^\[CONTENT_DELTA\]\s+/, '').trim()))
    .join('');

  assert.equal(emitted, '刚刚我在', `expected full stream "刚刚我在", got "${emitted}"`);
  assert.equal(state.lastAssistantContent, '刚刚我在');
});

test('REGRESSION (#1371): repeated-token thinking deltas "谢谢" must not lock absorber and drop later content', () => {
  // Same shape on the thinking channel. A model that starts a chain-of-thought
  // with "谢谢" + further reasoning must not have the reasoning dropped.
  const state = makeTurnState(true);

  const captured = captureStdout(() => {
    for (const fragment of ['谢', '谢', '，让我想想']) {
      processStreamEvent(
        {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'thinking_delta', thinking: fragment },
          },
        },
        state,
      );
    }
  });

  const emitted = tagLines(captured, '[THINKING_DELTA]')
    .map((line) => JSON.parse(line.replace(/^\[THINKING_DELTA\]\s+/, '').trim()))
    .join('');

  assert.equal(emitted, '谢谢，让我想想', `expected full thinking stream, got "${emitted}"`);
  assert.equal(state.lastThinkingContent, '谢谢，让我想想');
});

test('REGRESSION (#1371): forced-prefix CLAUDE.md scenario "咕咕嘎嘎..." streams intact', () => {
  // From the bug report's repro steps: CLAUDE.md forces the model to prefix
  // every reply with "咕咕嘎嘎". The first two deltas duplicate ("咕"), which
  // pre-fix vaporised everything after them.
  const state = makeTurnState(true);

  const captured = captureStdout(() => {
    for (const fragment of ['咕', '咕', '嘎', '嘎', '，我开始处理']) {
      processStreamEvent(
        {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: fragment },
          },
        },
        state,
      );
    }
  });

  const emitted = tagLines(captured, '[CONTENT_DELTA]')
    .map((line) => JSON.parse(line.replace(/^\[CONTENT_DELTA\]\s+/, '').trim()))
    .join('');

  assert.equal(emitted, '咕咕嘎嘎，我开始处理', `expected full reply, got "${emitted}"`);
});

test('REGRESSION (#1371): ambiguous zero-novel duplicate is treated as incremental until a non-empty extension confirms snapshot mode', () => {
  // Documents the tie-breaker introduced by the #1371 fix. When the first
  // ambiguous signal (incoming === previous, novel === '') arrives BEFORE the
  // block's stream mode has been confirmed, we now treat it as an incremental
  // duplicate (emit the delta, do NOT lock snapshot mode). Rationale:
  //   1. Anthropic-standard incremental is the dominant protocol.
  //   2. Real snapshot providers progressively GROW their cumulative content;
  //      sending an identical re-send as the first non-bootstrap delta is not
  //      a documented behavior for any provider we support.
  //   3. The user-visible cost of guessing wrong incremental→snapshot is one
  //      lost character. The cost of guessing wrong snapshot→incremental is
  //      one duplicated character. Both are tiny and self-correcting on the
  //      very next non-empty extension. Whereas the LEGACY behavior (always
  //      lock snapshot) destroyed the entire rest of the message — issue #1371.
  //
  // Once a later delta extends the accumulated content with non-empty novel
  // bytes, snapshot mode locks correctly and corrective rewrites are absorbed
  // — that path is already covered by the
  // "snapshot-mode block absorbs corrective rewrites" test above.
  const state = makeTurnState(true);

  const captured = captureStdout(() => {
    processStreamEvent(
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0,
        delta: { type: 'text_delta', text: 'Hello' } } },
      state,
    );
    // Duplicate before mode confirmation → treated as incremental, emitted.
    processStreamEvent(
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0,
        delta: { type: 'text_delta', text: 'Hello' } } },
      state,
    );
  });

  const emitted = tagLines(captured, '[CONTENT_DELTA]')
    .map((line) => JSON.parse(line.replace(/^\[CONTENT_DELTA\]\s+/, '').trim()))
    .join('');

  assert.equal(emitted, 'HelloHello', `duplicate before mode lock must emit; got "${emitted}"`);
});

test('REGRESSION (#1371) companion: snapshot path absorbs incoming === previous even when mode is unconfirmed', () => {
  // Dual of the stream-path tie-breaker above. The two paths interpret
  // `incoming === previous` in OPPOSITE directions:
  //
  //   • stream path: identical incoming = a real duplicate provider delta →
  //     EMIT (the #1371 fix).
  //   • snapshot path: identical incoming = "nothing new to deliver beyond
  //     what's already accumulated" → ABSORB.
  //
  // This test pins the snapshot side of that contract independently from the
  // cross-turn-pollution tests (eb1786) so a future refactor of those cannot
  // accidentally unlock duplicate snapshot emits.
  //
  // Scenario: a fully-streamed block ('Hello world') is then re-delivered by
  // the assistant snapshot. processMessageContent calls resolveSnapshotDelta
  // which threads origin='snapshot' into the normalizer. Mode is still
  // 'incremental' (locked by the second stream delta), but even if it weren't,
  // origin='snapshot' alone must trigger absorb.
  const state = makeTurnState(true);

  const captured = captureStdout(() => {
    processStreamEvent(
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0,
        delta: { type: 'text_delta', text: 'Hello' } } },
      state,
    );
    processStreamEvent(
      { type: 'stream_event', event: { type: 'content_block_delta', index: 0,
        delta: { type: 'text_delta', text: ' world' } } },
      state,
    );
    state.hasStreamEvents = true;

    // Assistant snapshot carries the full accumulated text. Must absorb —
    // re-emitting would duplicate the entire block in the UI.
    processMessageContent(
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello world' }] } },
      state,
    );
  });

  const deltaLines = tagLines(captured, '[CONTENT_DELTA]');
  const emitted = deltaLines
    .map((line) => JSON.parse(line.replace(/^\[CONTENT_DELTA\]\s+/, '').trim()))
    .join('');

  // Exactly two stream deltas emitted; snapshot replay added nothing.
  assert.equal(deltaLines.length, 2, `snapshot replay must not emit; got ${JSON.stringify(deltaLines)}`);
  assert.equal(emitted, 'Hello world', `accumulated content must remain "Hello world"; got "${emitted}"`);
});

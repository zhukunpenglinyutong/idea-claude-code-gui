// Redirect HOME to a temp CLI-login config BEFORE importing modules that call
// setupApiKey(), so buildRequestContext() does not throw on a credential-less CI
// runner. Must stay the first import (see testing/cli-login-home.js).
import './testing/cli-login-home.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { __testing } from './persistent-query-service.js';
import {
  createScriptedQuery,
  assistantText,
  streamTextDelta,
  messageStart,
  RESULT_OK,
  settleReader,
} from './testing/scripted-query.js';

/**
 * Regression suite for stale-event isolation between turns on a persistent
 * runtime — the "AI answered the previous question" bug (#1410).
 *
 * On a reused runtime the SDK iterator lives across turns, so events the CLI
 * emits after a turn's result message (late snapshots, trailing deltas,
 * stream cleanup) are still in flight when the next turn starts. These tests
 * pin down the intended routing: the perpetual reader (the iterator's ONLY
 * consumer) must absorb those stragglers between turns, and every event of a
 * new turn — including the very first one — must reach that turn's sink.
 *
 * The fake SDK query is a native async generator over a single-slot queue,
 * the same shape as the SDK's readSdkMessages() (see testing/scripted-query.js
 * for why plain-function mocks cannot catch this class of bug).
 */

const OVERRIDES = { settings: { env: {} } };

function baseParams(tag) {
  return {
    sessionId: `session-${tag}`,
    runtimeSessionEpoch: `epoch-${tag}`,
    cwd: process.cwd(),
    streaming: true,
  };
}

test.beforeEach(async () => {
  await __testing.resetState();
});

test.after(async () => {
  await __testing.resetState();
});

test('post-result stragglers from turn 1 are consumed between turns and never reach turn 2', async () => {
  const turn1 = [
    messageStart(),
    streamTextDelta('turn 1 reply'),
    assistantText('turn 1 reply'),
    RESULT_OK,
    // A CLI-initiated follow-up run right after the turn (e.g. a background
    // task notification): its messages arrive after executeTurn already broke
    // out of its loop, and per protocol it closes with its own result.
    assistantText('STALE turn 1 trailing snapshot that must never surface again'),
    streamTextDelta('STALE tail'),
    RESULT_OK,
  ];
  const turn2 = [
    messageStart(),
    streamTextDelta('turn 2 reply'),
    assistantText('turn 2 reply'),
    RESULT_OK,
  ];

  let query;
  __testing.setQueryFn((args) => {
    query = createScriptedQuery(args, [turn1, turn2]);
    return query;
  });

  const params = baseParams('straggler');
  const ctx1 = await __testing.buildRequestContext({ ...params, message: 'first question' }, false, OVERRIDES);
  const runtime = await __testing.acquireRuntime(ctx1);
  const meta1 = { state: null };
  await __testing.executeTurn(runtime, ctx1, meta1);
  assert.equal(meta1.state.lastAssistantContent, 'turn 1 reply');

  // Inter-turn gap: the perpetual reader must drain the stragglers here.
  await settleReader();

  const ctx2 = await __testing.buildRequestContext({ ...params, message: 'second question' }, false, OVERRIDES);
  const runtime2 = await __testing.acquireRuntime(ctx2);
  assert.equal(runtime2, runtime, 'the persistent runtime must be reused across turns');

  const meta2 = { state: null };
  await __testing.executeTurn(runtime2, ctx2, meta2);

  assert.equal(meta2.state.lastAssistantContent, 'turn 2 reply');
  assert.ok(
    !meta2.state.lastAssistantContent.includes('STALE'),
    'previous-turn straggler content must not be re-emitted in the new turn'
  );
});

test('the first event of a new turn is delivered to that turn, never swallowed', async () => {
  // Regression for the abandoned-next() failure mode: a stray consumer left
  // waiting on the iterator between turns would receive (and lose) the new
  // turn's first event. message_start is that first event, and it drives the
  // [BLOCK_RESET] emission — so its arrival is observable on stdout.
  const turn1 = [
    messageStart(),
    streamTextDelta('first answer'),
    assistantText('first answer'),
    RESULT_OK,
  ];
  const turn2 = [
    messageStart(),
    streamTextDelta('Hello'),
    streamTextDelta(' world'),
    assistantText('Hello world'),
    RESULT_OK,
  ];

  __testing.setQueryFn((args) => createScriptedQuery(args, [turn1, turn2]));

  const params = baseParams('first-event');
  const ctx1 = await __testing.buildRequestContext({ ...params, message: 'q1' }, false, OVERRIDES);
  const runtime = await __testing.acquireRuntime(ctx1);
  await __testing.executeTurn(runtime, ctx1, { state: null });

  // Idle inter-turn gap with nothing buffered — the exact scenario where a
  // timed-out drain used to leave an abandoned next() queued on the iterator.
  await settleReader();

  const ctx2 = await __testing.buildRequestContext({ ...params, message: 'q2' }, false, OVERRIDES);
  const runtime2 = await __testing.acquireRuntime(ctx2);
  const meta2 = { state: null };

  const written = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = function capture(chunk, ...rest) {
    written.push(String(chunk));
    return originalWrite.call(this, chunk, ...rest);
  };
  try {
    await __testing.executeTurn(runtime2, ctx2, meta2);
  } finally {
    process.stdout.write = originalWrite;
  }

  assert.ok(
    written.some((line) => line.includes('[BLOCK_RESET]')),
    'turn 2 must observe its message_start (first event) — it drives [BLOCK_RESET]'
  );
  assert.equal(meta2.state.lastAssistantContent, 'Hello world',
    'every delta of the new turn must arrive, starting from the first event');
});

test('a turn ending in is_error leaves the runtime reusable and the next turn clean', async () => {
  const turn1 = [
    { type: 'result', is_error: true, result: 'rate limited' },
    // CLI-initiated follow-up run after the errored result; closes with its
    // own result per protocol.
    assistantText('STALE post-error snapshot'),
    RESULT_OK,
  ];
  const turn2 = [
    messageStart(),
    streamTextDelta('recovered'),
    assistantText('recovered'),
    RESULT_OK,
  ];

  __testing.setQueryFn((args) => createScriptedQuery(args, [turn1, turn2]));

  const params = baseParams('is-error');
  const ctx1 = await __testing.buildRequestContext({ ...params, message: 'q1' }, false, OVERRIDES);
  const runtime = await __testing.acquireRuntime(ctx1);

  await assert.rejects(
    __testing.executeTurn(runtime, ctx1, { state: null }),
    /rate limited/
  );
  assert.equal(runtime.closed, false, 'an is_error result must not tear the runtime down');

  await settleReader();

  const ctx2 = await __testing.buildRequestContext({ ...params, message: 'q2' }, false, OVERRIDES);
  const runtime2 = await __testing.acquireRuntime(ctx2);
  assert.equal(runtime2, runtime, 'the runtime must be reused after an is_error turn');

  const meta2 = { state: null };
  await __testing.executeTurn(runtime2, ctx2, meta2);
  assert.equal(meta2.state.lastAssistantContent, 'recovered');
  assert.ok(!meta2.state.lastAssistantContent.includes('STALE'));
});

test('a new turn waits for an in-flight CLI-initiated turn and never absorbs its result', async () => {
  // Reproduces the "answer to the previous phrase" ratchet trigger: a
  // CLI-initiated run (e.g. a background-task completion notification) is
  // still streaming when the user sends the next message. Without the
  // in-flight gate, the new turn's sink absorbs that run's output and breaks
  // on its result; the real answer then completes unobserved between turns
  // and every later answer shifts back by one.
  const turn1 = [messageStart(), streamTextDelta('answer one'), assistantText('answer one'), RESULT_OK];
  const turn2 = [messageStart(), streamTextDelta('answer two'), assistantText('answer two'), RESULT_OK];

  let query;
  __testing.setQueryFn((args) => {
    query = createScriptedQuery(args, [turn1, turn2]);
    return query;
  });

  const params = baseParams('inflight-gate');
  const ctx1 = await __testing.buildRequestContext({ ...params, message: 'q1' }, false, OVERRIDES);
  const runtime = await __testing.acquireRuntime(ctx1);
  await __testing.executeTurn(runtime, ctx1, { state: null });
  await settleReader();

  // A CLI-initiated run starts between turns: output arrives, no result yet.
  query.channel.enqueue(assistantText('background notification body'));
  await settleReader();
  assert.equal(runtime.cliTurnInFlight, true, 'reader must mark the CLI busy after un-closed output');

  const ctx2 = await __testing.buildRequestContext({ ...params, message: 'q2' }, false, OVERRIDES);
  const meta2 = { state: null };
  const turn2Promise = __testing.executeTurn(runtime, ctx2, meta2);
  await settleReader();

  assert.equal(query.inputs.length, 1,
    'the new turn must not enqueue its user message while a CLI turn is in flight');

  // The in-flight run closes; only now may the new turn proceed.
  query.channel.enqueue(RESULT_OK);
  await settleReader();
  assert.equal(query.inputs.length, 2, 'the gated turn must proceed once the result arrives');

  await turn2Promise;
  assert.equal(meta2.state.lastAssistantContent, 'answer two');
  assert.ok(!meta2.state.lastAssistantContent.includes('background notification'));
});

test('a background success result arriving first in a new turn is skipped, not treated as the turn end', async () => {
  // The boundary straddle the gate cannot see: the background run's closing
  // result is read only AFTER the new turn's sink opened. Consuming it as the
  // new turn's own result would end the turn with empty output and seed the
  // one-behind shift.
  const turn1 = [messageStart(), streamTextDelta('answer one'), assistantText('answer one'), RESULT_OK];
  const turn2 = []; // driven manually below

  let query;
  __testing.setQueryFn((args) => {
    query = createScriptedQuery(args, [turn1, turn2]);
    return query;
  });

  const params = baseParams('foreign-result');
  const ctx1 = await __testing.buildRequestContext({ ...params, message: 'q1' }, false, OVERRIDES);
  const runtime = await __testing.acquireRuntime(ctx1);
  await __testing.executeTurn(runtime, ctx1, { state: null });
  await settleReader();

  const ctx2 = await __testing.buildRequestContext({ ...params, message: 'q2' }, false, OVERRIDES);
  const meta2 = { state: null };
  const turn2Promise = __testing.executeTurn(runtime, ctx2, meta2);
  await settleReader();
  assert.equal(query.inputs.length, 2, 'gate must not trigger: the CLI was quiet at turn start');

  // Foreign result lands in the fresh sink before any of this turn's output.
  query.channel.enqueue({ type: 'result', is_error: false, origin: { kind: 'task-notification' } });
  await settleReader();

  // The real answer follows — the turn must still be alive to receive it.
  query.channel.enqueue(messageStart());
  query.channel.enqueue(streamTextDelta('real answer two'));
  query.channel.enqueue(assistantText('real answer two'));
  query.channel.enqueue(RESULT_OK);

  await turn2Promise;
  assert.equal(meta2.state.lastAssistantContent, 'real answer two',
    'a background success result must not terminate the turn');
});

test('an error result as the first message of a turn still fails the turn (not treated as foreign)', async () => {
  // Immediately-failing requests (auth, rate limit, invalid model) produce a
  // bare error result with no prior output — that is OUR turn's result and
  // must keep surfacing as an error, not be skipped by the foreign check.
  const turn1 = [{ type: 'result', is_error: true, result: 'invalid api key' }];

  __testing.setQueryFn((args) => createScriptedQuery(args, [turn1]));

  const params = baseParams('bare-error');
  const ctx1 = await __testing.buildRequestContext({ ...params, message: 'q1' }, false, OVERRIDES);
  const runtime = await __testing.acquireRuntime(ctx1);

  await assert.rejects(
    __testing.executeTurn(runtime, ctx1, { state: null }),
    /invalid api key/
  );
});

test('a result-only turn completes without waiting for substantive output', async () => {
  const turn1 = [messageStart(), assistantText('answer one'), RESULT_OK];
  const turn2 = [RESULT_OK];

  let query;
  __testing.setQueryFn((args) => {
    query = createScriptedQuery(args, [turn1, turn2]);
    return query;
  });

  const params = baseParams('result-only');
  const ctx1 = await __testing.buildRequestContext({ ...params, message: 'q1' }, false, OVERRIDES);
  const runtime = await __testing.acquireRuntime(ctx1);
  await __testing.executeTurn(runtime, ctx1, { state: null });
  await settleReader();

  const ctx2 = await __testing.buildRequestContext({ ...params, message: 'q2' }, false, OVERRIDES);
  const meta2 = { state: null };
  await __testing.executeTurn(runtime, ctx2, meta2);

  assert.equal(meta2.state.lastAssistantContent, '');
  assert.equal(query.inputs.length, 2);
});

for (const isError of [false, true]) {
  test(`a task-notification ${isError ? 'error' : 'success'} result does not end the active user turn`, { timeout: 5000 }, async () => {
    const turn1 = [messageStart(), assistantText('answer one'), RESULT_OK];
    const turn2 = [
      { type: 'result', is_error: isError, origin: { kind: 'task-notification' } },
      messageStart(),
      assistantText('answer two'),
      { type: 'result', is_error: isError, origin: { kind: 'task-notification' } },
      RESULT_OK,
    ];

    let query;
    __testing.setQueryFn((args) => {
      query = createScriptedQuery(args, [turn1, turn2]);
      return query;
    });

    const params = baseParams('task-result');
    const ctx1 = await __testing.buildRequestContext({ ...params, message: 'q1' }, false, OVERRIDES);
    const runtime = await __testing.acquireRuntime(ctx1);
    await __testing.executeTurn(runtime, ctx1, { state: null });
    await settleReader();

    const ctx2 = await __testing.buildRequestContext({ ...params, message: 'q2' }, false, OVERRIDES);
    const meta2 = { state: null };
    await __testing.executeTurn(runtime, ctx2, meta2);
    assert.equal(query.inputs.length, 2);
    assert.equal(meta2.state.lastAssistantContent, 'answer two');
  });
}

test('abort while gated on an in-flight CLI turn fails the turn instead of hanging', async () => {
  const turn1 = [messageStart(), assistantText('answer one'), RESULT_OK];

  let query;
  __testing.setQueryFn((args) => {
    query = createScriptedQuery(args, [turn1]);
    return query;
  });

  const params = baseParams('gate-abort');
  const ctx1 = await __testing.buildRequestContext({ ...params, message: 'q1' }, false, OVERRIDES);
  const runtime = await __testing.acquireRuntime(ctx1);
  await __testing.executeTurn(runtime, ctx1, { state: null });
  await settleReader();

  // Arm the gate: CLI output with no closing result.
  query.channel.enqueue(assistantText('background run output'));
  await settleReader();

  const ctx2 = await __testing.buildRequestContext({ ...params, message: 'q2' }, false, OVERRIDES);
  const turn2Promise = __testing.executeTurn(runtime, ctx2, { state: null });
  await settleReader();
  assert.equal(query.inputs.length, 1, 'turn must be parked in the gate');

  // User hits stop: dispose resolves the gate, the turn fails fast.
  await __testing.abortCurrentTurn();
  await assert.rejects(turn2Promise, /Turn aborted/);
  assert.equal(runtime.closed, true);
  assert.equal(query.inputs.length, 1, 'the aborted message must never reach the CLI');
});

test('a background-turn tail already in the pipe does not contaminate the next user turn', async () => {
  // The scheduler-race that survives the level-triggered in-flight gate: turn 1
  // ends, then the CLI emits a background turn (assistant + its OWN result,
  // #1305) whose events are already buffered in the pipe — but the reader has
  // not yet been scheduled to consume them into the inter-turn path. Turn 2
  // starts in that window.
  //
  // Without deferring the sink until the pipe is quiet, turn 2 would open its
  // sink, receive the background assistant, then take
  // the background *result* as its own — ending turn 2 before its real answer,
  // which then completes unobserved between turns. Every later answer shifts
  // back by one ("answer to the previous / pre-previous phrase").
  const turn1 = [messageStart(), streamTextDelta('answer ONE'), assistantText('answer ONE'), RESULT_OK];

  let query;
  __testing.setQueryFn((args) => {
    query = createScriptedQuery(args, [turn1]);
    return query;
  });

  const params = baseParams('bg-tail');
  const ctx1 = await __testing.buildRequestContext({ ...params, message: 'q1' }, false, OVERRIDES);
  const runtime = await __testing.acquireRuntime(ctx1);
  const meta1 = { state: null };
  await __testing.executeTurn(runtime, ctx1, meta1);
  assert.equal(meta1.state.lastAssistantContent, 'answer ONE');
  await query.waitForInput(); // consume turn 1's user message from the FIFO tracker

  // A complete CLI-initiated background turn lands in the pipe.
  query.channel.enqueue(assistantText('BACKGROUND task summary — not an answer the user asked for'));
  query.channel.enqueue(RESULT_OK);

  // Turn 2 begins immediately — NO settleReader, so the reader has not drained
  // the background turn yet. executeTurn must defer its sink until quiescent.
  const ctx2 = await __testing.buildRequestContext({ ...params, message: 'q2' }, false, OVERRIDES);
  const runtime2 = await __testing.acquireRuntime(ctx2);
  assert.equal(runtime2, runtime, 'runtime is reused across turns');
  const meta2 = { state: null };
  const turn2 = __testing.executeTurn(runtime2, ctx2, meta2);

  // Deliver turn 2's real answer only AFTER the CLI has read our user message —
  // mirroring real ordering, where a response cannot precede its request.
  await query.waitForInput();
  query.channel.enqueue(messageStart());
  query.channel.enqueue(streamTextDelta('answer TWO'));
  query.channel.enqueue(assistantText('answer TWO'));
  query.channel.enqueue(RESULT_OK);

  await turn2;

  assert.equal(meta2.state.lastAssistantContent, 'answer TWO');
  assert.ok(
    !meta2.state.lastAssistantContent.includes('BACKGROUND'),
    'the background turn must not be attributed to turn 2'
  );
});

test('the perpetual reader is the only query.next() consumer across turns', async () => {
  // Architectural invariant that makes swallowed events impossible: native
  // async generators serve queued next() callers in FIFO order, so ANY second
  // concurrent consumer (a drain, a probe, an abandoned racing read) steals
  // events from the reader. maxInflight > 1 is that second consumer.
  const turn1 = [messageStart(), assistantText('one'), RESULT_OK, assistantText('straggler'), RESULT_OK];
  const turn2 = [messageStart(), assistantText('two'), RESULT_OK];

  let query;
  __testing.setQueryFn((args) => {
    query = createScriptedQuery(args, [turn1, turn2]);
    return query;
  });

  const params = baseParams('single-consumer');
  const ctx1 = await __testing.buildRequestContext({ ...params, message: 'q1' }, false, OVERRIDES);
  const runtime = await __testing.acquireRuntime(ctx1);
  await __testing.executeTurn(runtime, ctx1, { state: null });

  await settleReader();

  const ctx2 = await __testing.buildRequestContext({ ...params, message: 'q2' }, false, OVERRIDES);
  await __testing.executeTurn(await __testing.acquireRuntime(ctx2), ctx2, { state: null });

  assert.ok(query.stats.nextCalls > 0);
  assert.equal(
    query.stats.maxInflight, 1,
    'exactly one consumer may read the SDK iterator; a second one loses events'
  );
});

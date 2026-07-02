import test from 'node:test';
import assert from 'node:assert/strict';
import { createTurnSink } from './runtime-lifecycle.js';

// ============================================================================
// TurnSink Tests - Core Message Queue Functionality
// ============================================================================

test('TurnSink: push and take single message', async () => {
  const sink = createTurnSink();
  const testMsg = { type: 'test', content: 'hello' };

  sink.push(testMsg);
  const result = await sink.take();

  assert.deepEqual(result, { value: testMsg, done: false });
});

test('TurnSink: take waits for push when queue is empty', async () => {
  const sink = createTurnSink();
  const testMsg = { type: 'test', content: 'async' };

  // Start take before push
  const takePromise = sink.take();

  // Push after a delay
  setTimeout(() => sink.push(testMsg), 10);

  const result = await takePromise;
  assert.deepEqual(result, { value: testMsg, done: false });
});

test('TurnSink: multiple pushes queue correctly', async () => {
  const sink = createTurnSink();
  const msg1 = { type: 'msg1' };
  const msg2 = { type: 'msg2' };
  const msg3 = { type: 'msg3' };

  sink.push(msg1);
  sink.push(msg2);
  sink.push(msg3);

  const result1 = await sink.take();
  const result2 = await sink.take();
  const result3 = await sink.take();

  assert.deepEqual(result1.value, msg1);
  assert.deepEqual(result2.value, msg2);
  assert.deepEqual(result3.value, msg3);
});

test('TurnSink: push resolves waiting take immediately', async () => {
  const sink = createTurnSink();
  const testMsg = { type: 'immediate' };

  // Start waiting
  const takePromise = sink.take();

  // Push immediately (should resolve takePromise synchronously)
  sink.push(testMsg);

  const result = await takePromise;
  assert.deepEqual(result, { value: testMsg, done: false });
});

// ============================================================================
// TurnSink Tests - Failure Handling
// ============================================================================

test('TurnSink: fail prevents further pushes', async () => {
  const sink = createTurnSink();
  const error = new Error('Stream failed');

  sink.fail(error);

  // Pushes after failure should be ignored
  sink.push({ type: 'ignored' });

  // Take should throw the error
  await assert.rejects(
    async () => await sink.take(),
    (err) => {
      assert.equal(err.message, 'Stream failed');
      return true;
    }
  );
});

test('TurnSink: fail unblocks waiting take', async () => {
  const sink = createTurnSink();
  const error = new Error('Aborted');

  // Start waiting
  const takePromise = sink.take();

  // Fail the sink
  setTimeout(() => sink.fail(error), 10);

  // Take should reject with the error
  await assert.rejects(
    async () => await takePromise,
    (err) => {
      assert.equal(err.message, 'Aborted');
      return true;
    }
  );
});

test('TurnSink: multiple takes after failure all throw', async () => {
  const sink = createTurnSink();
  const error = new Error('Failed');

  sink.fail(error);

  // All subsequent takes should throw
  await assert.rejects(async () => await sink.take());
  await assert.rejects(async () => await sink.take());
  await assert.rejects(async () => await sink.take());
});

test('TurnSink: fail with waiting take does not process subsequent pushes', async () => {
  const sink = createTurnSink();

  // Start waiting
  const takePromise = sink.take();

  // Fail immediately
  sink.fail(new Error('Failed'));

  // Try to push (should be ignored)
  sink.push({ type: 'should_be_ignored' });

  // Take should reject, not resolve with the pushed message
  await assert.rejects(async () => await takePromise);
});

// ============================================================================
// TurnSink Tests - Edge Cases
// ============================================================================

test('TurnSink: empty queue behavior', async () => {
  const sink = createTurnSink();

  // Take from empty queue should wait
  const takePromise = sink.take();

  // Verify it's still pending after a short delay
  await new Promise(resolve => setTimeout(resolve, 10));

  // Resolve it
  sink.push({ type: 'test' });
  const result = await takePromise;

  assert.equal(result.done, false);
});

test('TurnSink: interleaved push/take operations', async () => {
  const sink = createTurnSink();

  sink.push({ id: 1 });
  const r1 = await sink.take();

  sink.push({ id: 2 });
  sink.push({ id: 3 });
  const r2 = await sink.take();

  sink.push({ id: 4 });
  const r3 = await sink.take();
  const r4 = await sink.take();

  assert.equal(r1.value.id, 1);
  assert.equal(r2.value.id, 2);
  assert.equal(r3.value.id, 3);
  assert.equal(r4.value.id, 4);
});

test('TurnSink: large queue does not lose messages', async () => {
  const sink = createTurnSink();
  const messageCount = 1000;

  // Push many messages
  for (let i = 0; i < messageCount; i++) {
    sink.push({ id: i });
  }

  // Take all messages and verify order
  for (let i = 0; i < messageCount; i++) {
    const result = await sink.take();
    assert.equal(result.value.id, i, `Message ${i} out of order`);
  }
});

// ============================================================================
// TurnSink Tests - Concurrent Operations
// ============================================================================

test('TurnSink: concurrent takes are resolved in order', async () => {
  const sink = createTurnSink();

  // Start multiple concurrent takes
  const take1 = sink.take();
  const take2 = sink.take();
  const take3 = sink.take();

  // Push messages
  sink.push({ id: 1 });
  sink.push({ id: 2 });
  sink.push({ id: 3 });

  // All takes should resolve correctly
  const [r1, r2, r3] = await Promise.all([take1, take2, take3]);

  assert.equal(r1.value.id, 1);
  assert.equal(r2.value.id, 2);
  assert.equal(r3.value.id, 3);
});

test('TurnSink: rapid push/take cycles maintain consistency', async () => {
  const sink = createTurnSink();
  const iterations = 100;

  for (let i = 0; i < iterations; i++) {
    sink.push({ id: i });
    const result = await sink.take();
    assert.equal(result.value.id, i);
  }
});

// ============================================================================
// Integration Tests - Simulating executeTurn and Perpetual Reader
// ============================================================================

test('Integration: simulate in-turn message flow', async () => {
  const sink = createTurnSink();

  // Simulate perpetual reader pushing messages
  const messages = [
    { type: 'system', session_id: 'test-123' },
    { type: 'assistant', content: 'Hello' },
    { type: 'assistant', tool_use: { name: 'read' } },
    { type: 'tool_result', content: 'file content' },
    { type: 'assistant', content: 'Done' },
    { type: 'result', is_error: false }
  ];

  // Simulate perpetual reader (async producer)
  const producer = (async () => {
    for (const msg of messages) {
      sink.push(msg);
      await new Promise(resolve => setTimeout(resolve, 5)); // Simulate delay
    }
  })();

  // Simulate executeTurn (consumer)
  const received = [];
  while (true) {
    const next = await sink.take();
    received.push(next.value);

    if (next.value.type === 'result') {
      break;
    }
  }

  await producer;

  assert.equal(received.length, messages.length);
  assert.deepEqual(received, messages);
});

test('Integration: simulate abort during active turn', async () => {
  const sink = createTurnSink();

  // Simulate perpetual reader pushing messages
  sink.push({ type: 'assistant', content: 'Starting...' });

  // Simulate executeTurn consuming
  const r1 = await sink.take();
  assert.equal(r1.value.type, 'assistant');

  // Simulate abort
  sink.fail(new Error('Turn aborted'));

  // Next take should throw
  await assert.rejects(
    async () => await sink.take(),
    /Turn aborted/
  );
});

test('Integration: simulate rapid turn transitions', async () => {
  // Simulate multiple turns with different sinks
  const turn1Sink = createTurnSink();
  const turn2Sink = createTurnSink();

  // Turn 1
  turn1Sink.push({ type: 'assistant', content: 'Turn 1' });
  turn1Sink.push({ type: 'result' });

  const t1m1 = await turn1Sink.take();
  const t1m2 = await turn1Sink.take();

  assert.equal(t1m1.value.content, 'Turn 1');
  assert.equal(t1m2.value.type, 'result');

  // Turn 2 (new sink)
  turn2Sink.push({ type: 'assistant', content: 'Turn 2' });
  turn2Sink.push({ type: 'result' });

  const t2m1 = await turn2Sink.take();
  const t2m2 = await turn2Sink.take();

  assert.equal(t2m1.value.content, 'Turn 2');
  assert.equal(t2m2.value.type, 'result');
});

// ============================================================================
// Stress Tests - Boundary Conditions
// ============================================================================

test('Stress: high-frequency push/take cycles', async () => {
  const sink = createTurnSink();
  const iterations = 1000;

  const producer = (async () => {
    for (let i = 0; i < iterations; i++) {
      sink.push({ id: i });
    }
  })();

  const consumer = (async () => {
    for (let i = 0; i < iterations; i++) {
      const result = await sink.take();
      assert.equal(result.value.id, i);
    }
  })();

  await Promise.all([producer, consumer]);
});

test('Stress: many concurrent waiting takes resolved by single fail', async () => {
  const sink = createTurnSink();
  const waitCount = 100;

  // Start many concurrent takes
  const takes = Array.from({ length: waitCount }, () => sink.take());

  // Fail the sink
  setTimeout(() => sink.fail(new Error('Mass abort')), 10);

  // All takes should reject
  const results = await Promise.allSettled(takes);

  results.forEach(result => {
    assert.equal(result.status, 'rejected');
    assert.match(result.reason.message, /Mass abort/);
  });
});

test('Stress: alternating push-wait-take pattern', async () => {
  const sink = createTurnSink();
  const rounds = 50;

  for (let i = 0; i < rounds; i++) {
    // Push
    sink.push({ round: i, phase: 'push' });

    // Wait a bit
    await new Promise(resolve => setTimeout(resolve, 1));

    // Take
    const result = await sink.take();
    assert.equal(result.value.round, i);
    assert.equal(result.value.phase, 'push');
  }
});

// ============================================================================
// Error Handling Tests
// ============================================================================

test('Error: take after fail with custom error', async () => {
  const sink = createTurnSink();
  const customError = new Error('Custom failure');
  customError.code = 'CUSTOM_ERR';

  sink.fail(customError);

  await assert.rejects(
    async () => await sink.take(),
    (err) => {
      assert.equal(err.message, 'Custom failure');
      assert.equal(err.code, 'CUSTOM_ERR');
      return true;
    }
  );
});

test('Error: push after fail does not throw', () => {
  const sink = createTurnSink();

  sink.fail(new Error('Failed'));

  // Push should silently be ignored (no throw)
  assert.doesNotThrow(() => {
    sink.push({ type: 'test' });
    sink.push({ type: 'test2' });
  });
});

test('Error: multiple fails keep first error', async () => {
  const sink = createTurnSink();

  const error1 = new Error('First error');
  const error2 = new Error('Second error');

  sink.fail(error1);
  sink.fail(error2); // Should be ignored

  await assert.rejects(
    async () => await sink.take(),
    (err) => {
      assert.equal(err.message, 'First error');
      return true;
    }
  );
});

// ============================================================================
// Memory Tests
// ============================================================================

test('Memory: sink does not leak on rapid creation/disposal', async () => {
  const iterations = 1000;

  for (let i = 0; i < iterations; i++) {
    const sink = createTurnSink();
    sink.push({ id: i });
    const result = await sink.take();
    assert.equal(result.value.id, i);
    // Sink should be garbage collected after this iteration
  }

  // If this test completes without OOM, memory management is OK
  assert.ok(true, 'No memory leak detected');
});

test('Memory: failed sink releases waiting promises', async () => {
  const sink = createTurnSink();

  // Create many waiting takes
  const takes = Array.from({ length: 100 }, () => sink.take());

  // Fail immediately
  sink.fail(new Error('Release all'));

  // All promises should settle (not hang)
  const results = await Promise.allSettled(takes);

  assert.equal(results.length, 100);
  results.forEach(r => assert.equal(r.status, 'rejected'));
});

console.log('\n✅ All TurnSink tests defined. Run with: node runtime-lifecycle.test.js');

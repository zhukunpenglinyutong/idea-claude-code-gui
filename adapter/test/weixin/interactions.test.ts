import { describe, expect, it } from 'vitest';
import { InteractionRegistry, type PendingInteraction } from '../../src/weixin/interactions.js';

function pending(id: string, kind: 'permission' | 'question' | 'plan', askedAt: number): PendingInteraction {
  return { interactionId: id, taskId: 'task-1', kind, askedAt };
}

describe('InteractionRegistry', () => {
  it('registers, finds by kind and takes by id', () => {
    const registry = new InteractionRegistry();
    registry.register(pending('i1', 'permission', 1));
    expect(registry.findKind('permission')?.interactionId).toBe('i1');
    expect(registry.findKind('plan')).toBeUndefined();
    expect(registry.take('i1')?.interactionId).toBe('i1');
    expect(registry.take('i1')).toBeUndefined();
    expect(registry.size).toBe(0);
  });

  it('clears all interactions of a finished task', () => {
    const registry = new InteractionRegistry();
    registry.register(pending('i1', 'permission', 1));
    registry.register({ ...pending('i2', 'plan', 2), taskId: 'task-2' });
    registry.clearForTask('task-1');
    expect(registry.size).toBe(1);
    expect(registry.findKind('plan')?.interactionId).toBe('i2');
  });

  it('bounds the pending map and evicts the oldest', () => {
    const registry = new InteractionRegistry();
    for (let i = 0; i < 70; i += 1) {
      registry.register(pending(`i${i}`, 'permission', i));
    }
    expect(registry.size).toBe(64);
    expect(registry.findKind('permission')?.interactionId).toBe('i6');
  });
});

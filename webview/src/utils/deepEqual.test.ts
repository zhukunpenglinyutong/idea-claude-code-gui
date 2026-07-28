import { describe, expect, it } from 'vitest';
import { deepEqual } from './deepEqual';

describe('deepEqual', () => {
  it('returns true for primitives that are strictly equal', () => {
    expect(deepEqual(1, 1)).toBe(true);
    expect(deepEqual('a', 'a')).toBe(true);
    expect(deepEqual(true, true)).toBe(true);
  });

  it('returns false for primitives that differ', () => {
    expect(deepEqual(1, 2)).toBe(false);
    expect(deepEqual('a', 'b')).toBe(false);
    // No coercion: 1 and '1' are not equal.
    expect(deepEqual(1, '1')).toBe(false);
  });

  it('handles null symmetrically', () => {
    expect(deepEqual(null, null)).toBe(true);
    expect(deepEqual(null, {})).toBe(false);
    expect(deepEqual({}, null)).toBe(false);
  });

  it('treats NaN as not equal (no special-case)', () => {
    expect(deepEqual(NaN, NaN)).toBe(false);
  });

  it('compares arrays element-wise', () => {
    expect(deepEqual([1, 2, 3], [1, 2, 3])).toBe(true);
    expect(deepEqual([1, 2, 3], [1, 2])).toBe(false);
    expect(deepEqual([1, [2]], [1, [2]])).toBe(true);
    expect(deepEqual([1, 2], [2, 1])).toBe(false);
  });

  it('returns false when one side is an array and the other is an object', () => {
    expect(deepEqual([], {})).toBe(false);
    expect(deepEqual([1], { 0: 1 })).toBe(false);
  });

  it('compares objects regardless of key order', () => {
    // The key behavior a JSON.stringify comparison got wrong (false negative):
    // semantically identical payloads with different insertion order must be
    // equal so onTaskEvent dedup does not double-update.
    expect(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
  });

  it('returns false when the key set differs', () => {
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(deepEqual({ a: 1, b: 2 }, { a: 1, c: 2 })).toBe(false);
  });

  it('compares nested structures', () => {
    expect(deepEqual({ a: { b: [1, 2] } }, { a: { b: [1, 2] } })).toBe(true);
    expect(deepEqual({ a: { b: [1, 2] } }, { a: { b: [1, 3] } })).toBe(false);
  });

  it('treats {a:1, b:undefined} as not equal to {a:1}', () => {
    // Documented behavior difference from JSON.stringify (which would call
    // them equal). deepEqual counts the key, so these differ. This is the
    // safe-degradation direction (more re-renders, never a stale skip).
    expect(deepEqual({ a: 1, b: undefined }, { a: 1 })).toBe(false);
  });
});

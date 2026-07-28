/**
 * Structural deep-equality check for JSON-like values.
 *
 * Unlike JSON.stringify comparison, key order in objects does not affect the
 * result, so semantically identical payloads with different insertion order
 * are correctly reported as equal (no false negatives).
 *
 * Intended for small, bounded payloads (e.g. subagent history messages) where
 * a recursive walk is cheaper than re-rendering downstream consumers.
 *
 * Assumes acyclic input (no visited-pair guard): callers feed JSON-derived
 * data (JSON.parse cannot produce cycles), so a WeakSet guard would be pure
 * overhead. Do not pass values that may contain circular references.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return false;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const objA = a as Record<string, unknown>;
  const objB = b as Record<string, unknown>;
  const keysA = Object.keys(objA);
  const keysB = Object.keys(objB);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(objB, key)) return false;
    if (!deepEqual(objA[key], objB[key])) return false;
  }
  return true;
}

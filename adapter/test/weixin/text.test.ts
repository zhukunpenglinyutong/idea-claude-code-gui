import { describe, expect, it } from 'vitest';
import { chunkByCodePoints, segmentText } from '../../src/weixin/text.js';

describe('chunkByCodePoints', () => {
  it('keeps a short text in one chunk', () => {
    expect(chunkByCodePoints('hello', 4000)).toEqual(['hello']);
  });

  it('splits by Unicode code points, not code units', () => {
    const text = 'a'.repeat(4001);
    const chunks = chunkByCodePoints(text, 4000);
    expect(chunks.length).toBe(2);
    expect(chunks[0]?.length).toBe(4000);
    expect(chunks[1]).toBe('a');
  });

  it('never splits a surrogate pair', () => {
    const text = '😀'.repeat(4001);
    const chunks = chunkByCodePoints(text, 4000);
    expect(chunks.length).toBe(2);
    for (const chunk of chunks) {
      expect(chunk.length % 2).toBe(0);
      expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(chunk)).toBe(false);
    }
  });

  it('returns an empty single chunk for empty input', () => {
    expect(chunkByCodePoints('', 4000)).toEqual(['']);
  });
});

describe('segmentText', () => {
  it('keeps a single short reply unlabelled', () => {
    expect(segmentText('hello', 4000)).toEqual(['hello']);
  });

  it('labels multi-segment replies and never exceeds the limit', () => {
    const chunks = segmentText('a'.repeat(9_000), 4000);
    expect(chunks.length).toBe(3);
    expect(chunks[0]).toBe('[1/3] ' + 'a'.repeat(3_994));
    expect(chunks[2]).toBe('[3/3] ' + 'a'.repeat(1_012));
    for (const chunk of chunks) {
      expect(Array.from(chunk).length).toBeLessThanOrEqual(4000);
    }
  });

  it('keeps emoji pairs intact inside labelled segments', () => {
    const chunks = segmentText('😀'.repeat(4_001), 4000);
    for (const chunk of chunks) {
      expect(chunk.length % 2).toBe(0);
    }
  });
});

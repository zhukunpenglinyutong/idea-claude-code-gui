import { describe, expect, it } from 'vitest';
import { sampleAnchorItems } from './MessageAnchorRail';

describe('sampleAnchorItems', () => {
  it('keeps short conversations unchanged', () => {
    const items = [
      { id: 'first', position: 0, preview: '' },
      { id: 'last', position: 0, preview: '' },
    ];

    expect(sampleAnchorItems(items, 30)).toEqual(items);
  });

  it('caps long conversations while retaining first and last anchors', () => {
    const items = Array.from({ length: 1000 }, (_, index) => ({
      id: `message-${index}`,
      position: 0,
      preview: '',
    }));

    const sampled = sampleAnchorItems(items, 30);

    expect(sampled).toHaveLength(30);
    expect(sampled[0].id).toBe('message-0');
    expect(sampled.at(-1)?.id).toBe('message-999');
    expect(new Set(sampled.map((item) => item.id)).size).toBe(30);
  });
});

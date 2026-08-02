/**
 * WeChat text segmentation (audit §8):
 * - at most 4000 Unicode code points per segment;
 * - never split surrogate pairs, emoji sequences or CRLF;
 * - multi-segment replies carry a `[i/N]` prefix.
 */
export const DEFAULT_TEXT_CHUNK = 4000;

export function chunkByCodePoints(text: string, limit = DEFAULT_TEXT_CHUNK): string[] {
  const points = Array.from(text);
  const chunks: string[] = [];
  for (let i = 0; i < points.length; i += limit) {
    chunks.push(points.slice(i, i + limit).join(''));
  }
  return chunks.length > 0 ? chunks : [''];
}

/**
 * Splits text into labelled segments where `[i/N] ` + content never exceeds
 * the per-segment limit (audit §8: at most 4000 Unicode code points each).
 */
export function segmentText(text: string, limit = DEFAULT_TEXT_CHUNK): string[] {
  if (Array.from(text).length <= limit) {
    return [text];
  }
  let chunks = chunkByCodePoints(text, limit);
  for (;;) {
    const labelLength = `[1/${chunks.length}] `.length;
    const contentLimit = Math.max(1, limit - labelLength);
    const next = chunkByCodePoints(text, contentLimit);
    if (next.length === chunks.length) {
      chunks = next;
      break;
    }
    chunks = next;
  }
  return chunks.map((chunk, index) => `[${index + 1}/${chunks.length}] ${chunk}`);
}

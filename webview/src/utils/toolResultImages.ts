import type { ToolResultBlock } from '../types';

export interface ToolResultImage {
  src: string;
  mediaType?: string;
}

/**
 * Extract nested image blocks from a tool_result's content array.
 * Read of an image file (and screenshot-style MCP tools) return
 * `content: [{ type: 'image', source: { type: 'base64', media_type, data } }]`
 * which the tool cards previously dropped entirely.
 */
export function extractToolResultImages(result?: ToolResultBlock | null): ToolResultImage[] {
  if (!result || !Array.isArray(result.content)) return [];

  const images: ToolResultImage[] = [];
  for (const item of result.content) {
    if (!item || typeof item !== 'object') continue;
    const candidate = item as Record<string, unknown>;
    if (candidate.type !== 'image') continue;

    const source = candidate.source as Record<string, unknown> | undefined;
    if (source && typeof source === 'object') {
      if (source.type === 'base64' && typeof source.data === 'string') {
        const mediaType = typeof source.media_type === 'string' ? source.media_type : 'image/png';
        images.push({ src: `data:${mediaType};base64,${source.data}`, mediaType });
      } else if (source.type === 'url' && typeof source.url === 'string') {
        images.push({
          src: source.url,
          mediaType: typeof source.media_type === 'string' ? source.media_type : undefined,
        });
      }
    }
  }
  return images;
}

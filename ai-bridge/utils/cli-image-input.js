/**
 * Shared helpers for CLI engines that accept image attachments.
 *
 * Aligned with desktop-cc-gui `src-tauri/src/engine/cli_image_input.rs`:
 * - Grok: ACP content blocks `{ type: "image", mimeType, data }`
 * - OpenCode: materialise to temp files + `run -f <path>`
 * - Kimi: materialise + path tags + ReadMediaFile instruction
 * - PI / fallback: materialise + Read-tool path injection
 */

import { mkdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

/** Soft per-image cap for base64 → ACP image blocks (decoded bytes). */
export const GROK_MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/**
 * CLI-only text when the user attaches images with empty text.
 * Grok multimodal prompts require at least one text content block.
 * UI should not treat this as user-authored display text.
 */
export const GROK_IMAGE_ONLY_FALLBACK_TEXT = 'Please analyze the attached image(s).';

/** Stable marker separating user-visible text from Kimi CLI-only image injection. */
export const KIMI_IMAGE_INJECTION_MARKER = '\n\n<!-- mossx:kimi-image-attachments -->\n';

const TEMP_IMAGE_SUBDIR = 'cc-gui-cli-images';

/**
 * @param {unknown} mediaType
 * @returns {string}
 */
export function normalizeImageMimeType(mediaType) {
  const mt = typeof mediaType === 'string' ? mediaType.trim().toLowerCase() : '';
  if (mt.startsWith('image/')) return mt;
  return 'image/png';
}

/**
 * Resolve a usable image MIME type from attachment metadata.
 * Returns null when the attachment is explicitly non-image.
 *
 * @param {unknown} mediaTypeHint from mediaType / mimeType fields
 * @param {string|null|undefined} dataUrlMime from data: URL parse
 * @returns {string|null}
 */
export function resolveImageMimeType(mediaTypeHint, dataUrlMime) {
  const hint = typeof mediaTypeHint === 'string' ? mediaTypeHint.trim().toLowerCase() : '';
  if (hint && !hint.startsWith('image/')) {
    return null;
  }
  if (dataUrlMime && typeof dataUrlMime === 'string' && dataUrlMime.startsWith('image/')) {
    return dataUrlMime;
  }
  if (hint.startsWith('image/')) {
    return hint;
  }
  // No media type provided — assume image when caller is materialising
  // vision attachments (UI only attaches images for CLI paste/upload).
  return 'image/png';
}

/**
 * @param {string} mimeType
 * @returns {string} extension without dot
 */
export function extensionForMime(mimeType) {
  const mt = normalizeImageMimeType(mimeType);
  switch (mt) {
    case 'image/jpeg':
    case 'image/jpg':
      return 'jpg';
    case 'image/gif':
      return 'gif';
    case 'image/webp':
      return 'webp';
    case 'image/bmp':
      return 'bmp';
    case 'image/png':
    default:
      return 'png';
  }
}

/**
 * Strip data-url prefix if present; return raw base64 payload.
 * @param {string} data
 * @returns {{ mimeType: string|null, base64: string }|null}
 */
export function parseAttachmentData(data) {
  if (data == null || typeof data !== 'string') return null;
  const trimmed = data.trim();
  if (!trimmed) return null;

  if (trimmed.slice(0, 5).toLowerCase() === 'data:') {
    const rest = trimmed.slice(5);
    const comma = rest.indexOf(',');
    if (comma < 0) return null;
    const meta = rest.slice(0, comma);
    const payload = rest.slice(comma + 1).trim();
    if (!meta.toLowerCase().includes(';base64')) {
      return null;
    }
    const mime = meta.split(';')[0]?.trim() || null;
    if (!payload) return null;
    return {
      mimeType: mime && mime.startsWith('image/') ? mime : null,
      base64: payload,
    };
  }

  return { mimeType: null, base64: trimmed };
}

/**
 * Whether an attachment is treated as an image by the materializer: a local
 * path, or metadata/data that resolves to an image MIME type (mediaType hint,
 * data-URL mime, or the png default when no hint says otherwise). Named after
 * DSH's isImageAttachment. The materializer's skip and the callers' counters
 * must agree on this predicate — a divergent counter misreports delivered
 * attachments as "non-image … not delivered".
 *
 * @param {unknown} att
 * @returns {boolean}
 */
export function isImageAttachment(att) {
  if (!att || typeof att !== 'object') return false;
  if (typeof att.path === 'string' && att.path.trim()) return true;
  const mtHint = typeof att.mediaType === 'string'
    ? att.mediaType
    : (typeof att.mimeType === 'string' ? att.mimeType : '');
  const parsed = parseAttachmentData(att.data);
  if (!parsed) return false;
  return resolveImageMimeType(mtHint, parsed.mimeType) !== null;
}

/**
 * Estimate decoded byte length of base64 without allocating the buffer.
 * @param {string} base64
 * @returns {number}
 */
export function estimateBase64DecodedBytes(base64) {
  if (!base64) return 0;
  const len = base64.length;
  let padding = 0;
  if (base64.endsWith('==')) padding = 2;
  else if (base64.endsWith('=')) padding = 1;
  return Math.max(0, Math.floor((len * 3) / 4) - padding);
}

/**
 * @typedef {{ fileName?: string, name?: string, mediaType?: string, mimeType?: string, data?: string, path?: string }} CliAttachment
 */

/**
 * Materialise image attachments to temp files under os.tmpdir().
 * Non-image entries are skipped. Returns absolute paths (existing or newly written).
 *
 * @param {CliAttachment[]} attachments
 * @param {{ maxBytes?: number }} [options]
 * @returns {Promise<string[]>}
 */
export async function materializeImageAttachments(attachments, options = {}) {
  const maxBytes = options.maxBytes ?? GROK_MAX_IMAGE_BYTES;
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return [];
  }

  const tempDir = path.join(os.tmpdir(), TEMP_IMAGE_SUBDIR);
  // Restrict permissions: chat screenshots must not be readable by other
  // local users on shared machines (mode only applies on creation).
  await mkdir(tempDir, { recursive: true, mode: 0o700 });

  const paths = [];
  // Files written by THIS call: on a mid-loop throw the caller never receives
  // `paths` (its finally-cleanup has nothing), so the helper cleans up after
  // itself before rethrowing.
  const written = [];
  try {
    for (const att of attachments) {
      if (!att || typeof att !== 'object') continue;
      // Same acceptance predicate the counters use — the materializer's skip
      // and the callers' reporting must not diverge.
      if (!isImageAttachment(att)) continue;

      // Already a local path (e.g. codex-style local_image)
      if (typeof att.path === 'string' && att.path.trim()) {
        paths.push(att.path.trim());
        continue;
      }

      const mtHint = typeof att.mediaType === 'string'
        ? att.mediaType
        : (typeof att.mimeType === 'string' ? att.mimeType : '');
      const parsed = parseAttachmentData(att.data);
      const mimeType = resolveImageMimeType(mtHint, parsed?.mimeType);
      if (!mimeType) continue;
      if (!parsed) continue;

      const decodedLen = estimateBase64DecodedBytes(parsed.base64);
      if (decodedLen > maxBytes) {
        console.error(
          `[cli-image] skip oversized image (${decodedLen} > ${maxBytes}): ${att.fileName || att.name || 'attachment'}`
        );
        continue;
      }

      let buffer;
      try {
        buffer = Buffer.from(parsed.base64, 'base64');
      } catch (err) {
        console.error('[cli-image] invalid base64:', err?.message || err);
        continue;
      }
      if (!buffer.length) continue;
      if (buffer.length > maxBytes) {
        console.error(
          `[cli-image] skip oversized decoded image (${buffer.length} > ${maxBytes})`
        );
        continue;
      }

      const ext = extensionForMime(mimeType);
      const uniqueId = crypto.randomUUID();
      let safeName;
      const fileName = att.fileName || att.name;
      if (fileName && typeof fileName === 'string') {
        const baseName = path.basename(fileName).replace(/[^a-zA-Z0-9._-]/g, '_');
        safeName = `${uniqueId}-${baseName}`;
        if (!path.extname(safeName)) {
          safeName = `${safeName}.${ext}`;
        }
      } else {
        safeName = `image-${uniqueId}.${ext}`;
      }

      const filePath = path.join(tempDir, safeName);
      try {
        await writeFile(filePath, buffer, { mode: 0o600 });
        paths.push(filePath);
        written.push(filePath);
      } catch (err) {
        console.error('[cli-image] failed to write temp image:', err?.message || err);
      }
    }
  } catch (err) {
    await cleanupMaterializedImagePaths(written);
    throw err;
  }

  return paths;
}

/**
 * Delete temp files previously created by materializeImageAttachments.
 * Only unlinks files directly inside our temp dir; passthrough user paths
 * (att.path) and anything outside the temp dir are never touched.
 *
 * @param {string[]} paths
 * @returns {Promise<void>}
 */
export async function cleanupMaterializedImagePaths(paths) {
  if (!Array.isArray(paths) || paths.length === 0) return;
  const tempDir = path.join(os.tmpdir(), TEMP_IMAGE_SUBDIR);
  for (const p of paths) {
    if (typeof p !== 'string' || !p) continue;
    if (path.dirname(path.resolve(p)) !== path.resolve(tempDir)) continue;
    try {
      await unlink(p);
    } catch {
      // Already removed or never written — best effort cleanup.
    }
  }
}

/**
 * Build Grok ACP image content blocks from attachments.
 * Returns only image blocks (caller adds text). Skips oversized / invalid.
 *
 * @param {CliAttachment[]} attachments
 * @param {{ maxBytes?: number }} [options]
 * @returns {{ blocks: object[], loaded: number, errors: string[] }}
 */
export function buildGrokImageBlocks(attachments, options = {}) {
  const maxBytes = options.maxBytes ?? GROK_MAX_IMAGE_BYTES;
  const blocks = [];
  const errors = [];
  let loaded = 0;

  if (!Array.isArray(attachments) || attachments.length === 0) {
    return { blocks, loaded, errors };
  }

  for (const att of attachments) {
    if (!att || typeof att !== 'object') continue;
    const label = att.fileName || att.name || 'attachment';
    const mtHint = typeof att.mediaType === 'string'
      ? att.mediaType
      : (typeof att.mimeType === 'string' ? att.mimeType : '');

    const parsed = parseAttachmentData(att.data);
    const mimeType = resolveImageMimeType(mtHint, parsed?.mimeType);
    if (!mimeType) {
      continue;
    }
    if (!parsed) {
      // path-only: cannot embed without reading file; leave for path-based CLIs
      if (typeof att.path === 'string' && att.path.trim()) {
        errors.push(`${label}: path-only attachment needs materialize for Grok ACP`);
      }
      continue;
    }

    const decodedLen = estimateBase64DecodedBytes(parsed.base64);
    if (decodedLen > maxBytes) {
      errors.push(`${label}: exceeds ${maxBytes} byte limit (${decodedLen})`);
      continue;
    }

    // Re-encode via Buffer to normalise padding / whitespace
    let base64;
    try {
      const buf = Buffer.from(parsed.base64, 'base64');
      if (!buf.length) {
        errors.push(`${label}: empty image data`);
        continue;
      }
      if (buf.length > maxBytes) {
        errors.push(`${label}: exceeds ${maxBytes} byte limit (${buf.length})`);
        continue;
      }
      base64 = buf.toString('base64');
    } catch (err) {
      errors.push(`${label}: invalid base64 (${err?.message || err})`);
      continue;
    }

    blocks.push({
      type: 'image',
      mimeType,
      data: base64,
    });
    loaded += 1;
  }

  return { blocks, loaded, errors };
}

/**
 * Build Kimi headless prompt with image path tags + ReadMediaFile instruction.
 * @param {string} text
 * @param {string[]} imagePaths
 * @returns {string}
 */
export function buildKimiPromptWithImages(text, imagePaths) {
  if (!Array.isArray(imagePaths) || imagePaths.length === 0) {
    return text || '';
  }

  let out = String(text || '').replace(/\s+$/, '');
  out += KIMI_IMAGE_INJECTION_MARKER;
  out += 'The user attached the following image file(s). ';
  out += 'You MUST call ReadMediaFile on each path below before answering any question about visual content.\n';
  for (let i = 0; i < imagePaths.length; i += 1) {
    const p = imagePaths[i];
    out += `${i + 1}. ${p}\n`;
    out += `<image path="${escapeXmlAttr(p)}"></image>\n`;
  }
  return out;
}

/**
 * Generic path injection for CLIs without native multimodal flags (e.g. PI).
 * Instructs the agent to Read the image files from disk.
 * @param {string} text
 * @param {string[]} imagePaths
 * @returns {string}
 */
export function buildReadPathPromptWithImages(text, imagePaths) {
  if (!Array.isArray(imagePaths) || imagePaths.length === 0) {
    return text || '';
  }

  const refs = imagePaths
    .map((p, idx) => `[Image #${idx + 1}: ${p}]`)
    .join('\n');
  const userText = String(text || '').trim()
    ? String(text)
    : GROK_IMAGE_ONLY_FALLBACK_TEXT;
  return `${refs}\n\nThe user has attached the image(s) above. Please use the Read tool to view them.\n\n${userText}`;
}

function escapeXmlAttr(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Attachment handling service module.
 * Responsible for loading and processing attachments.
 */

import fs from 'fs';
import { readdir, stat as statAsync, unlink } from 'fs/promises';
import path from 'path';
import os from 'os';

// Retain cleanup for image files written by older plugin versions.
const TEMP_IMAGE_SUBDIR = 'cc-gui-images';
// Files older than 24h are removed at daemon startup to bound disk growth.
const TEMP_IMAGE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Read attachment JSON (path specified via CLAUDE_ATTACHMENTS_FILE environment variable).
 * @deprecated Use loadAttachmentsFromStdin instead to avoid file I/O.
 */
export function loadAttachmentsFromEnv() {
  try {
    const filePath = process.env.CLAUDE_ATTACHMENTS_FILE;
    if (!filePath) return [];
    const content = fs.readFileSync(filePath, 'utf8');
    const arr = JSON.parse(content);
    if (Array.isArray(arr)) return arr;
    return [];
  } catch (e) {
    console.error('[ATTACHMENTS] Failed to load attachments:', e.message);
    return [];
  }
}

/**
 * Read attachment data from stdin (async).
 * The Java side sends a JSON-formatted attachment array via stdin, avoiding temporary files.
 * Format: { "attachments": [...], "message": "user message" }
 */
export async function readStdinData() {
  return new Promise((resolve) => {
    // Check if the environment variable indicates stdin should be used
    if (process.env.CLAUDE_USE_STDIN !== 'true') {
      resolve(null);
      return;
    }

    let data = '';
    const timeout = setTimeout(() => {
      resolve(null);
    }, 5000); // 5-second timeout

    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => {
      clearTimeout(timeout);
      if (data.trim()) {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed);
        } catch (e) {
          console.error('[STDIN] Failed to parse stdin JSON:', e.message);
          resolve(null);
        }
      } else {
        resolve(null);
      }
    });
    process.stdin.on('error', (err) => {
      clearTimeout(timeout);
      console.error('[STDIN] Error reading stdin:', err.message);
      resolve(null);
    });

    // Start reading
    process.stdin.resume();
  });
}

/**
 * Load attachments from stdin or environment variable file (supports both methods).
 * Prefers stdin; falls back to file-based loading if stdin data is not available.
 *
 * Supported stdinData formats:
 * 1. Direct array format: [{fileName, mediaType, data}, ...]
 * 2. Wrapped object format: { attachments: [...] }
 */
export async function loadAttachments(stdinData) {
  // Prefer data passed via stdin
  if (stdinData) {
    // Format 1: Direct array format (sent from Java side)
    if (Array.isArray(stdinData)) {
      return stdinData;
    }
    // Format 2: Wrapped object format
    if (Array.isArray(stdinData.attachments)) {
      return stdinData.attachments;
    }
  }

  // Fall back to file-based loading (backward compatible with older versions)
  return loadAttachmentsFromEnv();
}

/**
 * Best-effort cleanup of old temp image files (>24h old). Called at daemon
 * startup so failed/abandoned writes from previous sessions don't accumulate.
 * Errors are swallowed — cleanup is non-critical.
 */
export async function cleanupStaleTempImages() {
  try {
    const tempDir = path.join(os.tmpdir(), TEMP_IMAGE_SUBDIR);
    const entries = await readdir(tempDir).catch(() => null);
    if (!entries) return;
    const now = Date.now();
    await Promise.all(entries.map(async (name) => {
      const filePath = path.join(tempDir, name);
      try {
        const info = await statAsync(filePath);
        if (info.isFile() && now - info.mtimeMs > TEMP_IMAGE_TTL_MS) {
          await unlink(filePath);
        }
      } catch {
        // Ignore individual cleanup failures (file may be in use or already gone).
      }
    }));
  } catch {
    // Cleanup is best-effort.
  }
}

/**
 * Build user message content blocks (supports images and text).
 *
 * Preserve structured image input for every model. Provider aliases do not
 * describe vision capabilities, and replacing images with file paths loses
 * visual input on endpoints that only accept images in user content blocks.
 *
 * @param {Array} attachments - Attachment array
 * @param {string} message - User message text
 * @returns {Array} Content block array
 */
export async function buildContentBlocks(attachments, message) {
  const contentBlocks = [];

  for (const a of attachments) {
    const mt = typeof a.mediaType === 'string' ? a.mediaType : '';
    if (mt.startsWith('image/')) {
      contentBlocks.push({
        type: 'image',
        source: { type: 'base64', media_type: mt, data: a.data }
      });
    } else {
      const name = a.fileName || 'Attachment';
      contentBlocks.push({ type: 'text', text: `[Attachment: ${name}]` });
    }
  }

  let userText = message;
  if (!userText || userText.trim() === '') {
    const totalImages = contentBlocks.filter(b => b.type === 'image').length;
    const textCount = contentBlocks.filter(b => b.type === 'text').length;
    if (totalImages > 0) {
      userText = `[Uploaded ${totalImages} image(s)]`;
    } else if (textCount > 0) {
      userText = `[Uploaded attachment(s)]`;
    } else {
      userText = '[Empty message]';
    }
  }

  contentBlocks.push({ type: 'text', text: userText });

  return contentBlocks;
}

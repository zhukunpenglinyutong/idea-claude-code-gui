/**
 * Session JSONL truncation service.
 *
 * Truncates a Claude session's JSONL file to keep only the first N messages.
 * This is used by the rollback feature to permanently discard messages from
 * the SDK's persisted conversation history.
 *
 * The JSONL format is one JSON object per line, where each line is a message.
 * We read all lines, keep the first `keepCount` lines, and write them back.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

/**
 * Sanitize a working directory path for use as a filename component.
 * Matches the SDK's own sanitization: replaces non-alphanumeric chars
 * with hyphens and truncates to 64 chars.
 */
function sanitizeCwd(cwd) {
  if (!cwd) return '';
  // Normalize Windows backslashes to forward slashes for consistent hashing
  const normalized = cwd.replace(/\\/g, '/');
  return normalized.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 64);
}

/**
 * Truncate a session's JSONL file to keep only the first `keepCount` entries.
 *
 * @param {string} sessionId - The session ID
 * @param {number} keepCount - Number of messages to retain (from the beginning)
 * @param {string|null} cwd - Working directory for the session
 * @returns {object} { success: boolean, originalCount?: number, keptCount?: number, error?: string }
 */
export async function truncateSessionJsonl(sessionId, keepCount, cwd) {
  if (!sessionId) {
    return { success: false, error: 'Missing sessionId' };
  }
  if (typeof keepCount !== 'number' || keepCount < 0) {
    return { success: false, error: 'Invalid keepCount: ' + keepCount };
  }

  // Validate sessionId to prevent path traversal.
  // Session IDs are UUID-like: only alphanumeric characters and hyphens allowed.
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
    return { success: false, error: 'Invalid sessionId format' };
  }

  const sanitizedCwd = sanitizeCwd(cwd);
  const projectsDir = path.join(os.homedir(), '.claude', 'projects', sanitizedCwd);
  const jsonlPath = path.join(projectsDir, `${sessionId}.jsonl`);

  // Defense in depth: ensure the resolved path is still within the projects directory
  const resolvedPath = path.resolve(jsonlPath);
  const resolvedDir = path.resolve(projectsDir);
  if (!resolvedPath.startsWith(resolvedDir + path.sep)) {
    return { success: false, error: 'Path traversal detected' };
  }

  try {
    // Check if file exists
    if (!fs.existsSync(jsonlPath)) {
      return { success: false, error: `Session file not found: ${jsonlPath}` };
    }

    // Read the JSONL file
    const content = fs.readFileSync(jsonlPath, 'utf-8');
    const lines = content.split('\n').filter(line => line.trim().length > 0);

    const originalCount = lines.length;

    if (keepCount >= originalCount) {
      return {
        success: true,
        originalCount,
        keptCount: originalCount,
        message: 'No truncation needed (keepCount >= total messages)',
      };
    }

    // Keep only the first `keepCount` lines
    const truncated = lines.slice(0, keepCount);
    const newContent = truncated.join('\n') + '\n';

    // Write back the truncated file
    fs.writeFileSync(jsonlPath, newContent, 'utf-8');

    return {
      success: true,
      originalCount,
      keptCount: keepCount,
      discardedCount: originalCount - keepCount,
    };
  } catch (error) {
    return {
      success: false,
      error: `Failed to truncate session file: ${error.message}`,
    };
  }
}

// ============================================================================
// CLI entry point (called from channel-manager.js)
// ============================================================================

// Only run when executed directly (not imported as module)
const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMainModule) {
  // This file is not meant to be run directly; it's imported by channel-manager.
  // But provide a fallback for debugging:
  const sessionId = process.argv[2];
  const keepCount = parseInt(process.argv[3], 10);
  const cwd = process.argv[4] || null;

  if (!sessionId || isNaN(keepCount)) {
    console.log(JSON.stringify({
      success: false,
      error: 'Usage: node session-truncate.js <sessionId> <keepCount> [cwd]'
    }));
    process.exit(1);
  }

  try {
    const result = await truncateSessionJsonl(sessionId, keepCount, cwd);
    console.log(JSON.stringify(result));
    process.exit(result.success ? 0 : 1);
  } catch (error) {
    console.log(JSON.stringify({ success: false, error: error.message }));
    process.exit(1);
  }
}

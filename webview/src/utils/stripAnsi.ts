/**
 * Strip ANSI escape sequences from terminal output so colorized CLI output
 * (vitest, tsc, eslint, …) renders as clean text instead of literal garbage
 * like "[41m[1m FAIL [22m[49m".
 *
 * Handles:
 * - CSI sequences: ESC [ <parameter bytes 0x30-0x3F> <intermediate bytes 0x20-0x2F> <final byte 0x40-0x7E>
 * - OSC sequences: ESC ] ... terminated by BEL (0x07) or ST (ESC \)
 * - Any leftover lone ESC control characters
 */

// eslint-disable-next-line no-control-regex
const CSI_REGEX = /\x1b\[[0-?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const OSC_REGEX = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g;
// eslint-disable-next-line no-control-regex
const LONE_ESC_REGEX = /\x1b/g;

export function stripAnsi(text: string): string {
  if (!text || !text.includes('\x1b')) return text;
  return text
    .replace(OSC_REGEX, '')
    .replace(CSI_REGEX, '')
    .replace(LONE_ESC_REGEX, '');
}

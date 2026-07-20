import { describe, expect, it } from 'vitest';
import { parseStandaloneUsageLimitNotice, parseUsageLimitError } from './usageLimitError';

/** Fixed "now": 2026-07-16T10:00:00 local time. */
const NOW = new Date(2026, 6, 16, 10, 0, 0).getTime();

describe('parseUsageLimitError', () => {
  it('returns null for empty input', () => {
    expect(parseUsageLimitError('', NOW)).toBeNull();
  });

  it('returns null for unrelated errors', () => {
    expect(parseUsageLimitError('fetch failed', NOW)).toBeNull();
    expect(parseUsageLimitError('ECONNRESET while sending request', NOW)).toBeNull();
    expect(
      parseUsageLimitError('Claude Code error:\n- Error message: API request failed', NOW),
    ).toBeNull();
  });

  it('does not match generic rate-limit errors', () => {
    expect(
      parseUsageLimitError("This request would exceed your account's rate limit", NOW),
    ).toBeNull();
  });

  it('parses the pipe-epoch format (seconds)', () => {
    const resetSec = Math.floor(NOW / 1000) + 3600;
    const info = parseUsageLimitError(`Claude AI usage limit reached|${resetSec}`, NOW);
    expect(info).not.toBeNull();
    expect(info?.resetAtMs).toBe(resetSec * 1000);
  });

  it('parses the pipe-epoch format (milliseconds)', () => {
    const resetMs = NOW + 3600_000;
    const info = parseUsageLimitError(`Claude AI usage limit reached|${resetMs}`, NOW);
    expect(info?.resetAtMs).toBe(resetMs);
  });

  it('finds the pipe-epoch format embedded in a larger error payload', () => {
    const resetSec = Math.floor(NOW / 1000) + 1800;
    const text = [
      'Claude Code error:',
      `- Error message: Claude AI usage limit reached|${resetSec}`,
      '- Current API Key source: Not configured',
    ].join('\n');
    const info = parseUsageLimitError(text, NOW);
    expect(info?.resetAtMs).toBe(resetSec * 1000);
  });

  it('detects "5-hour limit reached" with an am/pm reset time later today', () => {
    // NOW is 10:00 local, so "resets 3pm" is 15:00 today.
    const info = parseUsageLimitError('5-hour limit reached ∙ resets 3pm', NOW);
    expect(info).not.toBeNull();
    expect(info?.resetAtMs).toBe(new Date(2026, 6, 16, 15, 0, 0).getTime());
  });

  it('rolls an already-passed reset time over to tomorrow', () => {
    // NOW is 10:00 local, so "resets 3am" means 03:00 the next day.
    const info = parseUsageLimitError('5-hour limit reached ∙ resets 3am', NOW);
    expect(info?.resetAtMs).toBe(new Date(2026, 6, 17, 3, 0, 0).getTime());
  });

  it('parses "resets at h:mm(am|pm)" with minutes', () => {
    const info = parseUsageLimitError('Session limit reached ∙ resets at 11:30pm', NOW);
    expect(info?.resetAtMs).toBe(new Date(2026, 6, 16, 23, 30, 0).getTime());
  });

  it('parses 24-hour reset times', () => {
    const info = parseUsageLimitError('Weekly limit reached ∙ resets 14:30', NOW);
    expect(info?.resetAtMs).toBe(new Date(2026, 6, 16, 14, 30, 0).getTime());
  });

  it('handles 12am and 12pm correctly', () => {
    expect(
      parseUsageLimitError('usage limit reached, resets 12am', NOW)?.resetAtMs,
    ).toBe(new Date(2026, 6, 17, 0, 0, 0).getTime());
    expect(
      parseUsageLimitError('usage limit reached, resets 12pm', NOW)?.resetAtMs,
    ).toBe(new Date(2026, 6, 16, 12, 0, 0).getTime());
  });

  it('returns null resetAtMs when the limit error carries no parsable time', () => {
    const info = parseUsageLimitError("You've reached your usage limit.", NOW);
    expect(info).not.toBeNull();
    expect(info?.resetAtMs).toBeNull();
  });

  // Real-world formats observed in the wild (Claude Code CLI, 2026):
  it('parses the real session-limit message with timezone suffix', () => {
    const info = parseUsageLimitError(
      "You've hit your session limit ∙ resets 4:30pm (Europe/Warsaw)",
      NOW,
    );
    expect(info).not.toBeNull();
    expect(info?.resetAtMs).toBe(new Date(2026, 6, 16, 16, 30, 0).getTime());
  });

  it('parses the real weekly-limit message', () => {
    const info = parseUsageLimitError(
      "You've hit your weekly limit ∙ resets 5pm (Europe/Warsaw)",
      NOW,
    );
    expect(info).not.toBeNull();
    expect(info?.resetAtMs).toBe(new Date(2026, 6, 16, 17, 0, 0).getTime());
  });

  it('parses "You\'ve hit your usage limit" without a time', () => {
    const info = parseUsageLimitError("You've hit your usage limit.", NOW);
    expect(info).not.toBeNull();
    expect(info?.resetAtMs).toBeNull();
  });

  it('prefers the pipe-epoch over a textual time when both are present', () => {
    const resetSec = Math.floor(NOW / 1000) + 7200;
    const info = parseUsageLimitError(
      `Claude AI usage limit reached|${resetSec} (resets 3pm)`,
      NOW,
    );
    expect(info?.resetAtMs).toBe(resetSec * 1000);
  });

  it('ignores absurd epoch values instead of scheduling decades away', () => {
    // Epoch more than ~8 days out is treated as unparsable rather than trusted.
    const farFuture = Math.floor(NOW / 1000) + 60 * 60 * 24 * 30;
    const info = parseUsageLimitError(`Claude AI usage limit reached|${farFuture}`, NOW);
    expect(info).not.toBeNull();
    expect(info?.resetAtMs).toBeNull();
  });

  // Verbatim stderr of a /compact that hit the session limit at 00:09:45 local
  // (session 0d009806): the reset "12:10am" is one minute ahead, separator is
  // U+00B7 MIDDLE DOT (not the U+2219 the assistant notices use), and the text
  // is prefixed by the failing command's own wording.
  it('parses the real failed-compaction stderr with a just-ahead 12:10am reset', () => {
    const justBeforeMidnightReset = new Date(2026, 6, 21, 0, 9, 45).getTime();
    const info = parseUsageLimitError(
      "Error during compaction: You've hit your session limit · resets 12:10am (Europe/Warsaw)",
      justBeforeMidnightReset,
    );
    expect(info).not.toBeNull();
    expect(info?.resetAtMs).toBe(new Date(2026, 6, 21, 0, 10, 0).getTime());
  });

  it('rolls a 12:10am reset seen late in the evening over to the next day', () => {
    const lateEvening = new Date(2026, 6, 20, 23, 50, 0).getTime();
    const info = parseUsageLimitError(
      "Error during compaction: You've hit your session limit · resets 12:10am (Europe/Warsaw)",
      lateEvening,
    );
    expect(info?.resetAtMs).toBe(new Date(2026, 6, 21, 0, 10, 0).getTime());
  });
});

describe('parseStandaloneUsageLimitNotice', () => {
  // Background/workflow turns that hit the limit surface it as a CLI-synthesized
  // ASSISTANT message (model "<synthetic>") whose whole content is the notice
  // line — not as an error-type message. Exact string from a real transcript:
  const REAL_NOTICE = "You've hit your session limit · resets 3:10pm (Europe/Warsaw)";

  it('accepts the real synthetic assistant notice', () => {
    const info = parseStandaloneUsageLimitNotice(REAL_NOTICE, NOW);
    expect(info).not.toBeNull();
    expect(info?.resetAtMs).toBe(new Date(2026, 6, 16, 15, 10, 0).getTime());
  });

  it('accepts a curly-apostrophe variant and surrounding whitespace', () => {
    const info = parseStandaloneUsageLimitNotice(
      '  You’ve hit your weekly limit ∙ resets 5pm (Europe/Warsaw)\n',
      NOW,
    );
    expect(info).not.toBeNull();
    expect(info?.resetAtMs).toBe(new Date(2026, 6, 16, 17, 0, 0).getTime());
  });

  it('accepts a standalone pipe-epoch notice', () => {
    const resetSec = Math.floor(NOW / 1000) + 3600;
    const info = parseStandaloneUsageLimitNotice(`Claude AI usage limit reached|${resetSec}`, NOW);
    expect(info?.resetAtMs).toBe(resetSec * 1000);
  });

  it('rejects prose that merely mentions the limit', () => {
    expect(parseStandaloneUsageLimitNotice(
      "The plugin shows You've hit your session limit · resets 3:10pm when the limit trips.",
      NOW,
    )).toBeNull();
    expect(parseStandaloneUsageLimitNotice(
      "You've hit your session limit · resets 3:10pm (Europe/Warsaw)\nLet me summarize what we did so far.",
      NOW,
    )).toBeNull();
  });

  it('rejects unrelated assistant text', () => {
    expect(parseStandaloneUsageLimitNotice('All 752 tests pass.', NOW)).toBeNull();
    expect(parseStandaloneUsageLimitNotice('', NOW)).toBeNull();
  });
});

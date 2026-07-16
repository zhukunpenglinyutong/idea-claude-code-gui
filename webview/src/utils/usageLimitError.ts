/**
 * Detection of Claude usage-limit errors and extraction of the limit reset time.
 *
 * The Claude CLI reports an exhausted usage window as an error result whose text
 * has historically taken a few shapes:
 *   - `Claude AI usage limit reached|1750366800`                     (pipe + epoch seconds)
 *   - `You've hit your session limit ∙ resets 4:30pm (Europe/Warsaw)` (current CLI)
 *   - `You've hit your weekly limit ∙ resets 5pm (Europe/Warsaw)`     (current CLI)
 *   - `5-hour limit reached ∙ resets 3pm`                            (older phrasing)
 *   - `You've reached your usage limit.`                             (no reset time at all)
 *
 * By the time the text reaches the webview it is embedded in a larger formatted
 * error payload (see ai-bridge `buildConfigErrorPayload`), so all matching is
 * substring-based rather than whole-string.
 *
 * Textual reset times are interpreted in the local timezone — the CLI prints
 * them for the user's clock. If the parse is slightly off, the auto-resume flow
 * self-corrects: resuming too early just yields another limit error, which gets
 * rescheduled.
 */

export interface UsageLimitInfo {
  /**
   * Epoch milliseconds when the limit resets, or null when the error text
   * carried no reset time we could parse (callers should fall back to a
   * fixed retry delay).
   */
  resetAtMs: number | null;
}

/** Phrasings that identify a usage-limit error (deliberately NOT "rate limit"). */
const USAGE_LIMIT_PATTERNS: RegExp[] = [
  /usage limit reached/i,
  /\b\d+[\s-]?hour limit reached/i,
  /\b(session|daily|weekly|monthly) limit reached/i,
  /reached your (usage|\d+[\s-]?hour) limit/i,
  /you['’]?ve hit your (session|daily|weekly|monthly|usage|\d+[\s-]?hour) limit/i,
];

/** Classic CLI format: `... usage limit reached|<epoch seconds or ms>`. */
const PIPE_EPOCH_RE = /limit reached\s*\|\s*(\d{10,13})/i;

/**
 * Human-readable format: `resets 3pm`, `resets at 11:30pm`, `resets 14:30`.
 * A trailing timezone like `(Europe/Warsaw)` is intentionally ignored: the CLI
 * prints the reset time in the machine's own timezone, which is also the
 * IDE's local timezone, so local interpretation is correct.
 */
const TEXT_TIME_RE = /resets?(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i;

// Sanity window for epoch values: anything outside is treated as garbage
// (weekly limits reset at most ~7 days out).
const MAX_FUTURE_MS = 8 * 24 * 60 * 60 * 1000;
const MAX_PAST_MS = 24 * 60 * 60 * 1000;

/**
 * Returns null when `text` is not a usage-limit error; otherwise returns the
 * parsed reset time (or `{ resetAtMs: null }` when the error is recognized but
 * carries no usable time).
 */
export function parseUsageLimitError(
  text: string,
  nowMs: number = Date.now(),
): UsageLimitInfo | null {
  if (!text || !USAGE_LIMIT_PATTERNS.some((re) => re.test(text))) {
    return null;
  }

  const pipeMatch = PIPE_EPOCH_RE.exec(text);
  if (pipeMatch) {
    const raw = Number(pipeMatch[1]);
    const epochMs = pipeMatch[1].length >= 13 ? raw : raw * 1000;
    if (epochMs > nowMs - MAX_PAST_MS && epochMs < nowMs + MAX_FUTURE_MS) {
      return { resetAtMs: epochMs };
    }
    return { resetAtMs: null };
  }

  const timeMatch = TEXT_TIME_RE.exec(text);
  if (timeMatch) {
    const resetAtMs = nextOccurrenceMs(
      Number(timeMatch[1]),
      timeMatch[2] !== undefined ? Number(timeMatch[2]) : 0,
      timeMatch[3],
      nowMs,
    );
    return { resetAtMs };
  }

  return { resetAtMs: null };
}

/**
 * Anchored variant for messages that ARE the notice (nothing else).
 *
 * Background/workflow turns that exhaust the limit surface it as a
 * CLI-synthesized ASSISTANT message (`model: "<synthetic>"`) whose whole
 * content is a single notice line — it never goes through the error path, so
 * substring matching on assistant text would false-positive on ordinary
 * replies that merely QUOTE the notice (e.g. a conversation about this very
 * feature). This parser therefore only accepts a short, single-line text that
 * starts with a known notice phrasing.
 */
const STANDALONE_NOTICE_RE = /^(?:you['’]?ve hit your [^\n]{0,40}\blimit\b|claude ai usage limit reached\s*\|\s*\d{10,13})/i;
const STANDALONE_NOTICE_MAX_CHARS = 160;

export function parseStandaloneUsageLimitNotice(
  text: string,
  nowMs: number = Date.now(),
): UsageLimitInfo | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > STANDALONE_NOTICE_MAX_CHARS ||
    trimmed.includes('\n')
  ) {
    return null;
  }
  if (!STANDALONE_NOTICE_RE.test(trimmed)) return null;
  return parseUsageLimitError(trimmed, nowMs);
}

/**
 * Next local-time occurrence of hour:minute strictly after `nowMs`
 * (today if still ahead, otherwise tomorrow).
 */
function nextOccurrenceMs(
  hourRaw: number,
  minute: number,
  meridiem: string | undefined,
  nowMs: number,
): number | null {
  let hour = hourRaw;
  if (meridiem) {
    if (hourRaw < 1 || hourRaw > 12) return null;
    hour = (hourRaw % 12) + (meridiem.toLowerCase() === 'pm' ? 12 : 0);
  } else if (hourRaw > 23) {
    return null;
  }
  if (minute > 59) return null;

  const now = new Date(nowMs);
  const candidate = new Date(
    now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0,
  );
  if (candidate.getTime() <= nowMs) {
    candidate.setDate(candidate.getDate() + 1);
  }
  return candidate.getTime();
}

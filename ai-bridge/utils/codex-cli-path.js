/**
 * Resolves the user-configured Codex CLI executable, if any.
 *
 * The Java bridge sets CODEX_CODE_PATH when the user has provided a custom
 * path in Settings > Basic. When set, the Codex SDK is told to spawn that
 * binary instead of its bundled CLI via `codexPathOverride`.
 *
 * Returns null when unset/blank so callers can pass the option conditionally.
 */
export function getCodexCliPathOverride() {
  const raw = process.env.CODEX_CODE_PATH;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

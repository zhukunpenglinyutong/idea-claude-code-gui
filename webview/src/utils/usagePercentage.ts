export function clampUsagePercentage(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

/**
 * Whether a usage percentage exceeds the model's context window.
 * Used to disambiguate "exactly 100" from "100 and counting".
 */
export function isOverflowing(percentage: number): boolean {
  return Number.isFinite(percentage) && percentage > 100;
}

/**
 * Format a percentage for display as a label (no decimal places).
 * - 99.4   -> "99%"
 * - 100.0  -> "100%"
 * - 145.6  -> "100%+"
 */
export function formatUsagePercentageLabel(percentage: number): string {
  if (!Number.isFinite(percentage)) return '0%';
  const clamped = Math.max(0, Math.min(100, percentage));
  const rounded = Math.round(clamped);
  return isOverflowing(percentage) ? `${rounded}%+` : `${rounded}%`;
}

/**
 * Format a percentage for tooltip-style display (one decimal place).
 * - 99.4   -> "99.4%"
 * - 100.0  -> "100.0%"
 * - 145.6  -> "100.0%+"
 */
export function formatUsagePercentageTooltip(percentage: number): string {
  if (!Number.isFinite(percentage)) return '0.0%';
  const clamped = Math.max(0, Math.min(100, percentage));
  const rounded = Math.round(clamped * 10) / 10;
  return isOverflowing(percentage) ? `${rounded.toFixed(1)}%+` : `${rounded.toFixed(1)}%`;
}
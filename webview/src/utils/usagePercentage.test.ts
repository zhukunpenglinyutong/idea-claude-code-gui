import { describe, expect, it } from 'vitest';
import { clampUsagePercentage } from './usagePercentage';

describe('clampUsagePercentage', () => {
  it('keeps visual percentages within the supported range', () => {
    expect(clampUsagePercentage(-5)).toBe(0);
    expect(clampUsagePercentage(45.5)).toBe(45.5);
    expect(clampUsagePercentage(144)).toBe(100);
    expect(clampUsagePercentage(Number.NaN)).toBe(0);
    expect(clampUsagePercentage(Number.POSITIVE_INFINITY)).toBe(0);
    expect(clampUsagePercentage(Number.NEGATIVE_INFINITY)).toBe(0);
  });
});

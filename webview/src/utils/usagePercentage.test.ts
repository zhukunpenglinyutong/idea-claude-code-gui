import { describe, expect, it } from 'vitest';
import {
  clampUsagePercentage,
  formatUsagePercentageLabel,
  formatUsagePercentageTooltip,
  isOverflowing,
} from './usagePercentage';

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

describe('isOverflowing', () => {
  it('is true when percentage > 100', () => {
    expect(isOverflowing(100.1)).toBe(true);
    expect(isOverflowing(145.6)).toBe(true);
    expect(isOverflowing(194.6)).toBe(true);
  });
  it('is false when percentage <= 100', () => {
    expect(isOverflowing(100)).toBe(false);
    expect(isOverflowing(99.9)).toBe(false);
    expect(isOverflowing(0)).toBe(false);
  });
  it('is false for non-finite values', () => {
    expect(isOverflowing(Number.NaN)).toBe(false);
    expect(isOverflowing(Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe('formatUsagePercentageLabel', () => {
  it('rounds to integer for normal values', () => {
    expect(formatUsagePercentageLabel(0)).toBe('0%');
    expect(formatUsagePercentageLabel(45.4)).toBe('45%');
    expect(formatUsagePercentageLabel(99.6)).toBe('100%');
  });
  it('adds + suffix when overflowing', () => {
    expect(formatUsagePercentageLabel(100.1)).toBe('100%+');
    expect(formatUsagePercentageLabel(145.6)).toBe('100%+');
    expect(formatUsagePercentageLabel(194.6)).toBe('100%+');
  });
  it('handles invalid values', () => {
    expect(formatUsagePercentageLabel(Number.NaN)).toBe('0%');
    expect(formatUsagePercentageLabel(-5)).toBe('0%');
  });
});

describe('formatUsagePercentageTooltip', () => {
  it('uses one decimal for normal values', () => {
    expect(formatUsagePercentageTooltip(99.4)).toBe('99.4%');
    expect(formatUsagePercentageTooltip(100)).toBe('100.0%');
  });
  it('uses 100.0%+ when overflowing', () => {
    expect(formatUsagePercentageTooltip(100.1)).toBe('100.0%+');
    expect(formatUsagePercentageTooltip(145.6)).toBe('100.0%+');
    expect(formatUsagePercentageTooltip(194.6)).toBe('100.0%+');
  });
});

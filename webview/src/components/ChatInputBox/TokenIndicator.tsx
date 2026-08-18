import { useTranslation } from 'react-i18next';
import type { TokenIndicatorProps } from './types';
import { clampUsagePercentage, formatUsagePercentageLabel, formatUsagePercentageTooltip } from '../../utils/usagePercentage';

/**
 * TokenIndicator - Usage ring progress bar component
 * Implemented using SVG dual-circle approach
 */
export const TokenIndicator = ({
  percentage,
  size = 14,
  usedTokens,
  maxTokens,
}: TokenIndicatorProps) => {
  const { t } = useTranslation();
  const safePercentage = clampUsagePercentage(percentage);
  // Circle radius (accounting for stroke space)
  const radius = (size - 3) / 2;
  const center = size / 2;

  // Circumference
  const circumference = 2 * Math.PI * radius;

  // Calculate offset (fill clockwise from top)
  const strokeOffset = circumference * (1 - safePercentage / 100);

  // Indicator label: integer percentage (no decimal). Adds "+" when overflowing the model window.
  const labelPercentage = formatUsagePercentageLabel(percentage);
  // Tooltip: one decimal place for precision. Adds "+" when overflowing the model window.
  const tooltipPercentage = formatUsagePercentageTooltip(percentage);

  const formatTokens = (value?: number) => {
    if (typeof value !== 'number' || !isFinite(value)) return undefined;
    // Always display capacity in k (thousands) units
    // e.g.: 1,000,000 -> 1000k, 500,000 -> 500k
    if (value >= 1_000) {
      const kValue = value / 1_000;
      // If it's a whole number, don't show decimal point
      return Number.isInteger(kValue) ? `${kValue}k` : `${kValue.toFixed(1)}k`;
    }
    return `${value}`;
  };

  const usedText = formatTokens(usedTokens);
  const maxText = formatTokens(maxTokens);
  const tooltip = usedText && maxText
    ? `${tooltipPercentage} · ${usedText} / ${maxText} ${' '}${t('chat.context')}`
    : t('chat.usagePercentage', { percentage: tooltipPercentage });

  return (
    <div className="token-indicator">
      <div className="token-indicator-wrap">
        <svg
          className="token-indicator-ring"
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
        >
          {/* Background circle */}
          <circle
            className="token-indicator-bg"
            cx={center}
            cy={center}
            r={radius}
          />
          {/* Progress arc */}
          <circle
            className={`token-indicator-fill ${percentage > 100 ? 'overflowing' : ''}`}
            cx={center}
            cy={center}
            r={radius}
            strokeDasharray={circumference}
            strokeDashoffset={strokeOffset}
          />
        </svg>
        {/* Hover tooltip */}
        <div className="token-tooltip">
          {tooltip}
        </div>
      </div>
      <span
        className={`token-percentage-label ${percentage > 100 ? 'overflowing' : ''}`}
      >
        {labelPercentage}
      </span>
    </div>
  );
};

export default TokenIndicator;

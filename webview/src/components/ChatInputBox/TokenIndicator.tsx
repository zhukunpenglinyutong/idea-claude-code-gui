import { useTranslation } from 'react-i18next';
import { ProgressRing } from './ProgressRing';
import type { TokenIndicatorProps } from './types';

export const TokenIndicator = ({
  percentage,
  size = 14,
  usedTokens,
  maxTokens,
}: TokenIndicatorProps) => {
  const { t } = useTranslation();

  // Indicator label: integer percentage (no decimal)
  const labelPercentage = `${Math.round(percentage)}%`;
  // Tooltip: one decimal place for precision
  const tooltipPercentage = `${(Math.round(percentage * 10) / 10).toFixed(1)}%`;

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
        <ProgressRing percent={percentage} size={size} />
        <div className="token-tooltip">{tooltip}</div>
      </div>
      <span className="token-percentage-label">{labelPercentage}</span>
    </div>
  );
};

export default TokenIndicator;

import React from 'react';
import { ProgressRing } from './ProgressRing';

interface LimitRingProps {
  percent: number;
  label: string;
  resetsAt: string | null;
  size?: number;
}

function formatResetTime(resetsAt: string | null): string {
  if (!resetsAt) return '';
  try {
    const d = new Date(resetsAt);
    return d.toLocaleString(undefined, {
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
  } catch {
    return '';
  }
}

function ringColor(percent: number): string {
  if (percent >= 90) return 'var(--limit-ring-danger, #f97316)';
  if (percent >= 70) return 'var(--limit-ring-warn, #eab308)';
  return 'var(--limit-ring-ok, var(--progress-fill))';
}

export const LimitRing: React.FC<LimitRingProps> = ({ percent, label, resetsAt, size = 12 }) => {
  const color = ringColor(percent);
  const resetText = formatResetTime(resetsAt);
  const tooltip = resetText
    ? `${label}: ${Math.round(percent)}% used · Resets ${resetText}`
    : `${label}: ${Math.round(percent)}% used`;

  return (
    <div className="limit-ring">
      <div className="limit-ring-wrap">
        <ProgressRing percent={percent} size={size} strokeColor={color} />
        <div className="limit-ring-tooltip">{tooltip}</div>
      </div>
      <span className="limit-ring-label">{label}</span>
    </div>
  );
};

export default LimitRing;

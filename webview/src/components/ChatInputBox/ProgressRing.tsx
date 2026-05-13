import React from 'react';

interface ProgressRingProps {
  percent: number;
  size?: number;
  strokeColor?: string;
}

export const ProgressRing: React.FC<ProgressRingProps> = ({ percent, size = 12, strokeColor }) => {
  const radius = (size - 3) / 2;
  const center = size / 2;
  const circumference = 2 * Math.PI * radius;
  const strokeOffset = circumference * (1 - Math.min(100, Math.max(0, percent)) / 100);

  return (
    <svg
      className="progress-ring"
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
    >
      <circle className="progress-ring-bg" cx={center} cy={center} r={radius} />
      <circle
        className="progress-ring-fill"
        cx={center}
        cy={center}
        r={radius}
        strokeDasharray={circumference}
        strokeDashoffset={strokeOffset}
        style={strokeColor ? { stroke: strokeColor } : undefined}
      />
    </svg>
  );
};

export default ProgressRing;

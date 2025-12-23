import React from 'react';
import clsx from 'clsx';

const MetricBar = ({ label, value, type = 'cpu', showLabel = true }) => {
  const isHigh = value > 85;

  return (
    <div className="flex items-center gap-2">
      {showLabel && (
        <span className="text-text-muted text-xs w-8 uppercase">{label}</span>
      )}
      <div className="flex-1 metric-bar">
        <div
          className={clsx('metric-bar-fill', type, isHigh && 'high')}
          style={{ width: `${Math.min(value, 100)}%` }}
        />
      </div>
      <span className={clsx(
        'text-xs w-9 text-right font-mono',
        isHigh ? 'text-status-error' : 'text-text-secondary'
      )}>
        {value.toFixed(0)}%
      </span>
    </div>
  );
};

export default MetricBar;

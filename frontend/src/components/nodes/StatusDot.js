import React from 'react';
import clsx from 'clsx';

const StatusDot = ({ status = 'online', size = 'md' }) => {
  const sizeClasses = {
    sm: 'w-1.5 h-1.5',
    md: 'w-2 h-2',
    lg: 'w-3 h-3',
  };

  return (
    <span
      className={clsx(
        'rounded-full inline-block',
        sizeClasses[size],
        {
          'bg-status-online shadow-[0_0_6px_var(--status-online)]': status === 'online',
          'bg-status-warning shadow-[0_0_6px_var(--status-warning)]': status === 'warning',
          'bg-status-error shadow-[0_0_6px_var(--status-error)] animate-pulse': status === 'error',
          'bg-status-offline': status === 'offline',
          'bg-status-busy shadow-[0_0_6px_var(--status-busy)]': status === 'busy',
        }
      )}
    />
  );
};

export default StatusDot;

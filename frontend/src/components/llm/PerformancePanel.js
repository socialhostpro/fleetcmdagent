import React from 'react';
import clsx from 'clsx';
import { Activity, Zap, Clock, Cpu, MemoryStick } from 'lucide-react';

/**
 * PerformancePanel - Displays LLM performance metrics
 *
 * Shows tokens per second, latency, memory usage, and GPU utilization.
 */
const PerformancePanel = ({
  metrics = {},
  isStreaming = false,
  className
}) => {
  const {
    tokens_per_second = 0,
    latency_ms = 0,
    memory_mb = 0,
    gpu_utilization = null,
    total_tokens = 0,
    generation_time = 0
  } = metrics;

  return (
    <div className={clsx('grid grid-cols-2 lg:grid-cols-4 gap-3', className)}>
      {/* Tokens per Second */}
      <MetricCard
        icon={Zap}
        label="Tokens/sec"
        value={tokens_per_second.toFixed(1)}
        unit="t/s"
        status={tokens_per_second > 20 ? 'good' : tokens_per_second > 10 ? 'warning' : 'poor'}
        isActive={isStreaming}
      />

      {/* Latency */}
      <MetricCard
        icon={Clock}
        label="Latency"
        value={latency_ms.toFixed(0)}
        unit="ms"
        status={latency_ms < 100 ? 'good' : latency_ms < 500 ? 'warning' : 'poor'}
      />

      {/* Memory */}
      <MetricCard
        icon={MemoryStick}
        label="GPU Memory"
        value={(memory_mb / 1024).toFixed(1)}
        unit="GB"
        status={memory_mb < 4096 ? 'good' : memory_mb < 8192 ? 'warning' : 'poor'}
      />

      {/* Total Tokens */}
      <MetricCard
        icon={Activity}
        label="Total Tokens"
        value={total_tokens}
        unit="tokens"
        status="neutral"
      />

      {/* GPU Utilization (if available) */}
      {gpu_utilization !== null && (
        <MetricCard
          icon={Cpu}
          label="GPU Util"
          value={gpu_utilization.toFixed(0)}
          unit="%"
          status={gpu_utilization > 80 ? 'good' : gpu_utilization > 50 ? 'warning' : 'poor'}
        />
      )}

      {/* Generation Time */}
      {generation_time > 0 && (
        <MetricCard
          icon={Clock}
          label="Gen Time"
          value={generation_time.toFixed(2)}
          unit="s"
          status="neutral"
        />
      )}
    </div>
  );
};

const MetricCard = ({ icon: Icon, label, value, unit, status, isActive }) => {
  const statusColors = {
    good: 'text-status-online',
    warning: 'text-yellow-400',
    poor: 'text-status-error',
    neutral: 'text-text-primary'
  };

  return (
    <div className={clsx(
      'bg-bg-tertiary rounded-lg p-3 border border-border-subtle',
      isActive && 'ring-1 ring-text-accent/50'
    )}>
      <div className="flex items-center gap-2 mb-2">
        <Icon size={14} className="text-text-muted" />
        <span className="text-xs text-text-muted uppercase tracking-wider">{label}</span>
        {isActive && (
          <span className="w-2 h-2 rounded-full bg-status-online animate-pulse ml-auto" />
        )}
      </div>
      <div className="flex items-baseline gap-1">
        <span className={clsx('text-xl font-bold', statusColors[status])}>
          {value}
        </span>
        <span className="text-xs text-text-muted">{unit}</span>
      </div>
    </div>
  );
};

export default PerformancePanel;

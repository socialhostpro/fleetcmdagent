import React, { memo } from 'react';
import { Handle, Position } from 'reactflow';
import { Cpu, Server, HardDrive, Activity, MoreVertical } from 'lucide-react';
import clsx from 'clsx';
import StatusDot from './StatusDot';

const MiniGauge = ({ label, value, icon: Icon }) => {
  const isHigh = value > 85;
  return (
    <div className="flex flex-col items-center p-2 bg-bg-secondary rounded">
      <Icon size={14} className={clsx(
        isHigh ? 'text-status-error' : 'text-text-muted'
      )} />
      <span className={clsx(
        'text-xs font-mono mt-1',
        isHigh ? 'text-status-error' : 'text-text-primary'
      )}>
        {typeof value === 'number' ? `${value.toFixed(0)}%` : value}
      </span>
      <span className="text-[10px] text-text-muted uppercase">{label}</span>
    </div>
  );
};

const SparkNode = ({ data, selected }) => {
  const {
    node_id = 'DGX SPARK',
    cpu = 0,
    memory = {},
    gpu = {},
    disk = {},
    ip = '192.168.1.100',
    services_count = 0,
    containers_count = 0
  } = data;

  const getNodeStatus = () => {
    if (cpu > 90 || (memory?.percent || 0) > 90) return 'warning';
    return 'online';
  };

  const status = getNodeStatus();

  return (
    <div
      className={clsx(
        'bg-bg-tertiary rounded-lg border-2 border-cluster-spark w-72 transition-all duration-200 glow-spark',
        selected && 'ring-2 ring-text-accent ring-offset-2 ring-offset-bg-primary'
      )}
    >
      <Handle type="target" position={Position.Top} className="!bg-cluster-spark" />

      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle">
        <div className="flex items-center gap-3">
          <StatusDot status={status} size="lg" />
          <div>
            <div className="font-bold text-text-primary">{node_id}</div>
            <div className="text-text-muted text-xs">{ip}</div>
          </div>
        </div>
        <button className="p-1 hover:bg-bg-hover rounded text-text-muted hover:text-text-primary">
          <MoreVertical size={16} />
        </button>
      </div>

      {/* Mini Gauges */}
      <div className="px-4 py-3">
        <div className="grid grid-cols-4 gap-2">
          <MiniGauge label="CPU" value={cpu} icon={Cpu} />
          <MiniGauge label="GPU" value={gpu?.utilization || 0} icon={Activity} />
          <MiniGauge label="RAM" value={memory?.percent || 0} icon={Server} />
          <MiniGauge
            label="TMP"
            value={gpu?.temperature ? `${gpu.temperature}°` : 'N/A'}
            icon={HardDrive}
          />
        </div>
      </div>

      {/* Stats */}
      <div className="px-4 py-2 border-t border-border-subtle text-xs text-text-secondary">
        <div className="flex justify-between">
          <span>Services:</span>
          <span className="text-text-primary font-mono">{services_count} running</span>
        </div>
        <div className="flex justify-between mt-1">
          <span>Containers:</span>
          <span className="text-text-primary font-mono">{containers_count} active</span>
        </div>
      </div>

      <Handle type="source" position={Position.Bottom} className="!bg-cluster-spark" />
    </div>
  );
};

export default memo(SparkNode);

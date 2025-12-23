import React, { memo, useState } from 'react';
import { Handle, Position } from 'reactflow';
import { Zap, MoreVertical, Clock, RefreshCw, Loader2 } from 'lucide-react';
import clsx from 'clsx';
import StatusDot from './StatusDot';
import MetricBar from './MetricBar';

const API_URL = `http://${window.location.hostname}:8765/api`;

const RoamerNode = ({ data, selected }) => {
  const {
    node_id,
    cpu = 0,
    memory = {},
    gpu = {},
    ip,
    is_idle = true,
    current_job = null,
    job_progress = 0,
    eta = null
  } = data;

  const [restarting, setRestarting] = useState(false);

  const handleRestart = async (e) => {
    e.stopPropagation();
    if (!ip || restarting) return;
    if (!window.confirm(`Restart fleet-agent on ${node_id}?`)) return;

    setRestarting(true);
    try {
      const username = localStorage.getItem('jetson_user') || 'jetson';
      const password = localStorage.getItem('jetson_pass') || '';
      await fetch(`${API_URL}/maintenance/restart-agent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ node_ip: ip, username, password }),
      });
    } catch (err) {
      console.error('Restart error:', err);
    } finally {
      setTimeout(() => setRestarting(false), 5000);
    }
  };

  const status = is_idle ? 'offline' : 'busy';

  if (is_idle) {
    // Idle state - simplified display
    return (
      <div
        className={clsx(
          'bg-bg-tertiary rounded-lg border-2 border-dashed border-cluster-roamer w-44 opacity-60 transition-all duration-200',
          selected && 'ring-2 ring-text-accent ring-offset-2 ring-offset-bg-primary opacity-100'
        )}
      >
        <Handle type="target" position={Position.Top} className="!bg-cluster-roamer" />

        <div className="px-3 py-3 text-center">
          <div className="flex items-center justify-center gap-2 mb-2">
            <StatusDot status="offline" />
            <span className="font-semibold text-text-secondary text-sm">{node_id}</span>
          </div>
          <div className="text-text-muted text-xs uppercase tracking-wide">IDLE</div>
          <div className="text-text-muted text-xs mt-1">Ready for work</div>
        </div>

        <Handle type="source" position={Position.Bottom} className="!bg-cluster-roamer" />
      </div>
    );
  }

  // Active state - full display
  return (
    <div
      className={clsx(
        'bg-bg-tertiary rounded-lg border-2 border-cluster-roamer w-52 transition-all duration-200 animate-pulse-slow',
        selected && 'ring-2 ring-text-accent ring-offset-2 ring-offset-bg-primary'
      )}
      style={{ boxShadow: '0 0 15px rgba(0, 170, 255, 0.3)' }}
    >
      <Handle type="target" position={Position.Top} className="!bg-status-busy" />

      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border-subtle">
        <div className="flex items-center gap-2">
          <StatusDot status="busy" />
          <div>
            <div className="font-semibold text-text-primary text-sm">{node_id}</div>
            {current_job && (
              <div className="text-status-busy text-xs font-mono">{current_job}</div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={handleRestart}
            disabled={restarting}
            className={clsx(
              "p-1 rounded transition-colors",
              restarting ? "text-text-accent" : "text-text-muted hover:text-text-accent hover:bg-bg-hover"
            )}
            title="Restart fleet-agent"
          >
            {restarting ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          </button>
          <Zap size={16} className="text-status-busy" />
        </div>
      </div>

      {/* Job Progress */}
      <div className="px-3 py-2">
        <div className="flex items-center justify-between text-xs mb-1">
          <span className="text-text-muted">Progress</span>
          <span className="text-text-primary font-mono">{job_progress}%</span>
        </div>
        <div className="h-2 bg-bg-secondary rounded-full overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-status-busy to-text-accent rounded-full transition-all duration-500"
            style={{ width: `${job_progress}%` }}
          />
        </div>
        {eta && (
          <div className="flex items-center gap-1 mt-1.5 text-xs text-text-muted">
            <Clock size={10} />
            <span>ETA: {eta}</span>
          </div>
        )}
      </div>

      {/* Quick Metrics */}
      <div className="px-3 py-2 border-t border-border-subtle space-y-1">
        <MetricBar label="CPU" value={cpu} type="cpu" />
        <MetricBar label="GPU" value={gpu?.utilization || 0} type="gpu" />
      </div>

      <Handle type="source" position={Position.Bottom} className="!bg-status-busy" />
    </div>
  );
};

export default memo(RoamerNode);

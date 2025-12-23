import React, { useState } from 'react';
import { X, Terminal, FileText, Box, Activity, HardDrive, Trash2 } from 'lucide-react';
import clsx from 'clsx';
import MetricBar from './nodes/MetricBar';
import StatusDot from './nodes/StatusDot';
import DiskCleanupModal from './DiskCleanupModal';

const tabs = [
  { id: 'overview', label: 'Overview', icon: Activity },
  { id: 'containers', label: 'Containers', icon: Box },
  { id: 'disk', label: 'Disk', icon: HardDrive },
  { id: 'logs', label: 'Logs', icon: FileText },
  { id: 'terminal', label: 'Terminal', icon: Terminal },
];

const DetailPanel = ({ node, onClose }) => {
  const [activeTab, setActiveTab] = useState('overview');
  const [showDiskModal, setShowDiskModal] = useState(false);

  if (!node) return null;

  const { data } = node;
  const {
    node_id,
    cpu = 0,
    memory = {},
    gpu = {},
    disk = {},
    timestamp,
    ip,
    cluster,
    services = [],
  } = data;

  const getStatus = () => {
    if (cpu > 90 || (memory?.percent || 0) > 90) return 'warning';
    if ((gpu?.temperature || 0) > 80) return 'error';
    return 'online';
  };

  const formatUptime = () => {
    if (!timestamp) return 'Unknown';
    const lastSeen = new Date(timestamp);
    const now = new Date();
    const diff = now - lastSeen;
    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    return `${Math.floor(diff / 3600000)}h ago`;
  };

  return (
    <div className="w-80 bg-bg-secondary border-l border-border-subtle flex flex-col h-full">
      {/* Header */}
      <div className="p-4 border-b border-border-subtle">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <StatusDot status={getStatus()} size="lg" />
            <div>
              <h2 className="font-bold text-text-primary">{node_id}</h2>
              {ip && <p className="text-text-muted text-xs">{ip}</p>}
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded hover:bg-bg-hover text-text-muted hover:text-text-primary transition-colors"
          >
            <X size={18} />
          </button>
        </div>
        <div className="flex items-center gap-2 text-xs text-text-muted">
          <span className="status-dot online" />
          <span>Online • Last seen {formatUptime()}</span>
        </div>
        {cluster && (
          <div className="mt-2">
            <span className="px-2 py-0.5 text-xs bg-bg-tertiary border border-border-subtle rounded capitalize">
              {cluster} cluster
            </span>
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="flex border-b border-border-subtle">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={clsx(
                'flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs transition-colors',
                activeTab === tab.id
                  ? 'text-text-accent border-b-2 border-text-accent bg-text-accent/5'
                  : 'text-text-muted hover:text-text-secondary'
              )}
            >
              <Icon size={14} />
              <span className="hidden sm:inline">{tab.label}</span>
            </button>
          );
        })}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-4">
        {activeTab === 'overview' && (
          <OverviewTab data={data} />
        )}
        {activeTab === 'containers' && (
          <ContainersTab services={services} />
        )}
        {activeTab === 'disk' && (
          <DiskTab data={data} onOpenCleanup={() => setShowDiskModal(true)} />
        )}
        {activeTab === 'logs' && (
          <LogsTab nodeId={node_id} />
        )}
        {activeTab === 'terminal' && (
          <TerminalTab nodeId={node_id} />
        )}
      </div>

      {/* Disk Cleanup Modal */}
      <DiskCleanupModal
        isOpen={showDiskModal}
        onClose={() => setShowDiskModal(false)}
        nodeId={node_id}
        nodeIp={ip}
      />

      {/* Quick Actions */}
      <div className="p-4 border-t border-border-subtle">
        <div className="grid grid-cols-3 gap-2">
          <button className="flex flex-col items-center gap-1 p-2 rounded-lg bg-bg-tertiary hover:bg-bg-hover text-text-secondary hover:text-text-primary transition-colors">
            <Terminal size={16} />
            <span className="text-xs">Terminal</span>
          </button>
          <button className="flex flex-col items-center gap-1 p-2 rounded-lg bg-bg-tertiary hover:bg-bg-hover text-text-secondary hover:text-text-primary transition-colors">
            <FileText size={16} />
            <span className="text-xs">Logs</span>
          </button>
          <button className="flex flex-col items-center gap-1 p-2 rounded-lg bg-bg-tertiary hover:bg-bg-hover text-text-secondary hover:text-text-primary transition-colors">
            <Activity size={16} />
            <span className="text-xs">Restart</span>
          </button>
        </div>
      </div>
    </div>
  );
};

const OverviewTab = ({ data }) => {
  const { cpu = 0, memory = {}, gpu = {}, disk = {} } = data;

  return (
    <div className="space-y-6">
      {/* System Metrics */}
      <section>
        <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-3">
          System Metrics
        </h3>
        <div className="space-y-3">
          <MetricBar label="CPU" value={cpu} type="cpu" />
          <MetricBar label="GPU" value={gpu?.utilization || 0} type="gpu" />
          <MetricBar label="RAM" value={memory?.percent || 0} type="ram" />
          <MetricBar label="Disk" value={disk?.percent || 0} type="disk" />
        </div>
      </section>

      {/* GPU Details */}
      {gpu && (
        <section>
          <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-3">
            GPU Details
          </h3>
          <div className="bg-bg-tertiary rounded-lg p-3 space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-text-muted">Temperature</span>
              <span className={clsx(
                'font-mono',
                (gpu.temperature || 0) > 75 ? 'text-status-error' : 'text-text-primary'
              )}>
                {gpu.temperature || 'N/A'}°C
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-text-muted">Memory Used</span>
              <span className="text-text-primary font-mono">
                {gpu.memory_used ? `${(gpu.memory_used / 1024).toFixed(1)} GB` : 'N/A'}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-text-muted">Utilization</span>
              <span className="text-text-primary font-mono">{gpu.utilization || 0}%</span>
            </div>
          </div>
        </section>
      )}

      {/* Memory Details */}
      {memory && (
        <section>
          <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-3">
            Memory
          </h3>
          <div className="bg-bg-tertiary rounded-lg p-3 space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-text-muted">Used</span>
              <span className="text-text-primary font-mono">
                {memory.used ? `${(memory.used / 1024 / 1024 / 1024).toFixed(1)} GB` : 'N/A'}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-text-muted">Total</span>
              <span className="text-text-primary font-mono">
                {memory.total ? `${(memory.total / 1024 / 1024 / 1024).toFixed(1)} GB` : 'N/A'}
              </span>
            </div>
          </div>
        </section>
      )}
    </div>
  );
};

const DiskTab = ({ data, onOpenCleanup }) => {
  const { disk = {} } = data;
  const diskPercent = disk?.percent || 0;
  const isDiskHigh = diskPercent > 60;
  const isDiskCritical = diskPercent > 80;

  return (
    <div className="space-y-4">
      {/* Disk Usage */}
      <section>
        <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-3">
          Disk Usage
        </h3>
        <div className="bg-bg-tertiary rounded-lg p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <HardDrive size={18} className={clsx(
                isDiskCritical ? 'text-status-error' :
                isDiskHigh ? 'text-status-warning' : 'text-text-muted'
              )} />
              <span className="text-text-primary font-medium">Root Filesystem</span>
            </div>
            <span className={clsx(
              'font-mono text-lg font-bold',
              isDiskCritical ? 'text-status-error' :
              isDiskHigh ? 'text-status-warning' : 'text-text-primary'
            )}>
              {diskPercent.toFixed(1)}%
            </span>
          </div>

          {/* Progress bar */}
          <div className="h-3 bg-bg-primary rounded-full overflow-hidden mb-3">
            <div
              className={clsx(
                'h-full rounded-full transition-all',
                isDiskCritical ? 'bg-status-error' :
                isDiskHigh ? 'bg-status-warning' : 'bg-status-online'
              )}
              style={{ width: `${diskPercent}%` }}
            />
          </div>

          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-text-muted">Used</p>
              <p className="text-text-primary font-mono">{disk?.used || 'N/A'}</p>
            </div>
            <div>
              <p className="text-text-muted">Available</p>
              <p className="text-status-online font-mono">{disk?.free || 'N/A'}</p>
            </div>
          </div>
        </div>
      </section>

      {/* Status Alert */}
      {isDiskHigh && (
        <section>
          <div className={clsx(
            'rounded-lg p-4 border',
            isDiskCritical
              ? 'bg-status-error/10 border-status-error/20'
              : 'bg-status-warning/10 border-status-warning/20'
          )}>
            <div className="flex items-start gap-3">
              <HardDrive size={20} className={
                isDiskCritical ? 'text-status-error' : 'text-status-warning'
              } />
              <div>
                <h4 className={clsx(
                  'font-medium',
                  isDiskCritical ? 'text-status-error' : 'text-status-warning'
                )}>
                  {isDiskCritical ? 'Critical: Disk Almost Full' : 'Warning: Disk Space Low'}
                </h4>
                <p className="text-sm text-text-secondary mt-1">
                  {isDiskCritical
                    ? 'Disk usage is over 80%. Immediate cleanup recommended to prevent system issues.'
                    : 'Disk usage is over 60%. Consider cleaning up unused files and Docker images.'}
                </p>
              </div>
            </div>
          </div>
        </section>
      )}

      {/* Cleanup Action */}
      <section>
        <button
          onClick={onOpenCleanup}
          className={clsx(
            'w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg font-medium transition-colors',
            isDiskCritical
              ? 'bg-status-error hover:bg-status-error/80 text-white'
              : isDiskHigh
                ? 'bg-status-warning hover:bg-status-warning/80 text-bg-primary'
                : 'bg-bg-tertiary hover:bg-bg-hover text-text-primary border border-border-subtle'
          )}
        >
          <Trash2 size={16} />
          {isDiskCritical ? 'Clean Up Now' : isDiskHigh ? 'Analyze & Clean Disk' : 'Disk Cleanup Tools'}
        </button>
      </section>
    </div>
  );
};

const ContainersTab = ({ services }) => {
  if (!services || services.length === 0) {
    return (
      <div className="text-center text-text-muted py-8">
        <Box size={32} className="mx-auto mb-2 opacity-50" />
        <p className="text-sm">No containers running</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {services.map((service, index) => (
        <div
          key={index}
          className="bg-bg-tertiary border border-border-subtle rounded-lg p-3"
        >
          <div className="flex items-center gap-2 mb-2">
            <StatusDot status="online" size="sm" />
            <span className="font-medium text-text-primary text-sm">{service}</span>
          </div>
          <div className="text-xs text-text-muted">Running</div>
        </div>
      ))}
    </div>
  );
};

const LogsTab = ({ nodeId }) => {
  const [logs, setLogs] = useState([]);
  const [connected, setConnected] = useState(false);
  const wsRef = React.useRef(null);
  const logsEndRef = React.useRef(null);

  React.useEffect(() => {
    const wsUrl = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.hostname}:8765/ws/logs/${nodeId}`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      setLogs(prev => [...prev, { type: 'system', text: `Connected to ${nodeId}` }]);
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'log') {
          setLogs(prev => [...prev.slice(-100), { type: 'log', text: data.data }]);
        }
      } catch {
        setLogs(prev => [...prev.slice(-100), { type: 'log', text: event.data }]);
      }
    };

    ws.onerror = () => {
      setLogs(prev => [...prev, { type: 'error', text: 'Connection error' }]);
    };

    ws.onclose = () => {
      setConnected(false);
      setLogs(prev => [...prev, { type: 'system', text: 'Disconnected' }]);
    };

    return () => ws.close();
  }, [nodeId]);

  React.useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  return (
    <div className="bg-bg-primary rounded-lg p-3 font-mono text-xs h-64 overflow-auto">
      <div className={`mb-2 ${connected ? 'text-status-online' : 'text-status-warning'}`}>
        {connected ? '● Connected' : '○ Connecting...'}
      </div>
      {logs.map((log, i) => (
        <div key={i} className={clsx(
          log.type === 'system' ? 'text-text-muted' :
          log.type === 'error' ? 'text-status-error' : 'text-text-secondary'
        )}>
          {log.text}
        </div>
      ))}
      <div ref={logsEndRef} />
    </div>
  );
};

const TerminalTab = ({ nodeId }) => {
  const [output, setOutput] = useState([]);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const inputRef = React.useRef(null);
  const outputEndRef = React.useRef(null);

  const API_BASE = process.env.REACT_APP_API_URL || 'http://localhost:8765';

  const runCommand = async () => {
    if (!input.trim() || running) return;

    const cmd = input.trim();
    setInput('');
    setOutput(prev => [...prev, { type: 'input', text: `$ ${cmd}` }]);
    setRunning(true);

    try {
      const res = await fetch(`${API_BASE}/api/ssh/exec-node`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ node_id: nodeId, command: cmd })
      });
      const data = await res.json();
      if (data.stdout) {
        setOutput(prev => [...prev, { type: 'output', text: data.stdout }]);
      }
      if (data.stderr) {
        setOutput(prev => [...prev, { type: 'error', text: data.stderr }]);
      }
      if (data.error) {
        setOutput(prev => [...prev, { type: 'error', text: data.error }]);
      }
    } catch (err) {
      setOutput(prev => [...prev, { type: 'error', text: `Error: ${err.message}` }]);
    }
    setRunning(false);
  };

  React.useEffect(() => {
    outputEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [output]);

  return (
    <div className="bg-bg-primary rounded-lg p-3 font-mono text-xs h-64 flex flex-col">
      <div className="flex-1 overflow-auto mb-2">
        <div className="text-text-muted mb-2">Terminal: {nodeId}</div>
        {output.map((line, i) => (
          <div key={i} className={clsx(
            line.type === 'input' ? 'text-status-online' :
            line.type === 'error' ? 'text-status-error' : 'text-text-secondary'
          )} style={{ whiteSpace: 'pre-wrap' }}>
            {line.text}
          </div>
        ))}
        <div ref={outputEndRef} />
      </div>
      <div className="flex items-center gap-2 border-t border-border-subtle pt-2">
        <span className="text-status-online">$</span>
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && runCommand()}
          placeholder={running ? 'Running...' : 'Enter command...'}
          disabled={running}
          className="flex-1 bg-transparent border-none outline-none text-text-primary"
        />
      </div>
    </div>
  );
};

export default DetailPanel;

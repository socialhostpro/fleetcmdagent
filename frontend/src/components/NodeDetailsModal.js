import React, { useState, useEffect, useRef } from 'react';
import {
  X, Server, Cpu, Monitor, Terminal, Activity, HardDrive,
  Wifi, Clock, RefreshCw, Play, Square, Loader2, AlertCircle,
  CheckCircle, Download, Trash2
} from 'lucide-react';
import clsx from 'clsx';

const DEVICE_CONFIGS = {
  spark: { icon: Server, color: '#76b900', label: 'DGX SPARK' },
  agx: { icon: Cpu, color: '#3498db', label: 'AGX XAVIER' },
  windows: { icon: Monitor, color: '#00a4ef', label: 'WINDOWS' },
  linux: { icon: Terminal, color: '#f39c12', label: 'LINUX' },
  unknown: { icon: HardDrive, color: '#666666', label: 'UNKNOWN' },
};

const NodeDetailsModal = ({ host, credentials, onClose, onInstall }) => {
  const [activeTab, setActiveTab] = useState('overview');
  const [terminalOutput, setTerminalOutput] = useState([]);
  const [terminalInput, setTerminalInput] = useState('');
  const [isRunningCommand, setIsRunningCommand] = useState(false);
  const [logs, setLogs] = useState([]);
  const [stats, setStats] = useState(null);
  const [selectedCred, setSelectedCred] = useState('');
  const terminalRef = useRef(null);
  const inputRef = useRef(null);
  const API_URL = `http://${window.location.hostname}:8765`;

  const deviceConfig = DEVICE_CONFIGS[host.device?.type] || DEVICE_CONFIGS.unknown;
  const Icon = deviceConfig.icon;

  useEffect(() => {
    // Load initial data
    if (host.is_fleet_node && host.registered_data) {
      setStats(host.registered_data);
    }
    fetchNodeDetails();
  }, [host.ip]);

  useEffect(() => {
    // Auto-scroll terminal
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [terminalOutput]);

  const fetchNodeDetails = async () => {
    try {
      const res = await fetch(`${API_URL}/api/network/identify/${host.ip}`);
      const data = await res.json();
      if (data && !data.error) {
        setLogs(prev => [...prev, `Scanned ${host.ip}: ${data.services?.length || 0} services found`]);
      }
    } catch (e) {
      console.error('Failed to fetch details:', e);
    }
  };

  const runCommand = async (command) => {
    if (!selectedCred || !command.trim()) return;

    setIsRunningCommand(true);
    setTerminalOutput(prev => [...prev, { type: 'input', text: `$ ${command}` }]);

    try {
      const res = await fetch(`${API_URL}/api/ssh/exec-cred`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          host: host.ip,
          credential_id: selectedCred,
          command: command
        })
      });

      const data = await res.json();

      if (data.stdout) {
        setTerminalOutput(prev => [...prev, { type: 'output', text: data.stdout }]);
      }
      if (data.stderr) {
        setTerminalOutput(prev => [...prev, { type: 'error', text: data.stderr }]);
      }
      if (data.error) {
        setTerminalOutput(prev => [...prev, { type: 'error', text: `Error: ${data.error}` }]);
      }
    } catch (e) {
      setTerminalOutput(prev => [...prev, { type: 'error', text: `Connection error: ${e.message}` }]);
    } finally {
      setIsRunningCommand(false);
      setTerminalInput('');
      inputRef.current?.focus();
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !isRunningCommand) {
      runCommand(terminalInput);
    }
  };

  const quickCommands = [
    { label: 'System Info', cmd: 'uname -a && cat /etc/os-release | head -5' },
    { label: 'Disk Usage', cmd: 'df -h / && echo "" && docker system df 2>/dev/null || true' },
    { label: 'GPU Status', cmd: 'nvidia-smi --query-gpu=name,memory.total,memory.used,utilization.gpu --format=csv 2>/dev/null || echo "No GPU"' },
    { label: 'Docker Status', cmd: 'docker info --format "Containers: {{.Containers}}\\nImages: {{.Images}}\\nSwarm: {{.Swarm.LocalNodeState}}"' },
    { label: 'S3 Mounts', cmd: 'mount | grep s3fs || echo "No S3 mounts"' },
    { label: 'Fleet Agent', cmd: 'systemctl status fleet-agent --no-pager 2>/dev/null || echo "Fleet agent not installed"' },
  ];

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
      <div className="bg-bg-secondary rounded-lg w-full max-w-4xl border border-border-subtle max-h-[90vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="p-4 border-b border-border-subtle flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div
              className="p-3 rounded-lg"
              style={{ backgroundColor: `${deviceConfig.color}20`, color: deviceConfig.color }}
            >
              <Icon size={24} />
            </div>
            <div>
              <h2 className="font-bold text-text-primary text-lg flex items-center gap-2">
                {host.ip}
                {host.is_fleet_node && (
                  <span className="px-2 py-0.5 text-xs bg-cluster-spark/20 text-cluster-spark rounded">
                    FLEET
                  </span>
                )}
              </h2>
              <p className="text-text-muted text-sm">
                {host.name || 'Unknown'} • {host.fleet_node_id || deviceConfig.label}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg hover:bg-bg-hover text-text-muted hover:text-text-primary"
          >
            <X size={20} />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-border-subtle">
          {['overview', 'terminal', 'logs'].map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={clsx(
                'px-4 py-3 text-sm font-medium transition-colors capitalize',
                activeTab === tab
                  ? 'text-text-accent border-b-2 border-text-accent'
                  : 'text-text-muted hover:text-text-primary'
              )}
            >
              {tab}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-4">
          {activeTab === 'overview' && (
            <div className="space-y-4">
              {/* Quick Stats */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <StatCard
                  icon={Wifi}
                  label="Status"
                  value={host.status === 'online' ? 'Online' : 'Offline'}
                  color={host.status === 'online' ? '#22c55e' : '#ef4444'}
                />
                <StatCard
                  icon={Server}
                  label="Device"
                  value={deviceConfig.label}
                  color={deviceConfig.color}
                />
                <StatCard
                  icon={Activity}
                  label="Ports"
                  value={`${host.open_ports?.length || 0} open`}
                  color="#8b5cf6"
                />
                <StatCard
                  icon={Clock}
                  label="Fleet Status"
                  value={host.is_fleet_node ? 'Installed' : 'Not Installed'}
                  color={host.is_fleet_node ? '#22c55e' : '#f59e0b'}
                />
              </div>

              {/* Details Grid */}
              <div className="bg-bg-tertiary rounded-lg p-4">
                <h3 className="font-medium text-text-primary mb-3">Device Details</h3>
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <DetailRow label="IP Address" value={host.ip} />
                  <DetailRow label="Hostname" value={host.name || 'Unknown'} />
                  <DetailRow label="MAC Address" value={host.mac || 'N/A'} />
                  <DetailRow label="Node Alias" value={host.fleet_node_id || 'N/A'} />
                  <DetailRow
                    label="Open Ports"
                    value={host.open_ports?.join(', ') || 'None detected'}
                  />
                  <DetailRow
                    label="Detection"
                    value={host.device?.match_reason || 'Unknown'}
                  />
                </div>
              </div>

              {/* Registered Data (if fleet node) */}
              {host.registered_data && (
                <div className="bg-bg-tertiary rounded-lg p-4">
                  <h3 className="font-medium text-text-primary mb-3">Live Metrics</h3>
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <DetailRow label="Last Seen" value={host.registered_data.last_seen || 'N/A'} />
                    <DetailRow label="GPU" value={host.registered_data.gpu?.name || 'N/A'} />
                    <DetailRow label="CPU Usage" value={`${host.registered_data.cpu_percent?.toFixed(1) || 0}%`} />
                    <DetailRow label="Memory Usage" value={`${host.registered_data.memory_percent?.toFixed(1) || 0}%`} />
                  </div>
                </div>
              )}

              {/* Actions */}
              <div className="flex gap-3">
                {!host.is_fleet_node && (
                  <button
                    onClick={() => onInstall(host)}
                    className="flex-1 py-2 bg-text-accent hover:bg-text-accent/80 text-bg-primary rounded-lg flex items-center justify-center gap-2 font-medium"
                  >
                    <Download size={16} /> Install Fleet Agent
                  </button>
                )}
                {host.is_fleet_node && (
                  <>
                    <button
                      onClick={() => onInstall(host)}
                      className="flex-1 py-2 bg-bg-tertiary hover:bg-bg-hover text-text-secondary rounded-lg flex items-center justify-center gap-2"
                    >
                      <RefreshCw size={16} /> Reinstall
                    </button>
                    <button className="flex-1 py-2 bg-status-error/20 hover:bg-status-error/30 text-status-error rounded-lg flex items-center justify-center gap-2">
                      <Trash2 size={16} /> Remove from Fleet
                    </button>
                  </>
                )}
              </div>
            </div>
          )}

          {activeTab === 'terminal' && (
            <div className="h-full flex flex-col">
              {/* Credential Selector */}
              <div className="mb-3 flex gap-2">
                <select
                  value={selectedCred}
                  onChange={(e) => setSelectedCred(e.target.value)}
                  className="flex-1 bg-bg-tertiary border border-border-subtle rounded-lg px-3 py-2 text-text-primary text-sm"
                >
                  <option value="">Select SSH credential...</option>
                  {credentials.map(c => (
                    <option key={c.id} value={c.id}>{c.name} ({c.username})</option>
                  ))}
                </select>
              </div>

              {/* Quick Commands */}
              <div className="mb-3 flex flex-wrap gap-2">
                {quickCommands.map((qc, i) => (
                  <button
                    key={i}
                    onClick={() => runCommand(qc.cmd)}
                    disabled={!selectedCred || isRunningCommand}
                    className="px-3 py-1 text-xs bg-bg-tertiary hover:bg-bg-hover text-text-secondary rounded border border-border-subtle disabled:opacity-50"
                  >
                    {qc.label}
                  </button>
                ))}
              </div>

              {/* Terminal Output */}
              <div
                ref={terminalRef}
                className="flex-1 bg-bg-primary rounded-lg p-3 font-mono text-xs overflow-auto min-h-[300px] border border-border-subtle"
              >
                {terminalOutput.length === 0 && (
                  <div className="text-text-muted">
                    Select a credential and run a command or use quick commands above...
                  </div>
                )}
                {terminalOutput.map((line, i) => (
                  <div
                    key={i}
                    className={clsx(
                      'whitespace-pre-wrap',
                      line.type === 'input' && 'text-text-accent font-bold',
                      line.type === 'output' && 'text-text-secondary',
                      line.type === 'error' && 'text-status-error'
                    )}
                  >
                    {line.text}
                  </div>
                ))}
                {isRunningCommand && (
                  <div className="flex items-center gap-2 text-text-muted">
                    <Loader2 size={12} className="animate-spin" /> Running...
                  </div>
                )}
              </div>

              {/* Input */}
              <div className="mt-3 flex gap-2">
                <input
                  ref={inputRef}
                  type="text"
                  value={terminalInput}
                  onChange={(e) => setTerminalInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  disabled={!selectedCred || isRunningCommand}
                  placeholder={selectedCred ? "Enter command..." : "Select credential first"}
                  className="flex-1 bg-bg-tertiary border border-border-subtle rounded-lg px-3 py-2 text-text-primary font-mono text-sm disabled:opacity-50"
                />
                <button
                  onClick={() => runCommand(terminalInput)}
                  disabled={!selectedCred || isRunningCommand || !terminalInput.trim()}
                  className="px-4 py-2 bg-text-accent hover:bg-text-accent/80 text-bg-primary rounded-lg disabled:opacity-50"
                >
                  {isRunningCommand ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
                </button>
              </div>
            </div>
          )}

          {activeTab === 'logs' && (
            <div className="space-y-2">
              <div className="flex justify-between items-center mb-3">
                <h3 className="font-medium text-text-primary">Activity Logs</h3>
                <button
                  onClick={fetchNodeDetails}
                  className="px-3 py-1 text-xs bg-bg-tertiary hover:bg-bg-hover text-text-secondary rounded flex items-center gap-1"
                >
                  <RefreshCw size={12} /> Refresh
                </button>
              </div>
              <div className="bg-bg-primary rounded-lg p-3 font-mono text-xs min-h-[300px] border border-border-subtle">
                {logs.length === 0 ? (
                  <div className="text-text-muted">No logs available</div>
                ) : (
                  logs.map((log, i) => (
                    <div key={i} className="text-text-secondary py-1 border-b border-border-subtle last:border-0">
                      {log}
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

const StatCard = ({ icon: Icon, label, value, color }) => (
  <div className="bg-bg-tertiary rounded-lg p-3">
    <div className="flex items-center gap-2 mb-1">
      <Icon size={14} style={{ color }} />
      <span className="text-xs text-text-muted">{label}</span>
    </div>
    <div className="font-medium text-text-primary" style={{ color }}>{value}</div>
  </div>
);

const DetailRow = ({ label, value }) => (
  <div>
    <span className="text-text-muted">{label}:</span>
    <span className="ml-2 text-text-primary">{value}</span>
  </div>
);

export default NodeDetailsModal;

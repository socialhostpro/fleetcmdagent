import React, { useState, useMemo } from 'react';
import {
  LineChart,
  Line,
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import { useMetricsWebSocket } from '../hooks/useWebSocket';
import {
  Server, Activity, Cpu, HardDrive, Thermometer,
  RefreshCw, Download, Clock
} from 'lucide-react';
import clsx from 'clsx';
import StatusDot from '../components/nodes/StatusDot';

// Generate mock historical data (in production, this would come from backend)
const generateMockHistory = (nodes) => {
  const history = [];
  const now = new Date();

  for (let i = 60; i >= 0; i--) {
    const time = new Date(now.getTime() - i * 60000);
    const point = {
      time: time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      timestamp: time.getTime(),
    };

    // Add node metrics with some variation
    nodes.forEach(node => {
      const baseVariation = Math.sin(i / 10) * 10;
      point[`${node.node_id}_cpu`] = Math.max(0, Math.min(100, (node.cpu || 30) + baseVariation + Math.random() * 5));
      point[`${node.node_id}_gpu`] = Math.max(0, Math.min(100, (node.gpu?.utilization || 50) + baseVariation + Math.random() * 5));
    });

    // Calculate aggregates
    const cpuValues = nodes.map(n => point[`${n.node_id}_cpu`] || 0);
    const gpuValues = nodes.map(n => point[`${n.node_id}_gpu`] || 0);
    point.avgCpu = cpuValues.reduce((a, b) => a + b, 0) / Math.max(cpuValues.length, 1);
    point.avgGpu = gpuValues.reduce((a, b) => a + b, 0) / Math.max(gpuValues.length, 1);
    point.maxCpu = Math.max(...cpuValues, 0);
    point.maxGpu = Math.max(...gpuValues, 0);

    history.push(point);
  }

  return history;
};

const MetricsView = () => {
  const { nodes, isConnected } = useMetricsWebSocket();
  const [timeRange, setTimeRange] = useState('1h');
  const [refreshInterval, setRefreshInterval] = useState('5s');

  // Generate historical data
  const historyData = useMemo(() => generateMockHistory(nodes), [nodes]);

  // Calculate summary stats
  const stats = useMemo(() => {
    if (nodes.length === 0) return null;

    const totalNodes = nodes.length;
    const onlineNodes = nodes.filter(n => n.cpu !== undefined).length;
    const avgCpu = nodes.reduce((sum, n) => sum + (n.cpu || 0), 0) / totalNodes;
    const avgGpu = nodes.reduce((sum, n) => sum + (n.gpu?.utilization || 0), 0) / totalNodes;
    const avgTemp = nodes.reduce((sum, n) => sum + (n.gpu?.temperature || 0), 0) / totalNodes;
    const totalJobs = Math.floor(avgGpu / 5); // Simulated

    return { totalNodes, onlineNodes, avgCpu, avgGpu, avgTemp, totalJobs };
  }, [nodes]);

  return (
    <div className="h-full overflow-auto bg-bg-primary p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Metrics Dashboard</h1>
          <p className="text-text-muted text-sm mt-1">
            Real-time cluster performance monitoring
          </p>
        </div>
        <div className="flex items-center gap-3">
          {/* Time Range */}
          <select
            value={timeRange}
            onChange={(e) => setTimeRange(e.target.value)}
            className="bg-bg-tertiary border border-border-subtle rounded-lg px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:border-text-accent"
          >
            <option value="15m">Last 15 min</option>
            <option value="1h">Last Hour</option>
            <option value="6h">Last 6 Hours</option>
            <option value="24h">Last 24 Hours</option>
          </select>

          {/* Refresh Rate */}
          <select
            value={refreshInterval}
            onChange={(e) => setRefreshInterval(e.target.value)}
            className="bg-bg-tertiary border border-border-subtle rounded-lg px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:border-text-accent"
          >
            <option value="5s">5 seconds</option>
            <option value="15s">15 seconds</option>
            <option value="30s">30 seconds</option>
            <option value="1m">1 minute</option>
          </select>

          <button className="p-2 rounded-lg bg-bg-tertiary border border-border-subtle hover:border-border-bright text-text-secondary hover:text-text-primary transition-colors">
            <RefreshCw size={16} />
          </button>

          <button className="p-2 rounded-lg bg-bg-tertiary border border-border-subtle hover:border-border-bright text-text-secondary hover:text-text-primary transition-colors">
            <Download size={16} />
          </button>
        </div>
      </div>

      {/* Summary Cards */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4 mb-6">
          <StatCard
            label="Total Nodes"
            value={`${stats.onlineNodes}/${stats.totalNodes}`}
            sublabel="Online"
            icon={Server}
            status="online"
          />
          <StatCard
            label="Avg CPU"
            value={`${stats.avgCpu.toFixed(0)}%`}
            sublabel={stats.avgCpu > 80 ? 'High Load' : 'Normal'}
            icon={Cpu}
            status={stats.avgCpu > 80 ? 'warning' : 'online'}
          />
          <StatCard
            label="Avg GPU"
            value={`${stats.avgGpu.toFixed(0)}%`}
            sublabel="Utilization"
            icon={Activity}
            status={stats.avgGpu > 90 ? 'warning' : 'online'}
          />
          <StatCard
            label="Avg Temp"
            value={`${stats.avgTemp.toFixed(0)}°C`}
            sublabel={stats.avgTemp > 75 ? 'Elevated' : 'Normal'}
            icon={Thermometer}
            status={stats.avgTemp > 75 ? 'warning' : 'online'}
          />
          <StatCard
            label="Active Jobs"
            value={stats.totalJobs.toString()}
            sublabel="Running"
            icon={Clock}
            status="busy"
          />
          <StatCard
            label="Throughput"
            value="1.2K"
            sublabel="req/s"
            icon={Activity}
            status="online"
          />
        </div>
      )}

      {/* Charts Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        {/* GPU Utilization Chart */}
        <ChartCard title="GPU Utilization (All Nodes)">
          <ResponsiveContainer width="100%" height={250}>
            <AreaChart data={historyData}>
              <defs>
                <linearGradient id="gpuGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#76b900" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#76b900" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#2a2a3a" />
              <XAxis dataKey="time" stroke="#606070" fontSize={10} />
              <YAxis stroke="#606070" fontSize={10} domain={[0, 100]} />
              <Tooltip
                contentStyle={{
                  backgroundColor: '#1a1a24',
                  border: '1px solid #3a3a4a',
                  borderRadius: '8px',
                }}
                labelStyle={{ color: '#a0a0b0' }}
              />
              <Area
                type="monotone"
                dataKey="avgGpu"
                stroke="#76b900"
                fill="url(#gpuGradient)"
                strokeWidth={2}
                name="Average GPU %"
              />
              <Area
                type="monotone"
                dataKey="maxGpu"
                stroke="#9bec00"
                fill="none"
                strokeWidth={1}
                strokeDasharray="3 3"
                name="Max GPU %"
              />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>

        {/* CPU Utilization Chart */}
        <ChartCard title="CPU Utilization (All Nodes)">
          <ResponsiveContainer width="100%" height={250}>
            <AreaChart data={historyData}>
              <defs>
                <linearGradient id="cpuGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#00d4ff" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#00d4ff" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#2a2a3a" />
              <XAxis dataKey="time" stroke="#606070" fontSize={10} />
              <YAxis stroke="#606070" fontSize={10} domain={[0, 100]} />
              <Tooltip
                contentStyle={{
                  backgroundColor: '#1a1a24',
                  border: '1px solid #3a3a4a',
                  borderRadius: '8px',
                }}
              />
              <Area
                type="monotone"
                dataKey="avgCpu"
                stroke="#00d4ff"
                fill="url(#cpuGradient)"
                strokeWidth={2}
                name="Average CPU %"
              />
              <Area
                type="monotone"
                dataKey="maxCpu"
                stroke="#3498db"
                fill="none"
                strokeWidth={1}
                strokeDasharray="3 3"
                name="Max CPU %"
              />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      {/* Per-Node Metrics Table */}
      <div className="bg-bg-secondary border border-border-subtle rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-border-subtle">
          <h3 className="font-semibold text-text-primary">Per-Node Metrics</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="bg-bg-tertiary text-left text-xs text-text-muted uppercase">
                <th className="px-4 py-3">Node</th>
                <th className="px-4 py-3">CPU</th>
                <th className="px-4 py-3">GPU</th>
                <th className="px-4 py-3">RAM</th>
                <th className="px-4 py-3">VRAM</th>
                <th className="px-4 py-3">Temp</th>
                <th className="px-4 py-3">Network</th>
                <th className="px-4 py-3">Jobs/hr</th>
              </tr>
            </thead>
            <tbody>
              {nodes.map((node, index) => (
                <tr
                  key={node.node_id}
                  className={clsx(
                    'border-t border-border-subtle hover:bg-bg-hover transition-colors',
                    index % 2 === 0 ? 'bg-bg-secondary' : 'bg-bg-tertiary/50'
                  )}
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <StatusDot status="online" size="sm" />
                      <span className="font-medium text-text-primary">{node.node_id}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <MetricCell value={node.cpu || 0} />
                  </td>
                  <td className="px-4 py-3">
                    <MetricCell value={node.gpu?.utilization || 0} />
                  </td>
                  <td className="px-4 py-3">
                    <MetricCell value={node.memory?.percent || 0} />
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-text-secondary font-mono text-sm">
                      {node.gpu?.memory_used ? `${(node.gpu.memory_used / 1024).toFixed(1)}GB` : 'N/A'}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className={clsx(
                      'font-mono text-sm',
                      (node.gpu?.temperature || 0) > 75 ? 'text-status-error' : 'text-text-secondary'
                    )}>
                      {node.gpu?.temperature || 'N/A'}°C
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-text-secondary font-mono text-sm">
                      {Math.floor(Math.random() * 200)}M/s
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-text-secondary font-mono text-sm">
                      {Math.floor(Math.random() * 50)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

const StatCard = ({ label, value, sublabel, icon: Icon, status }) => (
  <div className="bg-bg-tertiary border border-border-subtle rounded-lg p-4">
    <div className="flex items-center justify-between mb-2">
      <Icon size={18} className="text-text-muted" />
      <StatusDot status={status} size="sm" />
    </div>
    <div className="text-2xl font-bold text-text-primary mb-1">{value}</div>
    <div className="text-xs text-text-muted">
      {label}
      {sublabel && <span className="ml-1 text-text-secondary">• {sublabel}</span>}
    </div>
  </div>
);

const ChartCard = ({ title, children }) => (
  <div className="bg-bg-secondary border border-border-subtle rounded-lg">
    <div className="px-4 py-3 border-b border-border-subtle">
      <h3 className="font-semibold text-text-primary text-sm">{title}</h3>
    </div>
    <div className="p-4">
      {children}
    </div>
  </div>
);

const MetricCell = ({ value }) => {
  const percentage = Math.min(value, 100);
  const isHigh = percentage > 85;

  return (
    <div className="flex items-center gap-2">
      <div className="w-16 h-1.5 bg-bg-primary rounded-full overflow-hidden">
        <div
          className={clsx(
            'h-full rounded-full transition-all',
            isHigh ? 'bg-status-error' : 'bg-text-accent'
          )}
          style={{ width: `${percentage}%` }}
        />
      </div>
      <span className={clsx(
        'font-mono text-sm',
        isHigh ? 'text-status-error' : 'text-text-secondary'
      )}>
        {percentage.toFixed(0)}%
      </span>
    </div>
  );
};

export default MetricsView;

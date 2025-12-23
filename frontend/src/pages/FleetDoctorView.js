import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Stethoscope,
  Play,
  Square,
  RefreshCw,
  AlertTriangle,
  AlertCircle,
  CheckCircle2,
  Clock,
  Activity,
  Settings,
  ChevronDown,
  ChevronRight,
  Zap,
  Shield,
  Server,
  HardDrive,
  Cpu,
  Trash2,
  RotateCcw,
  X
} from 'lucide-react';
import clsx from 'clsx';
import axios from 'axios';

const API_BASE = process.env.REACT_APP_API_URL || 'http://localhost:8765';

/**
 * FleetDoctorView - Autonomous AI Self-Healing System Dashboard
 *
 * Monitors and controls the Fleet Doctor autonomous agent that:
 * - Continuously monitors the fleet for problems
 * - Uses DeepSeek AI to diagnose issues
 * - Automatically executes remediation actions
 * - Reports results and escalates when needed
 */
const FleetDoctorView = () => {
  // State
  const [status, setStatus] = useState({ status: 'unknown' });
  const [problems, setProblems] = useState([]);
  const [history, setHistory] = useState([]);
  const [stats, setStats] = useState({});
  const [events, setEvents] = useState([]);
  const [config, setConfig] = useState({});
  const [showConfig, setShowConfig] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedProblem, setSelectedProblem] = useState(null);

  const wsRef = useRef(null);
  const eventsEndRef = useRef(null);

  // Fetch all data on mount
  useEffect(() => {
    fetchAll();
    connectWebSocket();

    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, []);

  // Auto-scroll events
  useEffect(() => {
    if (eventsEndRef.current) {
      eventsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [events]);

  const fetchAll = async () => {
    setLoading(true);
    try {
      const [statusRes, problemsRes, historyRes, statsRes, configRes] = await Promise.all([
        axios.get(`${API_BASE}/api/doctor/status`),
        axios.get(`${API_BASE}/api/doctor/problems`),
        axios.get(`${API_BASE}/api/doctor/history?limit=20`),
        axios.get(`${API_BASE}/api/doctor/stats`),
        axios.get(`${API_BASE}/api/doctor/config`)
      ]);

      setStatus(statusRes.data);
      setProblems(problemsRes.data.problems || []);
      setHistory(historyRes.data.history || []);
      setStats(statsRes.data);
      setConfig(configRes.data.config || {});
      setError(null);
    } catch (err) {
      console.error('Failed to fetch doctor data:', err);
      setError(err.response?.data?.detail || err.message);
    } finally {
      setLoading(false);
    }
  };

  const connectWebSocket = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
    }

    const wsUrl = `${API_BASE.replace('http', 'ws')}/ws/doctor`;
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log('Connected to Fleet Doctor events');
      setEvents(prev => [...prev, {
        type: 'system',
        message: 'Connected to Fleet Doctor',
        timestamp: new Date().toISOString()
      }]);
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        setEvents(prev => [...prev.slice(-49), data]); // Keep last 50 events

        // Refresh data on important events
        if (['problem_detected', 'action_completed', 'action_failed'].includes(data.type)) {
          fetchAll();
        }
      } catch (err) {
        console.error('Failed to parse WebSocket message:', err);
      }
    };

    ws.onclose = () => {
      console.log('WebSocket disconnected');
      // Attempt reconnect after 5 seconds
      setTimeout(connectWebSocket, 5000);
    };

    ws.onerror = (err) => {
      console.error('WebSocket error:', err);
    };

    wsRef.current = ws;
  }, []);

  // Control actions
  const startDoctor = async () => {
    try {
      await axios.post(`${API_BASE}/api/doctor/start`);
      fetchAll();
    } catch (err) {
      setError(err.response?.data?.detail || err.message);
    }
  };

  const stopDoctor = async () => {
    try {
      await axios.post(`${API_BASE}/api/doctor/stop`);
      fetchAll();
    } catch (err) {
      setError(err.response?.data?.detail || err.message);
    }
  };

  const runNow = async () => {
    try {
      setEvents(prev => [...prev, {
        type: 'system',
        message: 'Running immediate check...',
        timestamp: new Date().toISOString()
      }]);
      await axios.post(`${API_BASE}/api/doctor/run-now`);
      fetchAll();
    } catch (err) {
      setError(err.response?.data?.detail || err.message);
    }
  };

  const dismissProblem = async (problemId) => {
    try {
      await axios.delete(`${API_BASE}/api/doctor/problems/${problemId}`);
      fetchAll();
    } catch (err) {
      setError(err.response?.data?.detail || err.message);
    }
  };

  const updateConfig = async (updates) => {
    try {
      await axios.post(`${API_BASE}/api/doctor/config`, updates);
      setConfig(prev => ({ ...prev, ...updates }));
    } catch (err) {
      setError(err.response?.data?.detail || err.message);
    }
  };

  // Status indicators
  const isRunning = status.status === 'running' || status.status === 'checking' || status.status === 'diagnosing' || status.status === 'healthy';

  const getStatusColor = (s) => {
    switch (s) {
      case 'running':
      case 'healthy':
        return 'text-status-online';
      case 'checking':
      case 'diagnosing':
        return 'text-status-warning';
      case 'stopped':
        return 'text-text-muted';
      default:
        return 'text-status-error';
    }
  };

  const getSeverityIcon = (severity) => {
    switch (severity) {
      case 'critical':
        return <AlertCircle size={16} className="text-status-error" />;
      case 'warning':
        return <AlertTriangle size={16} className="text-status-warning" />;
      default:
        return <AlertCircle size={16} className="text-text-muted" />;
    }
  };

  const getEventIcon = (type) => {
    switch (type) {
      case 'problem_detected':
        return <AlertTriangle size={14} className="text-status-warning" />;
      case 'diagnosis_complete':
        return <Stethoscope size={14} className="text-text-accent" />;
      case 'action_completed':
        return <CheckCircle2 size={14} className="text-status-online" />;
      case 'action_failed':
        return <AlertCircle size={14} className="text-status-error" />;
      case 'escalation':
        return <Shield size={14} className="text-status-warning" />;
      default:
        return <Activity size={14} className="text-text-muted" />;
    }
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center bg-bg-primary">
        <div className="text-center">
          <RefreshCw size={32} className="animate-spin text-text-accent mx-auto mb-4" />
          <p className="text-text-muted">Loading Fleet Doctor...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 bg-bg-primary overflow-auto p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-text-accent/20 rounded-lg">
              <Stethoscope size={24} className="text-text-accent" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-text-primary">Fleet Doctor</h1>
              <p className="text-sm text-text-muted">Autonomous AI Self-Healing System</p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {/* Status Badge */}
            <div className={clsx(
              'flex items-center gap-2 px-3 py-1.5 rounded-full border',
              isRunning ? 'bg-status-online/10 border-status-online/30' : 'bg-bg-tertiary border-border-subtle'
            )}>
              <div className={clsx(
                'w-2 h-2 rounded-full',
                isRunning ? 'bg-status-online animate-pulse' : 'bg-text-muted'
              )} />
              <span className={clsx('text-sm font-medium', getStatusColor(status.status))}>
                {status.status?.toUpperCase() || 'UNKNOWN'}
              </span>
            </div>

            {/* Controls */}
            <div className="flex items-center gap-2">
              {isRunning ? (
                <button
                  onClick={stopDoctor}
                  className="flex items-center gap-2 px-3 py-1.5 bg-status-error/20 text-status-error rounded-lg hover:bg-status-error/30 transition-colors"
                >
                  <Square size={16} />
                  Stop
                </button>
              ) : (
                <button
                  onClick={startDoctor}
                  className="flex items-center gap-2 px-3 py-1.5 bg-status-online/20 text-status-online rounded-lg hover:bg-status-online/30 transition-colors"
                >
                  <Play size={16} />
                  Start
                </button>
              )}

              <button
                onClick={runNow}
                className="flex items-center gap-2 px-3 py-1.5 bg-text-accent/20 text-text-accent rounded-lg hover:bg-text-accent/30 transition-colors"
              >
                <Zap size={16} />
                Run Now
              </button>

              <button
                onClick={() => setShowConfig(!showConfig)}
                className={clsx(
                  'p-2 rounded-lg transition-colors',
                  showConfig ? 'bg-text-accent/20 text-text-accent' : 'bg-bg-tertiary text-text-secondary hover:text-text-primary'
                )}
              >
                <Settings size={16} />
              </button>

              <button
                onClick={fetchAll}
                className="p-2 bg-bg-tertiary rounded-lg text-text-secondary hover:text-text-primary transition-colors"
              >
                <RefreshCw size={16} />
              </button>
            </div>
          </div>
        </div>

        {/* Error Banner */}
        {error && (
          <div className="bg-status-error/10 border border-status-error/30 rounded-lg p-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <AlertCircle size={20} className="text-status-error" />
              <span className="text-status-error">{error}</span>
            </div>
            <button onClick={() => setError(null)}>
              <X size={16} className="text-status-error hover:text-status-error/80" />
            </button>
          </div>
        )}

        {/* Configuration Panel */}
        {showConfig && (
          <div className="bg-bg-secondary border border-border-subtle rounded-lg p-4">
            <h3 className="text-sm font-semibold text-text-primary mb-4">Configuration</h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div>
                <label className="block text-xs text-text-muted mb-1">Check Interval (s)</label>
                <input
                  type="number"
                  value={config.interval || 30}
                  onChange={(e) => updateConfig({ interval: parseInt(e.target.value) })}
                  className="w-full px-3 py-1.5 bg-bg-tertiary border border-border-subtle rounded text-text-primary text-sm"
                />
              </div>
              <div>
                <label className="block text-xs text-text-muted mb-1">Disk Threshold (%)</label>
                <input
                  type="number"
                  value={config.disk_threshold || 85}
                  onChange={(e) => updateConfig({ disk_threshold: parseInt(e.target.value) })}
                  className="w-full px-3 py-1.5 bg-bg-tertiary border border-border-subtle rounded text-text-primary text-sm"
                />
              </div>
              <div>
                <label className="block text-xs text-text-muted mb-1">Memory Threshold (%)</label>
                <input
                  type="number"
                  value={config.memory_threshold || 90}
                  onChange={(e) => updateConfig({ memory_threshold: parseInt(e.target.value) })}
                  className="w-full px-3 py-1.5 bg-bg-tertiary border border-border-subtle rounded text-text-primary text-sm"
                />
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="auto_fix"
                  checked={config.auto_fix !== false}
                  onChange={(e) => updateConfig({ auto_fix: e.target.checked })}
                  className="rounded"
                />
                <label htmlFor="auto_fix" className="text-sm text-text-primary">Auto-Fix Enabled</label>
              </div>
            </div>
          </div>
        )}

        {/* Stats Row */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          <StatCard
            icon={<Activity size={20} />}
            label="Last Check"
            value={status.last_check ? formatTime(status.last_check) : 'Never'}
          />
          <StatCard
            icon={<AlertTriangle size={20} />}
            label="Active Problems"
            value={problems.length}
            highlight={problems.length > 0 ? 'warning' : 'none'}
          />
          <StatCard
            icon={<Zap size={20} />}
            label="Actions/Hour"
            value={`${stats.actions_this_hour || 0}/${stats.max_actions_per_hour || 20}`}
          />
          <StatCard
            icon={<CheckCircle2 size={20} />}
            label="Success Rate"
            value={stats.stats?.success_rate || 'N/A'}
            highlight={stats.stats?.success_rate === '100.0%' ? 'success' : 'none'}
          />
          <StatCard
            icon={<Clock size={20} />}
            label="Last 24h Actions"
            value={stats.stats?.last_24h || 0}
          />
        </div>

        {/* Main Content Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Current Problems */}
          <div className="bg-bg-secondary border border-border-subtle rounded-lg">
            <div className="flex items-center justify-between p-4 border-b border-border-subtle">
              <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2">
                <AlertTriangle size={16} className="text-status-warning" />
                Current Problems
              </h3>
              <span className="text-xs text-text-muted">{problems.length} issues</span>
            </div>
            <div className="max-h-80 overflow-y-auto">
              {problems.length === 0 ? (
                <div className="p-8 text-center text-text-muted">
                  <CheckCircle2 size={32} className="mx-auto mb-2 text-status-online" />
                  <p>No problems detected</p>
                </div>
              ) : (
                <div className="divide-y divide-border-subtle">
                  {problems.map((problem) => (
                    <div
                      key={problem.id}
                      className="p-3 hover:bg-bg-hover cursor-pointer"
                      onClick={() => setSelectedProblem(selectedProblem?.id === problem.id ? null : problem)}
                    >
                      <div className="flex items-start justify-between">
                        <div className="flex items-start gap-2">
                          {getSeverityIcon(problem.severity)}
                          <div>
                            <p className="text-sm font-medium text-text-primary">{problem.title}</p>
                            <p className="text-xs text-text-muted">{problem.node_id || 'System'}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className={clsx(
                            'px-2 py-0.5 text-xs rounded',
                            problem.risk_level === 'high' ? 'bg-status-error/20 text-status-error' :
                            problem.risk_level === 'medium' ? 'bg-status-warning/20 text-status-warning' :
                            'bg-status-online/20 text-status-online'
                          )}>
                            {problem.risk_level}
                          </span>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              dismissProblem(problem.id);
                            }}
                            className="p-1 hover:bg-bg-tertiary rounded"
                          >
                            <X size={14} className="text-text-muted" />
                          </button>
                        </div>
                      </div>
                      {selectedProblem?.id === problem.id && (
                        <div className="mt-3 pt-3 border-t border-border-subtle text-xs">
                          <p className="text-text-muted mb-2">{problem.description}</p>
                          <pre className="bg-bg-tertiary p-2 rounded overflow-x-auto">
                            {JSON.stringify(problem.details, null, 2)}
                          </pre>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Live Events */}
          <div className="bg-bg-secondary border border-border-subtle rounded-lg">
            <div className="flex items-center justify-between p-4 border-b border-border-subtle">
              <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2">
                <Activity size={16} className="text-text-accent" />
                Live Events
              </h3>
              <button
                onClick={() => setEvents([])}
                className="text-xs text-text-muted hover:text-text-primary"
              >
                Clear
              </button>
            </div>
            <div className="h-80 overflow-y-auto p-2">
              {events.length === 0 ? (
                <div className="h-full flex items-center justify-center text-text-muted">
                  <p>Waiting for events...</p>
                </div>
              ) : (
                <div className="space-y-1">
                  {events.map((event, idx) => (
                    <div key={idx} className="flex items-start gap-2 p-2 rounded hover:bg-bg-hover">
                      {getEventIcon(event.type)}
                      <div className="flex-1 min-w-0">
                        <p className="text-xs text-text-primary truncate">
                          {event.message || event.type?.replace(/_/g, ' ')}
                        </p>
                        <p className="text-xs text-text-muted">
                          {formatTime(event.timestamp)}
                        </p>
                      </div>
                    </div>
                  ))}
                  <div ref={eventsEndRef} />
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Action History */}
        <div className="bg-bg-secondary border border-border-subtle rounded-lg">
          <div className="flex items-center justify-between p-4 border-b border-border-subtle">
            <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2">
              <Clock size={16} className="text-text-accent" />
              Recent Actions
            </h3>
            <span className="text-xs text-text-muted">{history.length} actions</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-bg-tertiary">
                <tr>
                  <th className="text-left text-xs font-medium text-text-muted px-4 py-2">Time</th>
                  <th className="text-left text-xs font-medium text-text-muted px-4 py-2">Problem</th>
                  <th className="text-left text-xs font-medium text-text-muted px-4 py-2">Action</th>
                  <th className="text-left text-xs font-medium text-text-muted px-4 py-2">Node</th>
                  <th className="text-left text-xs font-medium text-text-muted px-4 py-2">Result</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {history.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="text-center py-8 text-text-muted">
                      No actions taken yet
                    </td>
                  </tr>
                ) : (
                  history.map((item, idx) => (
                    <tr key={idx} className="hover:bg-bg-hover">
                      <td className="px-4 py-2 text-xs text-text-muted">
                        {formatTime(item.timestamp)}
                      </td>
                      <td className="px-4 py-2 text-xs text-text-primary">
                        {item.problem?.type?.replace(/_/g, ' ')}
                      </td>
                      <td className="px-4 py-2 text-xs text-text-primary">
                        {item.result?.action?.replace(/_/g, ' ')}
                      </td>
                      <td className="px-4 py-2 text-xs text-text-muted">
                        {item.problem?.node_id || 'N/A'}
                      </td>
                      <td className="px-4 py-2">
                        <span className={clsx(
                          'inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded',
                          item.result?.success
                            ? 'bg-status-online/20 text-status-online'
                            : 'bg-status-error/20 text-status-error'
                        )}>
                          {item.result?.success ? (
                            <><CheckCircle2 size={12} /> Success</>
                          ) : (
                            <><AlertCircle size={12} /> Failed</>
                          )}
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
};

// Stat Card Component
const StatCard = ({ icon, label, value, highlight = 'none' }) => (
  <div className={clsx(
    'bg-bg-secondary border rounded-lg p-4',
    highlight === 'warning' ? 'border-status-warning/50' :
    highlight === 'success' ? 'border-status-online/50' :
    'border-border-subtle'
  )}>
    <div className="flex items-center gap-3">
      <div className={clsx(
        'p-2 rounded-lg',
        highlight === 'warning' ? 'bg-status-warning/20 text-status-warning' :
        highlight === 'success' ? 'bg-status-online/20 text-status-online' :
        'bg-bg-tertiary text-text-muted'
      )}>
        {icon}
      </div>
      <div>
        <p className="text-xs text-text-muted">{label}</p>
        <p className="text-lg font-bold text-text-primary">{value}</p>
      </div>
    </div>
  </div>
);

// Helper function to format timestamps
const formatTime = (timestamp) => {
  if (!timestamp) return 'N/A';
  try {
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now - date;

    if (diff < 60000) {
      return 'Just now';
    } else if (diff < 3600000) {
      return `${Math.floor(diff / 60000)}m ago`;
    } else if (diff < 86400000) {
      return `${Math.floor(diff / 3600000)}h ago`;
    } else {
      return date.toLocaleString();
    }
  } catch {
    return timestamp;
  }
};

export default FleetDoctorView;

import React, { useState, useEffect, useCallback } from 'react';
import {
  List, Play, Pause, RefreshCw, Trash2, RotateCcw, Clock,
  CheckCircle, XCircle, AlertCircle, Loader2, Zap, TrendingUp,
  BarChart3, Server, Settings, Plus, ChevronDown, ChevronUp
} from 'lucide-react';
import clsx from 'clsx';

const API_URL = `http://${window.location.hostname}:8765/api`;

const priorityColors = {
  high: 'text-red-500 bg-red-500/10',
  normal: 'text-blue-500 bg-blue-500/10',
  low: 'text-gray-500 bg-gray-500/10',
};

const statusColors = {
  queued: 'text-yellow-500 bg-yellow-500/10',
  processing: 'text-blue-500 bg-blue-500/10',
  completed: 'text-green-500 bg-green-500/10',
  failed: 'text-red-500 bg-red-500/10',
  dead: 'text-gray-500 bg-gray-500/10',
  cancelled: 'text-orange-500 bg-orange-500/10',
};

const jobTypeIcons = {
  image_gen: '🖼️',
  video_gen: '🎬',
  llm_inference: '🤖',
  transcription: '🎤',
  training: '🧠',
  custom: '⚙️',
};

const QueueView = () => {
  const [stats, setStats] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [scalingConfig, setScalingConfig] = useState(null);
  const [scalingState, setScalingState] = useState(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState({ status: '', jobType: '' });
  const [showCreateJob, setShowCreateJob] = useState(false);
  const [showScalingConfig, setShowScalingConfig] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const [statsRes, jobsRes, configRes, stateRes] = await Promise.all([
        fetch(`${API_URL}/queue/stats`),
        fetch(`${API_URL}/queue/jobs?limit=50`),
        fetch(`${API_URL}/queue/scaling/config`),
        fetch(`${API_URL}/queue/scaling/state`),
      ]);

      if (statsRes.ok) setStats(await statsRes.json());
      if (jobsRes.ok) {
        const data = await jobsRes.json();
        setJobs(data.jobs || []);
      }
      if (configRes.ok) setScalingConfig(await configRes.json());
      if (stateRes.ok) setScalingState(await stateRes.json());
    } catch (err) {
      console.error('Failed to fetch queue data:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 5000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const cancelJob = async (jobId) => {
    if (!window.confirm('Cancel this job?')) return;
    try {
      await fetch(`${API_URL}/queue/jobs/${jobId}`, { method: 'DELETE' });
      fetchData();
    } catch (err) {
      console.error('Failed to cancel job:', err);
    }
  };

  const retryJob = async (jobId) => {
    try {
      await fetch(`${API_URL}/queue/jobs/${jobId}/retry`, { method: 'POST' });
      fetchData();
    } catch (err) {
      console.error('Failed to retry job:', err);
    }
  };

  const evaluateScaling = async () => {
    try {
      const res = await fetch(`${API_URL}/queue/scaling/evaluate`, { method: 'POST' });
      if (res.ok) {
        const state = await res.json();
        setScalingState(state);
      }
    } catch (err) {
      console.error('Failed to evaluate scaling:', err);
    }
  };

  const filteredJobs = jobs.filter(job => {
    if (filter.status && job.status !== filter.status) return false;
    if (filter.jobType && job.job_type !== filter.jobType) return false;
    return true;
  });

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-8 h-8 animate-spin text-text-accent" />
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto p-6 bg-bg-primary">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-text-primary flex items-center gap-2">
            <List className="w-6 h-6" />
            Job Queue
          </h1>
          <p className="text-text-muted mt-1">Manage and monitor distributed job processing</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowCreateJob(true)}
            className="px-4 py-2 bg-text-accent hover:bg-text-accent/80 text-bg-primary rounded-lg font-medium flex items-center gap-2"
          >
            <Plus size={16} />
            New Job
          </button>
          <button
            onClick={fetchData}
            className="p-2 bg-bg-tertiary border border-border-subtle rounded-lg hover:border-border-bright text-text-secondary hover:text-text-primary"
          >
            <RefreshCw size={16} />
          </button>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4 mb-6">
        {/* Queue Depths */}
        <StatCard
          title="High Priority"
          value={stats?.queues?.high || 0}
          icon={<Zap className="text-red-500" />}
          color="red"
        />
        <StatCard
          title="Normal Queue"
          value={stats?.queues?.normal || 0}
          icon={<List className="text-blue-500" />}
          color="blue"
        />
        <StatCard
          title="Low Priority"
          value={stats?.queues?.low || 0}
          icon={<Clock className="text-gray-500" />}
          color="gray"
        />
        <StatCard
          title="Processing"
          value={stats?.processing || 0}
          icon={<Loader2 className="text-yellow-500 animate-spin" />}
          color="yellow"
        />
        <StatCard
          title="Completed"
          value={stats?.totals?.completed || 0}
          icon={<CheckCircle className="text-green-500" />}
          color="green"
        />
        <StatCard
          title="Failed"
          value={stats?.totals?.failed || 0}
          icon={<XCircle className="text-red-500" />}
          color="red"
        />
      </div>

      {/* Processing Rate & Nodes */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <div className="bg-bg-secondary rounded-lg border border-border-subtle p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-text-secondary">Processing Rate</h3>
            <TrendingUp size={16} className="text-green-500" />
          </div>
          <div className="text-3xl font-bold text-text-primary">
            {stats?.processing_rate?.rate || 0}
            <span className="text-lg text-text-muted ml-1">jobs/min</span>
          </div>
          <div className="text-xs text-text-muted mt-1">
            {stats?.processing_rate?.completions || 0} completions in last 5 minutes
          </div>
        </div>

        <div className="bg-bg-secondary rounded-lg border border-border-subtle p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-text-secondary">Worker Nodes</h3>
            <Server size={16} className="text-blue-500" />
          </div>
          <div className="flex items-center gap-6">
            <div>
              <div className="text-3xl font-bold text-text-primary">{stats?.nodes?.active || 0}</div>
              <div className="text-xs text-text-muted">Active</div>
            </div>
            <div>
              <div className="text-3xl font-bold text-green-500">{stats?.nodes?.computing || 0}</div>
              <div className="text-xs text-text-muted">Computing</div>
            </div>
            <div>
              <div className="text-3xl font-bold text-text-secondary">{stats?.nodes?.avg_gpu_utilization?.toFixed(1) || 0}%</div>
              <div className="text-xs text-text-muted">Avg GPU</div>
            </div>
          </div>
        </div>
      </div>

      {/* Auto-Scaling Panel */}
      <div className="bg-bg-secondary rounded-lg border border-border-subtle mb-6">
        <button
          onClick={() => setShowScalingConfig(!showScalingConfig)}
          className="w-full flex items-center justify-between p-4 hover:bg-bg-tertiary/50"
        >
          <div className="flex items-center gap-3">
            <BarChart3 size={20} className="text-text-accent" />
            <div className="text-left">
              <h3 className="font-semibold text-text-primary">Auto-Scaling</h3>
              <p className="text-xs text-text-muted">
                {scalingConfig?.enabled ? 'Enabled' : 'Disabled'} -
                {scalingState?.action !== 'none' && scalingState?.action
                  ? ` Recommended: ${scalingState.action}`
                  : ' No action needed'}
              </p>
            </div>
          </div>
          {showScalingConfig ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </button>

        {showScalingConfig && (
          <div className="p-4 border-t border-border-subtle">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
              <div className="bg-bg-tertiary rounded-lg p-3">
                <div className="text-xs text-text-muted mb-1">Min Nodes</div>
                <div className="text-lg font-bold text-text-primary">{scalingConfig?.min_nodes}</div>
              </div>
              <div className="bg-bg-tertiary rounded-lg p-3">
                <div className="text-xs text-text-muted mb-1">Max Nodes</div>
                <div className="text-lg font-bold text-text-primary">{scalingConfig?.max_nodes}</div>
              </div>
              <div className="bg-bg-tertiary rounded-lg p-3">
                <div className="text-xs text-text-muted mb-1">Target Queue</div>
                <div className="text-lg font-bold text-text-primary">{scalingConfig?.target_queue_depth}</div>
              </div>
              <div className="bg-bg-tertiary rounded-lg p-3">
                <div className="text-xs text-text-muted mb-1">Cooldown</div>
                <div className="text-lg font-bold text-text-primary">{scalingConfig?.cooldown_seconds}s</div>
              </div>
            </div>

            {scalingState && (
              <div className="bg-bg-tertiary rounded-lg p-3 mb-4">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-text-secondary">Current State</span>
                  <span className={clsx(
                    'px-2 py-0.5 rounded text-xs font-medium',
                    scalingState.action === 'scale_up' && 'bg-green-500/20 text-green-500',
                    scalingState.action === 'scale_down' && 'bg-orange-500/20 text-orange-500',
                    scalingState.action === 'none' && 'bg-gray-500/20 text-gray-500'
                  )}>
                    {scalingState.action === 'none' ? 'Stable' : scalingState.action?.replace('_', ' ')}
                  </span>
                </div>
                {scalingState.reason && (
                  <p className="text-xs text-text-muted mt-2">{scalingState.reason}</p>
                )}
              </div>
            )}

            <button
              onClick={evaluateScaling}
              className="px-4 py-2 bg-bg-tertiary border border-border-subtle rounded-lg hover:border-text-accent text-text-secondary hover:text-text-primary flex items-center gap-2"
            >
              <RefreshCw size={14} />
              Evaluate Now
            </button>
          </div>
        )}
      </div>

      {/* Jobs Table */}
      <div className="bg-bg-secondary rounded-lg border border-border-subtle">
        <div className="flex items-center justify-between p-4 border-b border-border-subtle">
          <h3 className="font-semibold text-text-primary">Jobs</h3>
          <div className="flex items-center gap-2">
            <select
              value={filter.status}
              onChange={(e) => setFilter({ ...filter, status: e.target.value })}
              className="bg-bg-tertiary border border-border-subtle rounded px-2 py-1 text-sm text-text-primary"
            >
              <option value="">All Status</option>
              <option value="queued">Queued</option>
              <option value="processing">Processing</option>
              <option value="completed">Completed</option>
              <option value="failed">Failed</option>
            </select>
            <select
              value={filter.jobType}
              onChange={(e) => setFilter({ ...filter, jobType: e.target.value })}
              className="bg-bg-tertiary border border-border-subtle rounded px-2 py-1 text-sm text-text-primary"
            >
              <option value="">All Types</option>
              <option value="image_gen">Image Gen</option>
              <option value="video_gen">Video Gen</option>
              <option value="llm_inference">LLM</option>
              <option value="transcription">Transcription</option>
              <option value="training">Training</option>
            </select>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-bg-tertiary/50">
              <tr className="text-xs text-text-muted uppercase">
                <th className="px-4 py-2 text-left">Type</th>
                <th className="px-4 py-2 text-left">Job ID</th>
                <th className="px-4 py-2 text-left">Priority</th>
                <th className="px-4 py-2 text-left">Status</th>
                <th className="px-4 py-2 text-left">Progress</th>
                <th className="px-4 py-2 text-left">Node</th>
                <th className="px-4 py-2 text-left">Created</th>
                <th className="px-4 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredJobs.map((job) => (
                <tr key={job.job_id} className="border-t border-border-subtle hover:bg-bg-tertiary/30">
                  <td className="px-4 py-3">
                    <span className="text-xl" title={job.job_type}>
                      {jobTypeIcons[job.job_type] || '⚙️'}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className="font-mono text-xs text-text-secondary">{job.job_id.slice(0, 8)}</span>
                  </td>
                  <td className="px-4 py-3">
                    <span className={clsx('px-2 py-0.5 rounded text-xs font-medium', priorityColors[job.priority])}>
                      {job.priority}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className={clsx('px-2 py-0.5 rounded text-xs font-medium', statusColors[job.status])}>
                      {job.status}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <div className="w-20 h-2 bg-bg-tertiary rounded-full overflow-hidden">
                        <div
                          className={clsx(
                            'h-full transition-all',
                            job.status === 'completed' && 'bg-green-500',
                            job.status === 'processing' && 'bg-blue-500',
                            job.status === 'failed' && 'bg-red-500',
                            job.status === 'queued' && 'bg-yellow-500'
                          )}
                          style={{ width: `${job.progress || 0}%` }}
                        />
                      </div>
                      <span className="text-xs text-text-muted">{job.progress?.toFixed(0) || 0}%</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-xs text-text-secondary">
                    {job.assigned_node || '-'}
                  </td>
                  <td className="px-4 py-3 text-xs text-text-muted">
                    {new Date(job.created_at).toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-1">
                      {job.status === 'failed' && (
                        <button
                          onClick={() => retryJob(job.job_id)}
                          className="p-1.5 hover:bg-bg-tertiary rounded text-yellow-500"
                          title="Retry"
                        >
                          <RotateCcw size={14} />
                        </button>
                      )}
                      {['queued', 'processing'].includes(job.status) && (
                        <button
                          onClick={() => cancelJob(job.job_id)}
                          className="p-1.5 hover:bg-bg-tertiary rounded text-red-500"
                          title="Cancel"
                        >
                          <XCircle size={14} />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {filteredJobs.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-text-muted">
                    No jobs found
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Create Job Modal */}
      {showCreateJob && (
        <CreateJobModal onClose={() => setShowCreateJob(false)} onCreated={fetchData} />
      )}
    </div>
  );
};

const StatCard = ({ title, value, icon, color }) => (
  <div className="bg-bg-secondary rounded-lg border border-border-subtle p-4">
    <div className="flex items-center justify-between mb-2">
      <span className="text-xs text-text-muted">{title}</span>
      {icon}
    </div>
    <div className={clsx('text-2xl font-bold', `text-${color}-500`)}>
      {value}
    </div>
  </div>
);

const CreateJobModal = ({ onClose, onCreated }) => {
  const [jobType, setJobType] = useState('image_gen');
  const [priority, setPriority] = useState('normal');
  const [targetCluster, setTargetCluster] = useState('');
  const [payload, setPayload] = useState('{}');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState(null);

  const handleCreate = async () => {
    setCreating(true);
    setError(null);

    try {
      const res = await fetch(`${API_URL}/queue/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          job_type: jobType,
          priority,
          target_cluster: targetCluster || null,
          payload: JSON.parse(payload),
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.detail || 'Failed to create job');
      }

      onCreated();
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
      <div className="bg-bg-secondary rounded-lg w-full max-w-lg border border-border-subtle">
        <div className="p-4 border-b border-border-subtle">
          <h2 className="text-lg font-bold text-text-primary">Create Job</h2>
        </div>

        <div className="p-4 space-y-4">
          <div>
            <label className="block text-sm text-text-secondary mb-1">Job Type</label>
            <select
              value={jobType}
              onChange={(e) => setJobType(e.target.value)}
              className="w-full bg-bg-tertiary border border-border-subtle rounded-lg px-3 py-2 text-text-primary"
            >
              <option value="image_gen">Image Generation</option>
              <option value="video_gen">Video Generation</option>
              <option value="llm_inference">LLM Inference</option>
              <option value="transcription">Transcription</option>
              <option value="training">Training</option>
              <option value="custom">Custom</option>
            </select>
          </div>

          <div>
            <label className="block text-sm text-text-secondary mb-1">Priority</label>
            <select
              value={priority}
              onChange={(e) => setPriority(e.target.value)}
              className="w-full bg-bg-tertiary border border-border-subtle rounded-lg px-3 py-2 text-text-primary"
            >
              <option value="high">High</option>
              <option value="normal">Normal</option>
              <option value="low">Low</option>
            </select>
          </div>

          <div>
            <label className="block text-sm text-text-secondary mb-1">Target Cluster (optional)</label>
            <select
              value={targetCluster}
              onChange={(e) => setTargetCluster(e.target.value)}
              className="w-full bg-bg-tertiary border border-border-subtle rounded-lg px-3 py-2 text-text-primary"
            >
              <option value="">Any</option>
              <option value="vision">Vision (agx0-2)</option>
              <option value="media-gen">Media Gen (agx3-4)</option>
              <option value="media-proc">Media Proc (agx5-6)</option>
              <option value="llm">LLM (agx7-9)</option>
              <option value="voice">Voice (agx10)</option>
              <option value="music">Music (agx11)</option>
              <option value="roamer">Roamer (agx12-15)</option>
            </select>
          </div>

          <div>
            <label className="block text-sm text-text-secondary mb-1">Payload (JSON)</label>
            <textarea
              value={payload}
              onChange={(e) => setPayload(e.target.value)}
              className="w-full bg-bg-tertiary border border-border-subtle rounded-lg px-3 py-2 text-text-primary font-mono text-sm h-32"
              placeholder='{"workflow": "...", "prompt": "..."}'
            />
          </div>
        </div>

        {error && (
          <div className="px-4 pb-4">
            <div className="p-3 bg-status-error/10 border border-status-error/20 rounded-lg text-status-error text-sm">
              {error}
            </div>
          </div>
        )}

        <div className="p-4 border-t border-border-subtle flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 text-text-secondary hover:text-text-primary">
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={creating}
            className="px-4 py-2 bg-text-accent hover:bg-text-accent/80 text-bg-primary rounded-lg font-medium disabled:opacity-50"
          >
            {creating ? 'Creating...' : 'Create Job'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default QueueView;

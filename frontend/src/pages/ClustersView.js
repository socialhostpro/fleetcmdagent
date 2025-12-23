import React, { useMemo, useState, useCallback, useEffect } from 'react';
import { useMetricsWebSocket } from '../hooks/useWebSocket';
import {
  Camera, Video, Mic, Music, Brain, Zap, Bot,
  Server, Activity, Cpu, HardDrive, Rocket, Plus, X, Loader2, Image, Sparkles, FileText, Trash2
} from 'lucide-react';
import clsx from 'clsx';
import MetricBar from '../components/nodes/MetricBar';
import StatusDot from '../components/nodes/StatusDot';
import DeploymentWizard from '../components/DeploymentWizard';

// SDXL API endpoint on vision cluster node
const SDXL_API = 'http://192.168.1.182:8080';
const API_BASE = `http://${window.location.hostname}:8765`;

const clusterConfig = {
  vision: {
    name: 'VISION',
    icon: Camera,
    color: 'cluster-vision',
    description: 'SDXL, FLUX image generation',
    nodePattern: /agx[0-2]|agx-0[12]/i,
  },
  'media-gen': {
    name: 'MEDIA-GEN',
    icon: Video,
    color: 'cluster-media-gen',
    description: 'WAN 2.1, AnimateDiff video',
    nodePattern: /agx[3-4]|agx-0[34]/i,
  },
  'media-proc': {
    name: 'MEDIA-PROC',
    icon: Video,
    color: 'cluster-media-proc',
    description: 'Video processing, Lip sync',
    nodePattern: /agx[5-6]|agx-0[56]/i,
  },
  llm: {
    name: 'LLM',
    icon: Brain,
    color: 'cluster-llm',
    description: 'Llama, Mistral inference',
    nodePattern: /agx[7-9]|agx-0[789]/i,
  },
  voice: {
    name: 'VOICE',
    icon: Mic,
    color: 'cluster-voice',
    description: 'Whisper, XTTS, Bark TTS',
    nodePattern: /agx10|agx-10/i,
  },
  music: {
    name: 'MUSIC',
    icon: Music,
    color: 'cluster-music',
    description: 'MusicGen, AudioCraft',
    nodePattern: /agx11|agx-11/i,
  },
  agentic: {
    name: 'AGENTIC',
    icon: Bot,
    color: 'cluster-agentic',
    description: 'AI Agents, Browser automation',
    nodePattern: /agx12|agx-12/i,
  },
};

const ClustersView = () => {
  const { nodes, isConnected } = useMetricsWebSocket();
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardCluster, setWizardCluster] = useState(null);
  const [testModalOpen, setTestModalOpen] = useState(false);
  const [testCluster, setTestCluster] = useState(null);
  const [nodeContainers, setNodeContainers] = useState({});
  const [logsModal, setLogsModal] = useState({ open: false, nodeId: '', container: '', logs: '', loading: false });

  // Fetch logs for a container
  const fetchLogs = async (nodeId, containerName) => {
    setLogsModal({ open: true, nodeId, container: containerName, logs: '', loading: true });
    try {
      const res = await fetch(`${API_BASE}/api/fleet/logs/${nodeId}/${containerName}?tail=100`);
      const data = await res.json();
      setLogsModal(prev => ({ ...prev, logs: data.logs || 'No logs available', loading: false }));
    } catch (e) {
      setLogsModal(prev => ({ ...prev, logs: `Error: ${e.message}`, loading: false }));
    }
  };

  // Delete a container
  const deleteContainer = async (nodeId, containerName) => {
    if (!window.confirm(`Delete container "${containerName}" on ${nodeId}?`)) return;
    try {
      await fetch(`${API_BASE}/api/fleet/deploy/${nodeId}/${containerName}`, { method: 'DELETE' });
      // Refresh containers
      const res = await fetch(`${API_BASE}/api/nodes/containers`);
      if (res.ok) {
        const data = await res.json();
        const containerMap = {};
        (data.nodes || []).forEach(n => {
          containerMap[n.node_id] = n.containers || [];
        });
        setNodeContainers(containerMap);
      }
    } catch (e) {
      alert(`Failed to delete: ${e.message}`);
    }
  };

  // Fetch real containers from nodes
  useEffect(() => {
    const fetchContainers = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/nodes/containers`);
        if (res.ok) {
          const data = await res.json();
          const containerMap = {};
          (data.nodes || []).forEach(n => {
            containerMap[n.node_id] = n.containers || [];
          });
          setNodeContainers(containerMap);
        }
      } catch (e) {
        console.error('Failed to fetch containers:', e);
      }
    };
    fetchContainers();
    const interval = setInterval(fetchContainers, 30000);
    return () => clearInterval(interval);
  }, []);

  const openWizard = (cluster = null) => {
    setWizardCluster(cluster);
    setWizardOpen(true);
  };

  const openTestModal = (clusterId, clusterNodes) => {
    setTestCluster({ id: clusterId, nodes: clusterNodes });
    setTestModalOpen(true);
  };

  // Group nodes by cluster
  const { clusters, roamers, spark } = useMemo(() => {
    const grouped = {
      clusters: {},
      roamers: [],
      spark: null,
    };

    nodes.forEach(node => {
      const id = node.node_id?.toLowerCase() || '';
      const assignedCluster = node.cluster?.toLowerCase() || '';

      // Check if it's Spark
      if (id.includes('spark') || id.includes('dgx')) {
        grouped.spark = node;
        return;
      }

      // Check if it's a roamer
      if (id.match(/agx-?1[2-5]/i)) {
        grouped.roamers.push(node);
        return;
      }

      // Use backend-assigned cluster if available
      if (assignedCluster && clusterConfig[assignedCluster]) {
        if (!grouped.clusters[assignedCluster]) {
          grouped.clusters[assignedCluster] = [];
        }
        grouped.clusters[assignedCluster].push(node);
        return;
      }

      // Fallback: Find matching cluster by pattern
      for (const [key, config] of Object.entries(clusterConfig)) {
        if (config.nodePattern.test(id)) {
          if (!grouped.clusters[key]) {
            grouped.clusters[key] = [];
          }
          grouped.clusters[key].push(node);
          break;
        }
      }
    });

    return grouped;
  }, [nodes]);

  return (
    <div className="h-full overflow-auto bg-bg-primary p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Clusters</h1>
          <p className="text-text-muted text-sm mt-1">
            {Object.keys(clusters).length} clusters • {nodes.length} total nodes
          </p>
        </div>
        <div className="flex items-center gap-4">
          <button
            onClick={() => openWizard()}
            className="flex items-center gap-2 px-4 py-2 bg-text-accent text-white rounded-lg hover:bg-text-accent/90 transition-colors"
          >
            <Rocket size={16} />
            Deploy Service
          </button>
          <div className="flex items-center gap-2">
            <StatusDot status={isConnected ? 'online' : 'offline'} />
            <span className="text-text-secondary text-sm">
              {isConnected ? 'Live' : 'Disconnected'}
            </span>
          </div>
        </div>
      </div>

      {/* Spark Node (Control Plane) */}
      {spark && (
        <div className="mb-6">
          <h2 className="text-sm font-semibold text-text-muted uppercase tracking-wide mb-3">
            Control Plane
          </h2>
          <SparkCard node={spark} />
        </div>
      )}

      {/* Cluster Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
        {Object.entries(clusterConfig).map(([key, config]) => {
          const clusterNodes = clusters[key] || [];
          return (
            <ClusterCard
              key={key}
              clusterId={key}
              config={config}
              nodes={clusterNodes}
              nodeContainers={nodeContainers}
              onDeploy={() => openWizard(key)}
              onTest={() => openTestModal(key, clusterNodes)}
              onLogs={fetchLogs}
              onDelete={deleteContainer}
            />
          );
        })}
      </div>

      {/* Roamer Pool */}
      <div>
        <h2 className="text-sm font-semibold text-text-muted uppercase tracking-wide mb-3">
          Roamer Pool
        </h2>
        <RoamerPool roamers={roamers} />
      </div>

      {/* Deployment Wizard Modal */}
      <DeploymentWizard
        isOpen={wizardOpen}
        onClose={() => setWizardOpen(false)}
        initialCluster={wizardCluster}
      />

      {/* Test Image Modal */}
      {testModalOpen && testCluster && (
        <TestImageModal
          cluster={testCluster}
          onClose={() => {
            setTestModalOpen(false);
            setTestCluster(null);
          }}
        />
      )}

      {/* Logs Modal */}
      {logsModal.open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/70" onClick={() => setLogsModal({ open: false, nodeId: '', container: '', logs: '', loading: false })} />
          <div className="relative bg-bg-secondary border border-border-default rounded-lg w-full max-w-4xl max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between p-4 border-b border-border-subtle">
              <h3 className="text-text-primary font-semibold">
                Logs: {logsModal.container} on {logsModal.nodeId}
              </h3>
              <button onClick={() => setLogsModal({ open: false, nodeId: '', container: '', logs: '', loading: false })} className="text-text-muted hover:text-text-primary">
                <X size={20} />
              </button>
            </div>
            <div className="flex-1 overflow-auto p-4">
              {logsModal.loading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="animate-spin text-text-accent" size={24} />
                </div>
              ) : (
                <pre className="text-xs text-text-secondary font-mono whitespace-pre-wrap bg-bg-primary p-4 rounded">
                  {logsModal.logs || 'No logs available'}
                </pre>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

const SparkCard = ({ node }) => {
  const { cpu = 0, memory = {}, gpu = {} } = node;

  return (
    <div className="bg-bg-tertiary border-2 border-cluster-spark rounded-lg p-4 glow-spark">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-cluster-spark/20 rounded-lg">
            <Server size={24} className="text-cluster-spark" />
          </div>
          <div>
            <h3 className="font-bold text-text-primary">DGX SPARK</h3>
            <p className="text-text-muted text-xs">Control Plane</p>
          </div>
        </div>
        <StatusDot status="online" size="lg" />
      </div>

      <div className="grid grid-cols-4 gap-4">
        <MiniStat label="CPU" value={`${cpu.toFixed(0)}%`} icon={Cpu} />
        <MiniStat label="GPU" value={`${gpu?.utilization || 0}%`} icon={Activity} />
        <MiniStat label="RAM" value={`${memory?.percent || 0}%`} icon={Server} />
        <MiniStat label="TEMP" value={`${gpu?.temperature || 'N/A'}°`} icon={HardDrive} />
      </div>
    </div>
  );
};

const MiniStat = ({ label, value, icon: Icon }) => (
  <div className="text-center p-2 bg-bg-secondary rounded">
    <Icon size={14} className="mx-auto text-text-muted mb-1" />
    <div className="text-text-primary text-sm font-mono">{value}</div>
    <div className="text-text-muted text-xs uppercase">{label}</div>
  </div>
);

const ClusterCard = ({ clusterId, config, nodes, nodeContainers = {}, onDeploy, onTest, onLogs, onDelete }) => {
  const Icon = config.icon;
  const online = nodes.filter(n => n.cpu !== undefined).length;
  const total = nodes.length;
  const hasTestable = clusterId === 'vision' && online > 0;

  // Calculate aggregate metrics
  const avgCpu = nodes.length > 0
    ? nodes.reduce((sum, n) => sum + (n.cpu || 0), 0) / nodes.length
    : 0;
  const avgGpu = nodes.length > 0
    ? nodes.reduce((sum, n) => sum + (n.gpu?.utilization || 0), 0) / nodes.length
    : 0;

  // Get REAL containers from this cluster's nodes
  const allContainers = nodes.flatMap(n => nodeContainers[n.node_id] || []);
  const containerCount = allContainers.length;

  return (
    <div className={clsx(
      'bg-bg-tertiary border border-border-default rounded-lg p-4 hover:border-border-bright transition-colors',
      nodes.length === 0 && 'opacity-50'
    )}>
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className={`p-1.5 bg-${config.color}/20 rounded`}>
            <Icon size={18} className={`text-${config.color}`} />
          </div>
          <div>
            <h3 className="font-semibold text-text-primary text-sm">{config.name}</h3>
            <p className="text-text-muted text-xs">
              {nodes.map(n => n.node_id).join(', ') || 'No nodes'}
            </p>
          </div>
        </div>
      </div>

      {/* Status */}
      <div className="flex items-center gap-1 mb-3">
        {Array.from({ length: Math.max(total, 2) }).map((_, i) => (
          <StatusDot key={i} status={i < online ? 'online' : 'offline'} size="sm" />
        ))}
        <span className="text-text-secondary text-xs ml-2">
          {online}/{total || '?'} Online
        </span>
      </div>

      {/* Metrics */}
      <div className="space-y-2 mb-3">
        <MetricBar label="CPU" value={avgCpu} type="cpu" />
        <MetricBar label="GPU" value={avgGpu} type="gpu" />
      </div>

      {/* REAL Running Containers */}
      <div className="pt-3 border-t border-border-subtle">
        <div className="flex items-center justify-between text-xs mb-2">
          <span className="text-text-muted">Running Containers:</span>
          <span className="text-text-primary font-mono">{containerCount}</span>
        </div>
        {allContainers.length > 0 ? (
          <div className="space-y-1 max-h-32 overflow-y-auto">
            {allContainers.map((c, i) => {
              const nodeId = nodes.find(n => (nodeContainers[n.node_id] || []).includes(c))?.node_id ||
                             nodes.find(n => (nodeContainers[n.node_id] || []).some(x => x.name === c.name))?.node_id;
              return (
                <div key={i} className="flex items-center gap-2 text-xs bg-bg-secondary p-1.5 rounded group">
                  <span className="w-2 h-2 bg-status-online rounded-full flex-shrink-0"></span>
                  <span className="text-text-primary font-mono truncate flex-1">{c.name}</span>
                  <span className="text-text-muted text-[10px]">{nodeId}</span>
                  <button
                    onClick={() => onLogs && onLogs(nodeId, c.name)}
                    className="opacity-0 group-hover:opacity-100 p-1 hover:bg-blue-500/20 rounded transition-all"
                    title="View Logs"
                  >
                    <FileText size={12} className="text-blue-400" />
                  </button>
                  <button
                    onClick={() => onDelete && onDelete(nodeId, c.name)}
                    className="opacity-0 group-hover:opacity-100 p-1 hover:bg-red-500/20 rounded transition-all"
                    title="Delete"
                  >
                    <Trash2 size={12} className="text-red-400" />
                  </button>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="text-text-muted text-xs italic">No containers running</div>
        )}
      </div>

      {/* Actions */}
      <div className="flex gap-2 mt-3">
        {hasTestable && (
          <button
            onClick={onTest}
            className="flex-1 py-1.5 text-xs bg-green-500/10 hover:bg-green-500/20 text-green-400 rounded transition-colors flex items-center justify-center gap-1"
          >
            <Sparkles size={12} />
            Test
          </button>
        )}
        <button
          onClick={onDeploy}
          className="flex-1 py-1.5 text-xs bg-text-accent/10 hover:bg-text-accent/20 text-text-accent rounded transition-colors flex items-center justify-center gap-1"
        >
          <Rocket size={12} />
          Deploy
        </button>
        <button className="flex-1 py-1.5 text-xs bg-bg-secondary hover:bg-bg-hover text-text-secondary rounded transition-colors">
          Manage
        </button>
      </div>
    </div>
  );
};

// Test Image Modal Component
const TestImageModal = ({ cluster, onClose }) => {
  const [prompt, setPrompt] = useState('A beautiful sunset over mountains, digital art, highly detailed');
  const [negativePrompt, setNegativePrompt] = useState('blurry, bad quality, worst quality, low quality');
  const [aspectRatio, setAspectRatio] = useState('1:1');
  const [steps, setSteps] = useState(30);
  const [cfg, setCfg] = useState(7.5);
  const [scheduler, setScheduler] = useState('euler_a');
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState(0);
  const [generatedImage, setGeneratedImage] = useState(null);
  const [error, setError] = useState(null);
  const [jobId, setJobId] = useState(null);

  const aspectRatios = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9'];
  const schedulers = ['euler_a', 'euler', 'dpm++', 'ddim', 'heun', 'lms'];

  const generateImage = async () => {
    setGenerating(true);
    setProgress(0);
    setError(null);
    setGeneratedImage(null);

    try {
      // Start generation
      const response = await fetch(`${SDXL_API}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          negative_prompt: negativePrompt,
          aspect_ratio: aspectRatio,
          steps,
          cfg,
          scheduler,
        }),
      });

      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }

      const job = await response.json();
      setJobId(job.job_id);

      // Poll for progress
      const pollInterval = setInterval(async () => {
        try {
          const statusRes = await fetch(`${SDXL_API}/job/${job.job_id}`);
          const status = await statusRes.json();

          setProgress(status.progress || 0);

          if (status.status === 'completed') {
            clearInterval(pollInterval);
            setGenerating(false);
            setGeneratedImage(`${SDXL_API}${status.image_url}`);
          } else if (status.status === 'failed' || status.status === 'cancelled') {
            clearInterval(pollInterval);
            setGenerating(false);
            setError(status.error || 'Generation failed');
          }
        } catch (e) {
          clearInterval(pollInterval);
          setGenerating(false);
          setError(`Failed to check status: ${e.message}`);
        }
      }, 1000);

    } catch (e) {
      setGenerating(false);
      setError(`Failed to start generation: ${e.message}`);
    }
  };

  const cancelGeneration = async () => {
    if (jobId) {
      try {
        await fetch(`${SDXL_API}/cancel/${jobId}`, { method: 'POST' });
        setGenerating(false);
        setError('Generation cancelled');
      } catch (e) {
        console.error('Failed to cancel:', e);
      }
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70" onClick={onClose} />
      <div className="relative bg-bg-secondary border border-border-default rounded-xl shadow-2xl w-full max-w-4xl max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border-subtle">
          <div className="flex items-center gap-2">
            <Sparkles size={20} className="text-green-400" />
            <h2 className="text-lg font-bold text-text-primary">Test SDXL Generation</h2>
            <span className="text-xs text-text-muted bg-bg-tertiary px-2 py-0.5 rounded">
              VISION Cluster
            </span>
          </div>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary">
            <X size={20} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-4">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Settings Panel */}
            <div className="space-y-4">
              {/* Prompt */}
              <div>
                <label className="block text-sm font-medium text-text-secondary mb-1">Prompt</label>
                <textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  rows={3}
                  className="w-full bg-bg-tertiary border border-border-subtle rounded-lg px-3 py-2 text-text-primary text-sm focus:outline-none focus:border-text-accent"
                  placeholder="Describe what you want to generate..."
                />
              </div>

              {/* Negative Prompt */}
              <div>
                <label className="block text-sm font-medium text-text-secondary mb-1">Negative Prompt</label>
                <textarea
                  value={negativePrompt}
                  onChange={(e) => setNegativePrompt(e.target.value)}
                  rows={2}
                  className="w-full bg-bg-tertiary border border-border-subtle rounded-lg px-3 py-2 text-text-primary text-sm focus:outline-none focus:border-text-accent"
                  placeholder="What to avoid..."
                />
              </div>

              {/* Settings Row */}
              <div className="grid grid-cols-2 gap-4">
                {/* Aspect Ratio */}
                <div>
                  <label className="block text-sm font-medium text-text-secondary mb-1">Aspect Ratio</label>
                  <select
                    value={aspectRatio}
                    onChange={(e) => setAspectRatio(e.target.value)}
                    className="w-full bg-bg-tertiary border border-border-subtle rounded-lg px-3 py-2 text-text-primary text-sm focus:outline-none focus:border-text-accent"
                  >
                    {aspectRatios.map(ar => (
                      <option key={ar} value={ar}>{ar}</option>
                    ))}
                  </select>
                </div>

                {/* Scheduler */}
                <div>
                  <label className="block text-sm font-medium text-text-secondary mb-1">Scheduler</label>
                  <select
                    value={scheduler}
                    onChange={(e) => setScheduler(e.target.value)}
                    className="w-full bg-bg-tertiary border border-border-subtle rounded-lg px-3 py-2 text-text-primary text-sm focus:outline-none focus:border-text-accent"
                  >
                    {schedulers.map(s => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </div>

                {/* Steps */}
                <div>
                  <label className="block text-sm font-medium text-text-secondary mb-1">Steps: {steps}</label>
                  <input
                    type="range"
                    min="10"
                    max="100"
                    value={steps}
                    onChange={(e) => setSteps(Number(e.target.value))}
                    className="w-full accent-text-accent"
                  />
                </div>

                {/* CFG */}
                <div>
                  <label className="block text-sm font-medium text-text-secondary mb-1">CFG: {cfg}</label>
                  <input
                    type="range"
                    min="1"
                    max="20"
                    step="0.5"
                    value={cfg}
                    onChange={(e) => setCfg(Number(e.target.value))}
                    className="w-full accent-text-accent"
                  />
                </div>
              </div>

              {/* Generate Button */}
              <div className="pt-2">
                {generating ? (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-text-secondary">Generating...</span>
                      <span className="text-text-primary font-mono">{progress}%</span>
                    </div>
                    <div className="h-2 bg-bg-tertiary rounded-full overflow-hidden">
                      <div
                        className="h-full bg-green-500 transition-all duration-300"
                        style={{ width: `${progress}%` }}
                      />
                    </div>
                    <button
                      onClick={cancelGeneration}
                      className="w-full py-2 bg-red-500/10 hover:bg-red-500/20 text-red-400 rounded-lg text-sm flex items-center justify-center gap-2"
                    >
                      <X size={16} />
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={generateImage}
                    disabled={!prompt.trim()}
                    className="w-full py-3 bg-green-500 hover:bg-green-600 disabled:bg-green-500/30 disabled:cursor-not-allowed text-white rounded-lg font-medium flex items-center justify-center gap-2 transition-colors"
                  >
                    <Sparkles size={18} />
                    Generate Image
                  </button>
                )}
              </div>

              {/* Error */}
              {error && (
                <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm">
                  {error}
                </div>
              )}
            </div>

            {/* Preview Panel */}
            <div className="flex flex-col">
              <label className="block text-sm font-medium text-text-secondary mb-2">Preview</label>
              <div className="flex-1 min-h-[300px] bg-bg-tertiary border border-border-subtle rounded-lg flex items-center justify-center overflow-hidden">
                {generatedImage ? (
                  <img
                    src={generatedImage}
                    alt="Generated"
                    className="max-w-full max-h-full object-contain"
                  />
                ) : generating ? (
                  <div className="text-center">
                    <Loader2 size={48} className="animate-spin text-text-accent mx-auto mb-2" />
                    <p className="text-text-muted text-sm">Generating image...</p>
                    <p className="text-text-muted text-xs mt-1">First generation loads the model</p>
                  </div>
                ) : (
                  <div className="text-center text-text-muted">
                    <Image size={48} className="mx-auto mb-2 opacity-30" />
                    <p className="text-sm">Generated image will appear here</p>
                  </div>
                )}
              </div>
              {generatedImage && (
                <div className="mt-2 flex gap-2">
                  <a
                    href={generatedImage}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex-1 py-2 bg-bg-tertiary hover:bg-bg-hover text-text-secondary rounded-lg text-sm text-center"
                  >
                    Open Full Size
                  </a>
                  <button
                    onClick={() => setGeneratedImage(null)}
                    className="flex-1 py-2 bg-bg-tertiary hover:bg-bg-hover text-text-secondary rounded-lg text-sm"
                  >
                    Clear
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

const RoamerPool = ({ roamers }) => {
  const available = roamers.filter(r => (r.cpu || 0) < 10).length;
  const active = roamers.length - available;

  return (
    <div className="bg-bg-tertiary border border-border-default rounded-lg p-4">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Zap size={20} className="text-cluster-roamer" />
          <h3 className="font-semibold text-text-primary">ROAMER POOL</h3>
        </div>
        <div className="text-text-muted text-sm">
          Available: {available}/{roamers.length}
        </div>
      </div>

      {/* Roamer Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {roamers.map(roamer => {
          const isIdle = (roamer.cpu || 0) < 10;
          return (
            <div
              key={roamer.node_id}
              className={clsx(
                'p-3 rounded-lg border text-center transition-colors',
                isIdle
                  ? 'bg-bg-secondary border-dashed border-border-subtle opacity-60'
                  : 'bg-status-busy/10 border-status-busy'
              )}
            >
              <div className="flex items-center justify-center gap-2 mb-1">
                <StatusDot status={isIdle ? 'offline' : 'busy'} size="sm" />
                <span className="font-medium text-text-primary text-sm">
                  {roamer.node_id}
                </span>
              </div>
              <div className="text-xs text-text-muted">
                {isIdle ? 'IDLE' : 'BUSY'}
              </div>
              {!isIdle && (
                <div className="mt-2">
                  <div className="h-1.5 bg-bg-primary rounded-full overflow-hidden">
                    <div
                      className="h-full bg-status-busy rounded-full"
                      style={{ width: `${Math.min(roamer.cpu || 0, 100)}%` }}
                    />
                  </div>
                </div>
              )}
            </div>
          );
        })}

        {/* Placeholder if no roamers */}
        {roamers.length === 0 && (
          <div className="col-span-4 text-center py-8 text-text-muted">
            No roamer nodes detected
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex gap-3 mt-4">
        <button className="px-4 py-2 text-sm bg-text-accent/10 text-text-accent hover:bg-text-accent/20 rounded-lg transition-colors">
          Assign Task
        </button>
        <button className="px-4 py-2 text-sm bg-bg-secondary hover:bg-bg-hover text-text-secondary rounded-lg transition-colors">
          Cleanup All
        </button>
      </div>
    </div>
  );
};

export default ClustersView;

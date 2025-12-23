import React, { useState, useEffect } from 'react';
import {
  X, Rocket, Package, Cpu, Server, HardDrive,
  Plus, Trash2, ChevronRight, ChevronLeft, Check,
  AlertCircle, Loader2
} from 'lucide-react';
import clsx from 'clsx';

const API_URL = `http://${window.location.hostname}:8765`;

// Available cluster targets
const clusterOptions = [
  { id: 'vision', name: 'VISION', description: 'Image generation (SDXL, FLUX)', color: 'cluster-vision' },
  { id: 'media-gen', name: 'MEDIA-GEN', description: 'Video generation (WAN, AnimateDiff)', color: 'cluster-media-gen' },
  { id: 'media-proc', name: 'MEDIA-PROC', description: 'Video processing, Lip sync', color: 'cluster-media-proc' },
  { id: 'llm', name: 'LLM', description: 'Language models (Llama, Mistral)', color: 'cluster-llm' },
  { id: 'voice', name: 'VOICE', description: 'Voice synthesis (Whisper, XTTS)', color: 'cluster-voice' },
  { id: 'music', name: 'MUSIC', description: 'Music generation (MusicGen)', color: 'cluster-music' },
  { id: 'agentic', name: 'AGENTIC', description: 'AI Agents (Bytebot, Browser automation)', color: 'cluster-agentic' },
];

// Local registry URL (images stored on spark to save AGX disk space)
const LOCAL_REGISTRY = '192.168.1.214:5000';

// Image metadata for known images
const imageMetadata = {
  'sdxl-trt': { description: 'SDXL TensorRT - Optimized for Jetson', port: 8080, recommended: true },
  'stable-diffusion-webui': { description: 'A1111 WebUI (R35 compatible)', port: 7860 },
  'comfyui': { description: 'ComfyUI - Full workflow UI', port: 8188 },
  'text-generation-webui': { description: 'Text Gen WebUI', port: 7860 },
  'ollama': { description: 'Ollama - Easy LLM serving', port: 11434 },
  'llama-cpp': { description: 'Llama.cpp - Fast inference', port: 8080 },
  'vllm': { description: 'vLLM - High throughput', port: 8000 },
  'whisper': { description: 'OpenAI Whisper STT', port: 9000 },
  'chatterbox-tts': { description: 'Chatterbox-Turbo TTS - Voice cloning', port: 8100, recommended: true },
  'xtts': { description: 'Coqui XTTS TTS', port: 8020 },
  'piper': { description: 'Piper TTS - Fast', port: 5000 },
  'audiocraft': { description: 'Meta AudioCraft/MusicGen', port: 7860 },
  'bytebot': { description: 'Bytebot - AI Desktop Agent', port: 9992, recommended: true },
  'browser-use': { description: 'Browser-Use - Web automation agent', port: 8000 },
  'open-interpreter': { description: 'Open Interpreter - Code execution agent', port: 8080 },
  'l4t-pytorch': { description: 'PyTorch base image', port: null },
  'l4t-base': { description: 'NVIDIA L4T base', port: null },
};

// Cluster to image mapping (which images are relevant for which cluster)
const clusterImageMap = {
  vision: ['comfyui', 'stable-diffusion-webui', 'sdxl-trt'],
  'media-gen': ['comfyui', 'text-generation-webui'],
  'media-proc': ['l4t-pytorch'],
  llm: ['ollama', 'llama-cpp', 'text-generation-webui', 'vllm'],
  voice: ['chatterbox-tts', 'whisper', 'xtts', 'piper'],
  music: ['audiocraft'],
  agentic: ['bytebot', 'browser-use', 'open-interpreter'],
};

// Default mounts per cluster
const clusterMounts = {
  vision: [
    { source: '/mnt/s3-models', target: '/models' },
    { source: '/mnt/s3-outputs', target: '/outputs' },
    { source: '/mnt/s3-loras', target: '/loras' },
  ],
  'media-gen': [
    { source: '/mnt/s3-models', target: '/models' },
    { source: '/mnt/s3-outputs', target: '/outputs' },
  ],
  'media-proc': [
    { source: '/mnt/s3-outputs', target: '/outputs' },
  ],
  llm: [
    { source: '/mnt/s3-models', target: '/models' },
  ],
  voice: [
    { source: '/mnt/s3-models', target: '/models' },
    { source: '/mnt/s3-outputs', target: '/outputs' },
    { source: '/mnt/s3-voices', target: '/voices' },
  ],
  music: [
    { source: '/mnt/s3-models', target: '/models' },
    { source: '/mnt/s3-outputs', target: '/outputs' },
  ],
  agentic: [
    { source: '/mnt/s3-outputs', target: '/outputs' },
    { source: '/mnt/s3-workspace', target: '/workspace' },
  ],
};

const DeploymentWizard = ({ isOpen, onClose, initialCluster }) => {
  const [step, setStep] = useState(1);
  const [deploying, setDeploying] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);

  // Registry images state
  const [registryImages, setRegistryImages] = useState([]);
  const [loadingImages, setLoadingImages] = useState(false);

  // Deployment tracking state
  const [deploymentId, setDeploymentId] = useState(null);
  const [deploymentStatus, setDeploymentStatus] = useState(null);
  const [deploymentPolling, setDeploymentPolling] = useState(false);

  // Form state
  const [config, setConfig] = useState({
    name: '',
    image: '',
    customImage: '',
    cluster: initialCluster || '',
    replicas: 1,
    mode: 'replicated',
    requireGpu: true,
    ports: [],
    env: [],
    mounts: [],
  });

  // Reset when opened
  useEffect(() => {
    if (isOpen) {
      setStep(1);
      setError(null);
      setSuccess(false);
      setDeploymentId(null);
      setDeploymentStatus(null);
      setDeploymentPolling(false);

      // Apply cluster and its default mounts when opening
      const selectedCluster = initialCluster || '';
      const defaultMounts = selectedCluster ? (clusterMounts[selectedCluster] || []) : [];

      setConfig(prev => ({
        ...prev,
        cluster: selectedCluster || prev.cluster,
        mounts: selectedCluster ? defaultMounts : prev.mounts,
      }));
    }
  }, [isOpen, initialCluster]);

  // Fetch images from registry via API (to avoid CORS)
  useEffect(() => {
    if (!isOpen) return;

    const fetchRegistryImages = async () => {
      setLoadingImages(true);
      try {
        // Fetch through our API which proxies to registry
        const res = await fetch(`${API_URL}/api/build/registry/images`);
        if (res.ok) {
          const data = await res.json();
          const images = data.images || [];

          // Transform to our format
          const formattedImages = images.map(img => {
            const meta = imageMetadata[img.name] || { description: img.name, port: null };
            // Sort tags - prefer r35 for JetPack 5.x
            const sortedTags = (img.tags || []).sort((a, b) => {
              const aIsR35 = a.includes('r35');
              const bIsR35 = b.includes('r35');
              if (aIsR35 && !bIsR35) return -1;
              if (!aIsR35 && bIsR35) return 1;
              return b.localeCompare(a, undefined, { numeric: true });
            });

            return {
              name: img.name,
              tags: sortedTags,
              latestTag: sortedTags[0] || 'latest',
              image: `${LOCAL_REGISTRY}/${img.name}:${sortedTags[0] || 'latest'}`,
              description: meta.description,
              port: meta.port,
              recommended: img.name === 'sdxl-trt', // SDXL-TRT is recommended
            };
          });

          setRegistryImages(formattedImages);
        }
      } catch (e) {
        console.error('Failed to fetch registry images:', e);
      }
      setLoadingImages(false);
    };

    fetchRegistryImages();
  }, [isOpen]);

  // Poll deployment status
  useEffect(() => {
    if (!deploymentPolling || !config.name) return;

    const pollInterval = setInterval(async () => {
      try {
        const res = await fetch(`${API_URL}/api/swarm/services/${config.name}`);
        if (!res.ok) {
          // Service not found yet, keep polling
          setDeploymentStatus({ state: 'creating', message: 'Creating service...' });
          return;
        }
        const service = await res.json();
        const tasks = service.tasks || [];

        // Find the most relevant task state
        const runningTasks = tasks.filter(t => t.state === 'running');
        const preparingTasks = tasks.filter(t => t.state === 'preparing' || t.state === 'starting');
        const failedTasks = tasks.filter(t => t.state === 'failed' || t.state === 'rejected');
        const pendingTasks = tasks.filter(t => t.state === 'pending' || t.state === 'assigned' || t.state === 'accepted');

        if (runningTasks.length > 0) {
          // Success!
          setDeploymentStatus({
            state: 'running',
            message: `Running on ${runningTasks.length} node(s)`,
            running: runningTasks.length,
            desired: service.replicas || 1
          });
          setDeploymentPolling(false);
          setSuccess(true);
        } else if (preparingTasks.length > 0) {
          // Image pulling or starting
          const task = preparingTasks[0];
          setDeploymentStatus({
            state: 'preparing',
            message: task.message || 'Pulling image...',
            tasks: preparingTasks.length
          });
        } else if (pendingTasks.length > 0) {
          setDeploymentStatus({
            state: 'pending',
            message: 'Waiting for node assignment...',
            tasks: pendingTasks.length
          });
        } else if (failedTasks.length > 0) {
          // Deployment failed
          const task = failedTasks[0];
          setDeploymentStatus({
            state: 'failed',
            message: task.error || task.message || 'Deployment failed'
          });
          setError(task.error || task.message || 'Deployment failed');
          setDeploymentPolling(false);
        } else if (tasks.length === 0) {
          setDeploymentStatus({
            state: 'creating',
            message: 'Initializing service...'
          });
        }
      } catch (err) {
        console.error('Error polling deployment status:', err);
      }
    }, 2000);

    return () => clearInterval(pollInterval);
  }, [deploymentPolling, config.name]);

  const updateConfig = (key, value) => {
    setConfig(prev => ({ ...prev, [key]: value }));
  };

  const addPort = () => {
    setConfig(prev => ({
      ...prev,
      ports: [...prev.ports, { target_port: 8080, published_port: 8080 }],
    }));
  };

  const updatePort = (index, field, value) => {
    setConfig(prev => ({
      ...prev,
      ports: prev.ports.map((p, i) => i === index ? { ...p, [field]: parseInt(value) || 0 } : p),
    }));
  };

  const removePort = (index) => {
    setConfig(prev => ({
      ...prev,
      ports: prev.ports.filter((_, i) => i !== index),
    }));
  };

  const addEnv = () => {
    setConfig(prev => ({
      ...prev,
      env: [...prev.env, { key: '', value: '' }],
    }));
  };

  const updateEnv = (index, field, value) => {
    setConfig(prev => ({
      ...prev,
      env: prev.env.map((e, i) => i === index ? { ...e, [field]: value } : e),
    }));
  };

  const removeEnv = (index) => {
    setConfig(prev => ({
      ...prev,
      env: prev.env.filter((_, i) => i !== index),
    }));
  };

  const addMount = () => {
    setConfig(prev => ({
      ...prev,
      mounts: [...prev.mounts, { source: '', target: '' }],
    }));
  };

  const updateMount = (index, field, value) => {
    setConfig(prev => ({
      ...prev,
      mounts: prev.mounts.map((m, i) => i === index ? { ...m, [field]: value } : m),
    }));
  };

  const removeMount = (index) => {
    setConfig(prev => ({
      ...prev,
      mounts: prev.mounts.filter((_, i) => i !== index),
    }));
  };

  const canProceed = () => {
    switch (step) {
      case 1: return config.cluster !== '';
      case 2: return config.name.trim() !== '' && (config.image !== '' || config.customImage.trim() !== '');
      case 3: return true;
      case 4: return true;
      default: return false;
    }
  };

  const handleDeploy = async () => {
    setDeploying(true);
    setError(null);

    try {
      const finalImage = config.image === 'custom' ? config.customImage : config.image;

      // Get nodes from the selected cluster to find a target
      const nodesRes = await fetch(`${API_URL}/api/nodes`);
      const allNodes = await nodesRes.json();
      const clusterNodes = allNodes.filter(n =>
        n.cluster?.toLowerCase() === config.cluster.toLowerCase()
      );

      if (clusterNodes.length === 0) {
        throw new Error(`No nodes available in cluster ${config.cluster}`);
      }

      // Pick first available node
      const targetNode = clusterNodes[0];

      // Build env dict
      const envDict = {};
      config.env
        .filter(e => e.key.trim() !== '')
        .forEach(e => { envDict[e.key] = e.value; });

      // Build mounts array as strings "source:target"
      const mounts = config.mounts
        .filter(m => m.source.trim() !== '' && m.target.trim() !== '')
        .map(m => `${m.source}:${m.target}`);

      // Get port from config
      const hostPort = config.ports.length > 0 ? config.ports[0].published : 8080;
      const containerPort = config.ports.length > 0 ? config.ports[0].target : 8080;

      const payload = {
        node_id: targetNode.node_id,
        image: finalImage,
        name: config.name,
        port: containerPort,
        host_port: hostPort,
        env: envDict,
        mounts: mounts,
        gpus: config.requireGpu,
      };

      // Use new SSH-based deploy endpoint (bypasses broken Swarm GPU)
      const response = await fetch(`${API_URL}/api/fleet/deploy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.detail || 'Failed to deploy container');
      }

      // Success - show result directly
      setDeploymentStatus({
        state: 'running',
        message: `Deployed to ${data.node} at ${data.url}`,
        running: 1,
        desired: 1,
        url: data.url
      });
      setSuccess(true);
      setStep(5);

    } catch (err) {
      setError(err.message);
      setDeploying(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative bg-bg-secondary border border-border-default rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border-subtle">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-text-accent/10 rounded-lg">
              <Rocket size={20} className="text-text-accent" />
            </div>
            <div>
              <h2 className="font-bold text-text-primary">Deploy Service</h2>
              <p className="text-text-muted text-sm">Step {step} of 4</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-bg-hover rounded-lg text-text-muted hover:text-text-primary transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        {/* Progress Bar */}
        <div className="h-1 bg-bg-tertiary">
          <div
            className={clsx(
              'h-full transition-all duration-300',
              step === 5 && success ? 'bg-status-online' : 'bg-text-accent',
              step === 5 && deploymentPolling && 'animate-pulse'
            )}
            style={{ width: step === 5 ? '100%' : `${(step / 4) * 100}%` }}
          />
        </div>

        {/* Content */}
        <div className="p-6 overflow-y-auto max-h-[60vh]">
          {/* Step 5: Deployment Status */}
          {step === 5 ? (
            <div className="text-center py-8">
              {success ? (
                <>
                  <div className="w-16 h-16 bg-status-online/20 rounded-full flex items-center justify-center mx-auto mb-4">
                    <Check size={32} className="text-status-online" />
                  </div>
                  <h3 className="text-xl font-bold text-text-primary mb-2">Service Running!</h3>
                  <p className="text-text-muted mb-4">
                    {config.name} is now running on the {config.cluster.toUpperCase()} cluster.
                  </p>
                  <button
                    onClick={onClose}
                    className="px-6 py-2 bg-text-accent text-white rounded-lg hover:bg-text-accent/90 transition-colors"
                  >
                    Done
                  </button>
                </>
              ) : error ? (
                <>
                  <div className="w-16 h-16 bg-status-error/20 rounded-full flex items-center justify-center mx-auto mb-4">
                    <AlertCircle size={32} className="text-status-error" />
                  </div>
                  <h3 className="text-xl font-bold text-text-primary mb-2">Deployment Failed</h3>
                  <p className="text-status-error mb-2 font-mono text-sm bg-status-error/10 p-3 rounded-lg">
                    {error}
                  </p>
                  <p className="text-text-muted text-sm mb-4">
                    Check node availability and image accessibility.
                  </p>
                  <div className="flex gap-3 justify-center">
                    <button
                      onClick={() => {
                        setStep(4);
                        setError(null);
                        setDeploymentStatus(null);
                        setDeploying(false);
                      }}
                      className="px-4 py-2 bg-bg-tertiary text-text-secondary rounded-lg hover:bg-bg-hover transition-colors"
                    >
                      Back to Config
                    </button>
                    <button
                      onClick={onClose}
                      className="px-4 py-2 bg-status-error/10 text-status-error rounded-lg hover:bg-status-error/20 transition-colors"
                    >
                      Close
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="w-20 h-20 relative mx-auto mb-6">
                    {/* Spinning progress ring */}
                    <svg className="w-20 h-20 animate-spin" viewBox="0 0 80 80">
                      <circle
                        cx="40"
                        cy="40"
                        r="35"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="6"
                        className="text-bg-tertiary"
                      />
                      <circle
                        cx="40"
                        cy="40"
                        r="35"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="6"
                        strokeDasharray="110 110"
                        strokeLinecap="round"
                        className="text-text-accent"
                      />
                    </svg>
                    <div className="absolute inset-0 flex items-center justify-center">
                      <Rocket size={24} className="text-text-accent" />
                    </div>
                  </div>
                  <h3 className="text-xl font-bold text-text-primary mb-2">Deploying Service</h3>

                  {/* Status message */}
                  <div className="bg-bg-tertiary rounded-lg p-4 mb-4 text-left max-w-md mx-auto">
                    <div className="flex items-center gap-3 mb-3">
                      <span className="text-text-muted text-sm">Service:</span>
                      <span className="text-text-primary font-mono">{config.name}</span>
                    </div>
                    <div className="flex items-center gap-3 mb-3">
                      <span className="text-text-muted text-sm">Cluster:</span>
                      <span className="text-text-primary">{config.cluster.toUpperCase()}</span>
                    </div>
                    <div className="flex items-start gap-3">
                      <span className="text-text-muted text-sm">Status:</span>
                      <div className="flex-1">
                        <span className={clsx(
                          'text-sm',
                          deploymentStatus?.state === 'preparing' && 'text-status-warning',
                          deploymentStatus?.state === 'pending' && 'text-text-secondary',
                          deploymentStatus?.state === 'creating' && 'text-text-accent'
                        )}>
                          {deploymentStatus?.message || 'Starting...'}
                        </span>
                        {deploymentStatus?.state === 'preparing' && (
                          <div className="mt-2">
                            <div className="h-1.5 bg-bg-secondary rounded-full overflow-hidden">
                              <div className="h-full bg-status-warning rounded-full animate-pulse" style={{ width: '60%' }} />
                            </div>
                            <p className="text-text-muted text-xs mt-1">
                              Pulling image... This may take a few minutes for large images.
                            </p>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  <p className="text-text-muted text-sm">
                    Waiting for service to start...
                  </p>
                </>
              )}
            </div>
          ) : (
            <>
              {/* Step 1: Select Cluster */}
              {step === 1 && (
                <div>
                  <h3 className="text-lg font-semibold text-text-primary mb-2">Select Target Cluster</h3>
                  <p className="text-text-muted text-sm mb-6">Choose which GPU cluster should run this service.</p>

                  <div className="grid grid-cols-2 gap-3">
                    {clusterOptions.map(cluster => (
                      <button
                        key={cluster.id}
                        onClick={() => {
                          // Apply cluster AND default mounts together in one state update
                          const defaultMounts = clusterMounts[cluster.id] || [];
                          setConfig(prev => ({
                            ...prev,
                            cluster: cluster.id,
                            mounts: defaultMounts
                          }));
                        }}
                        className={clsx(
                          'p-4 rounded-lg border text-left transition-all',
                          config.cluster === cluster.id
                            ? `border-${cluster.color} bg-${cluster.color}/10`
                            : 'border-border-default bg-bg-tertiary hover:border-border-bright'
                        )}
                      >
                        <div className="font-semibold text-text-primary">{cluster.name}</div>
                        <div className="text-text-muted text-xs mt-1">{cluster.description}</div>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Step 2: Service Configuration */}
              {step === 2 && (
                <div>
                  <h3 className="text-lg font-semibold text-text-primary mb-2">Service Configuration</h3>
                  <p className="text-text-muted text-sm mb-6">Select an image for your {config.cluster.toUpperCase()} cluster.</p>

                  <div className="space-y-4">
                    {/* Docker Image Selection */}
                    <div>
                      <label className="block text-text-secondary text-sm mb-2">Select Image</label>
                      {loadingImages ? (
                        <div className="flex items-center justify-center py-8 text-text-muted">
                          <Loader2 size={20} className="animate-spin mr-2" />
                          Loading images from registry...
                        </div>
                      ) : (
                      <div className="space-y-2">
                        {/* Filter images by cluster relevance, or show all if no mapping */}
                        {(registryImages.length > 0
                          ? registryImages.filter(img =>
                              !clusterImageMap[config.cluster] ||
                              clusterImageMap[config.cluster].includes(img.name)
                            )
                          : []
                        ).map((img, idx) => (
                          <button
                            key={img.image}
                            onClick={() => {
                              updateConfig('image', img.image);
                              // Auto-fill service name from image
                              const imageName = img.name;
                              if (!config.name || config.name === '') {
                                updateConfig('name', `${config.cluster}-${imageName}`);
                              }
                              // Auto-add port if defined
                              if (img.port && config.ports.length === 0) {
                                setConfig(prev => ({
                                  ...prev,
                                  ports: [{ target_port: img.port, published_port: img.port }]
                                }));
                              }
                            }}
                            className={clsx(
                              'w-full p-3 rounded-lg border text-left transition-all relative',
                              config.image === img.image
                                ? 'border-text-accent bg-text-accent/10 ring-2 ring-text-accent/30'
                                : img.recommended
                                  ? 'border-status-online/50 bg-status-online/5 hover:border-status-online'
                                  : 'border-border-default bg-bg-tertiary hover:border-border-bright'
                            )}
                          >
                            {img.recommended && (
                              <span className="absolute -top-2 right-2 px-2 py-0.5 bg-status-online text-white text-xs rounded-full">
                                Recommended
                              </span>
                            )}
                            <div className="flex items-center justify-between">
                              <div>
                                <div className="text-text-primary font-semibold">{img.name}</div>
                                <div className="text-text-muted text-xs">{img.description}</div>
                              </div>
                              {img.port && (
                                <span className="px-2 py-1 bg-bg-secondary rounded text-text-muted text-xs font-mono">
                                  :{img.port}
                                </span>
                              )}
                            </div>
                            <div className="text-text-muted text-xs font-mono mt-1 truncate opacity-60">{img.image}</div>
                            {/* Show available tags */}
                            {img.tags && img.tags.length > 1 && (
                              <div className="flex flex-wrap gap-1 mt-2">
                                {img.tags.slice(0, 5).map(tag => (
                                  <button
                                    key={tag}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      const newImage = `${LOCAL_REGISTRY}/${img.name}:${tag}`;
                                      updateConfig('image', newImage);
                                      if (!config.name) {
                                        updateConfig('name', `${config.cluster}-${img.name}`);
                                      }
                                    }}
                                    className={clsx(
                                      'px-2 py-0.5 text-xs rounded border transition-colors',
                                      config.image === `${LOCAL_REGISTRY}/${img.name}:${tag}`
                                        ? 'bg-text-accent text-white border-text-accent'
                                        : 'bg-bg-secondary text-text-muted border-border-subtle hover:border-text-accent'
                                    )}
                                  >
                                    {tag}
                                  </button>
                                ))}
                              </div>
                            )}
                          </button>
                        ))}

                        {/* Custom Image Option */}
                        <button
                          onClick={() => updateConfig('image', 'custom')}
                          className={clsx(
                            'w-full p-3 rounded-lg border text-left transition-all',
                            config.image === 'custom'
                              ? 'border-text-accent bg-text-accent/10'
                              : 'border-dashed border-border-default bg-bg-tertiary hover:border-border-bright'
                          )}
                        >
                          <div className="text-text-secondary">Use Custom Image...</div>
                        </button>
                      </div>
                      )}
                      {config.image === 'custom' && (
                        <input
                          type="text"
                          value={config.customImage}
                          onChange={(e) => {
                            updateConfig('customImage', e.target.value);
                            // Auto-fill service name from custom image
                            const imageName = e.target.value.split('/').pop().split(':')[0];
                            if (imageName && !config.name) {
                              updateConfig('name', `${config.cluster}-${imageName}`);
                            }
                          }}
                          placeholder="docker.io/your/image:tag"
                          className="w-full bg-bg-tertiary border border-border-default rounded-lg px-4 py-2 text-text-primary placeholder:text-text-muted focus:outline-none focus:border-text-accent mt-2"
                        />
                      )}
                    </div>

                    {/* Service Name */}
                    <div>
                      <label className="block text-text-secondary text-sm mb-2">Service Name</label>
                      <input
                        type="text"
                        value={config.name}
                        onChange={(e) => updateConfig('name', e.target.value)}
                        placeholder="my-service-name"
                        className="w-full bg-bg-tertiary border border-border-default rounded-lg px-4 py-2 text-text-primary placeholder:text-text-muted focus:outline-none focus:border-text-accent font-mono"
                      />
                      <p className="text-text-muted text-xs mt-1">Auto-filled from image selection. You can customize it.</p>
                    </div>

                    {/* Deployment Mode */}
                    <div>
                      <label className="block text-text-secondary text-sm mb-2">Deployment Mode</label>
                      <div className="flex gap-3">
                        <button
                          onClick={() => updateConfig('mode', 'replicated')}
                          className={clsx(
                            'flex-1 p-3 rounded-lg border text-center transition-colors',
                            config.mode === 'replicated'
                              ? 'border-text-accent bg-text-accent/10'
                              : 'border-border-default bg-bg-tertiary hover:border-border-bright'
                          )}
                        >
                          <Server size={20} className="mx-auto mb-1 text-text-primary" />
                          <div className="text-text-primary text-sm font-medium">Replicated</div>
                          <div className="text-text-muted text-xs">Specific replica count</div>
                        </button>
                        <button
                          onClick={() => updateConfig('mode', 'global')}
                          className={clsx(
                            'flex-1 p-3 rounded-lg border text-center transition-colors',
                            config.mode === 'global'
                              ? 'border-text-accent bg-text-accent/10'
                              : 'border-border-default bg-bg-tertiary hover:border-border-bright'
                          )}
                        >
                          <HardDrive size={20} className="mx-auto mb-1 text-text-primary" />
                          <div className="text-text-primary text-sm font-medium">Global</div>
                          <div className="text-text-muted text-xs">One per node</div>
                        </button>
                      </div>
                    </div>

                    {/* Replicas (if replicated) */}
                    {config.mode === 'replicated' && (
                      <div>
                        <label className="block text-text-secondary text-sm mb-2">Replicas</label>
                        <input
                          type="number"
                          min="1"
                          max="10"
                          value={config.replicas}
                          onChange={(e) => updateConfig('replicas', parseInt(e.target.value) || 1)}
                          className="w-24 bg-bg-tertiary border border-border-default rounded-lg px-4 py-2 text-text-primary focus:outline-none focus:border-text-accent"
                        />
                      </div>
                    )}

                    {/* Require GPU */}
                    <div className="flex items-center gap-3">
                      <button
                        onClick={() => updateConfig('requireGpu', !config.requireGpu)}
                        className={clsx(
                          'w-12 h-6 rounded-full transition-colors relative',
                          config.requireGpu ? 'bg-text-accent' : 'bg-bg-tertiary border border-border-default'
                        )}
                      >
                        <div className={clsx(
                          'absolute top-1 w-4 h-4 rounded-full bg-white transition-transform',
                          config.requireGpu ? 'left-7' : 'left-1'
                        )} />
                      </button>
                      <div>
                        <div className="text-text-primary text-sm">Require NVIDIA GPU</div>
                        <div className="text-text-muted text-xs">Constraint: node.labels.nvidia==true</div>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Step 3: Ports & Environment */}
              {step === 3 && (
                <div>
                  <h3 className="text-lg font-semibold text-text-primary mb-2">Ports & Environment</h3>
                  <p className="text-text-muted text-sm mb-6">Configure network ports and environment variables.</p>

                  <div className="space-y-6">
                    {/* Ports */}
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <label className="text-text-secondary text-sm">Port Mappings</label>
                        <button
                          onClick={addPort}
                          className="flex items-center gap-1 text-xs text-text-accent hover:text-text-accent/80"
                        >
                          <Plus size={14} /> Add Port
                        </button>
                      </div>
                      {config.ports.length === 0 ? (
                        <div className="text-text-muted text-sm py-4 text-center bg-bg-tertiary rounded-lg border border-dashed border-border-subtle">
                          No port mappings configured
                        </div>
                      ) : (
                        <div className="space-y-2">
                          {config.ports.map((port, index) => (
                            <div key={index} className="flex items-center gap-2">
                              <input
                                type="number"
                                value={port.published_port}
                                onChange={(e) => updatePort(index, 'published_port', e.target.value)}
                                placeholder="Host"
                                className="w-24 bg-bg-tertiary border border-border-default rounded px-3 py-1.5 text-text-primary text-sm"
                              />
                              <span className="text-text-muted">:</span>
                              <input
                                type="number"
                                value={port.target_port}
                                onChange={(e) => updatePort(index, 'target_port', e.target.value)}
                                placeholder="Container"
                                className="w-24 bg-bg-tertiary border border-border-default rounded px-3 py-1.5 text-text-primary text-sm"
                              />
                              <button
                                onClick={() => removePort(index)}
                                className="p-1.5 text-text-muted hover:text-status-error transition-colors"
                              >
                                <Trash2 size={14} />
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Environment Variables */}
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <label className="text-text-secondary text-sm">Environment Variables</label>
                        <button
                          onClick={addEnv}
                          className="flex items-center gap-1 text-xs text-text-accent hover:text-text-accent/80"
                        >
                          <Plus size={14} /> Add Variable
                        </button>
                      </div>
                      {config.env.length === 0 ? (
                        <div className="text-text-muted text-sm py-4 text-center bg-bg-tertiary rounded-lg border border-dashed border-border-subtle">
                          No environment variables configured
                        </div>
                      ) : (
                        <div className="space-y-2">
                          {config.env.map((env, index) => (
                            <div key={index} className="flex items-center gap-2">
                              <input
                                type="text"
                                value={env.key}
                                onChange={(e) => updateEnv(index, 'key', e.target.value)}
                                placeholder="KEY"
                                className="w-32 bg-bg-tertiary border border-border-default rounded px-3 py-1.5 text-text-primary text-sm font-mono"
                              />
                              <span className="text-text-muted">=</span>
                              <input
                                type="text"
                                value={env.value}
                                onChange={(e) => updateEnv(index, 'value', e.target.value)}
                                placeholder="value"
                                className="flex-1 bg-bg-tertiary border border-border-default rounded px-3 py-1.5 text-text-primary text-sm"
                              />
                              <button
                                onClick={() => removeEnv(index)}
                                className="p-1.5 text-text-muted hover:text-status-error transition-colors"
                              >
                                <Trash2 size={14} />
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* Step 4: Volume Mounts & Review */}
              {step === 4 && (
                <div>
                  <h3 className="text-lg font-semibold text-text-primary mb-2">Volume Mounts & Review</h3>
                  <p className="text-text-muted text-sm mb-6">Add volume mounts and review your configuration.</p>

                  <div className="space-y-6">
                    {/* Volume Mounts */}
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <label className="text-text-secondary text-sm">Volume Mounts</label>
                        <button
                          onClick={addMount}
                          className="flex items-center gap-1 text-xs text-text-accent hover:text-text-accent/80"
                        >
                          <Plus size={14} /> Add Mount
                        </button>
                      </div>

                      {/* Pre-configured mounts suggestion */}
                      <div className="mb-3 p-3 bg-bg-tertiary rounded-lg border border-border-subtle">
                        <div className="text-text-muted text-xs mb-2">Quick add:</div>
                        <div className="flex flex-wrap gap-2">
                          <button
                            onClick={() => setConfig(prev => ({
                              ...prev,
                              mounts: [...prev.mounts.filter(m => m.source !== '/mnt/s3-models'), { source: '/mnt/s3-models', target: '/models' }]
                            }))}
                            disabled={config.mounts.some(m => m.source === '/mnt/s3-models')}
                            className={clsx(
                              'text-xs px-2 py-1 rounded border transition-colors',
                              config.mounts.some(m => m.source === '/mnt/s3-models')
                                ? 'bg-status-online/20 border-status-online text-status-online'
                                : 'bg-bg-secondary border-border-default hover:border-text-accent text-text-secondary'
                            )}
                          >
                            {config.mounts.some(m => m.source === '/mnt/s3-models') ? '✓ Models' : '+ S3 Models'}
                          </button>
                          <button
                            onClick={() => setConfig(prev => ({
                              ...prev,
                              mounts: [...prev.mounts.filter(m => m.source !== '/mnt/s3-outputs'), { source: '/mnt/s3-outputs', target: '/outputs' }]
                            }))}
                            disabled={config.mounts.some(m => m.source === '/mnt/s3-outputs')}
                            className={clsx(
                              'text-xs px-2 py-1 rounded border transition-colors',
                              config.mounts.some(m => m.source === '/mnt/s3-outputs')
                                ? 'bg-status-online/20 border-status-online text-status-online'
                                : 'bg-bg-secondary border-border-default hover:border-text-accent text-text-secondary'
                            )}
                          >
                            {config.mounts.some(m => m.source === '/mnt/s3-outputs') ? '✓ Outputs' : '+ S3 Outputs'}
                          </button>
                          <button
                            onClick={() => setConfig(prev => ({
                              ...prev,
                              mounts: [...prev.mounts.filter(m => m.source !== '/mnt/s3-loras'), { source: '/mnt/s3-loras', target: '/loras' }]
                            }))}
                            disabled={config.mounts.some(m => m.source === '/mnt/s3-loras')}
                            className={clsx(
                              'text-xs px-2 py-1 rounded border transition-colors',
                              config.mounts.some(m => m.source === '/mnt/s3-loras')
                                ? 'bg-status-online/20 border-status-online text-status-online'
                                : 'bg-bg-secondary border-border-default hover:border-text-accent text-text-secondary'
                            )}
                          >
                            {config.mounts.some(m => m.source === '/mnt/s3-loras') ? '✓ Loras' : '+ S3 Loras'}
                          </button>
                          <button
                            onClick={() => setConfig(prev => ({
                              ...prev,
                              mounts: [...prev.mounts.filter(m => m.source !== '/mnt/s3-voices'), { source: '/mnt/s3-voices', target: '/voices' }]
                            }))}
                            disabled={config.mounts.some(m => m.source === '/mnt/s3-voices')}
                            className={clsx(
                              'text-xs px-2 py-1 rounded border transition-colors',
                              config.mounts.some(m => m.source === '/mnt/s3-voices')
                                ? 'bg-status-online/20 border-status-online text-status-online'
                                : 'bg-bg-secondary border-border-default hover:border-text-accent text-text-secondary'
                            )}
                          >
                            {config.mounts.some(m => m.source === '/mnt/s3-voices') ? '✓ Voices' : '+ S3 Voices'}
                          </button>
                          <button
                            onClick={() => setConfig(prev => ({
                              ...prev,
                              mounts: [...prev.mounts.filter(m => m.source !== '/mnt/s3-workspace'), { source: '/mnt/s3-workspace', target: '/workspace' }]
                            }))}
                            disabled={config.mounts.some(m => m.source === '/mnt/s3-workspace')}
                            className={clsx(
                              'text-xs px-2 py-1 rounded border transition-colors',
                              config.mounts.some(m => m.source === '/mnt/s3-workspace')
                                ? 'bg-status-online/20 border-status-online text-status-online'
                                : 'bg-bg-secondary border-border-default hover:border-text-accent text-text-secondary'
                            )}
                          >
                            {config.mounts.some(m => m.source === '/mnt/s3-workspace') ? '✓ Workspace' : '+ S3 Workspace'}
                          </button>
                        </div>
                      </div>

                      {config.mounts.length === 0 ? (
                        <div className="text-text-muted text-sm py-4 text-center bg-bg-tertiary rounded-lg border border-dashed border-border-subtle">
                          No volume mounts configured
                        </div>
                      ) : (
                        <div className="space-y-2">
                          {config.mounts.map((mount, index) => (
                            <div key={index} className="flex items-center gap-2">
                              <input
                                type="text"
                                value={mount.source}
                                onChange={(e) => updateMount(index, 'source', e.target.value)}
                                placeholder="/host/path"
                                className="flex-1 bg-bg-tertiary border border-border-default rounded px-3 py-1.5 text-text-primary text-sm font-mono"
                              />
                              <span className="text-text-muted">→</span>
                              <input
                                type="text"
                                value={mount.target}
                                onChange={(e) => updateMount(index, 'target', e.target.value)}
                                placeholder="/container/path"
                                className="flex-1 bg-bg-tertiary border border-border-default rounded px-3 py-1.5 text-text-primary text-sm font-mono"
                              />
                              <button
                                onClick={() => removeMount(index)}
                                className="p-1.5 text-text-muted hover:text-status-error transition-colors"
                              >
                                <Trash2 size={14} />
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Review Summary */}
                    <div className="p-4 bg-bg-tertiary rounded-lg border border-border-default">
                      <h4 className="text-text-primary font-semibold mb-3">Configuration Summary</h4>
                      <div className="grid grid-cols-2 gap-3 text-sm">
                        <div>
                          <span className="text-text-muted">Service:</span>
                          <span className="text-text-primary ml-2 font-mono">{config.name || '-'}</span>
                        </div>
                        <div>
                          <span className="text-text-muted">Cluster:</span>
                          <span className="text-text-primary ml-2">{config.cluster.toUpperCase()}</span>
                        </div>
                        <div className="col-span-2">
                          <span className="text-text-muted">Image:</span>
                          <span className="text-text-primary ml-2 font-mono text-xs">
                            {config.image === 'custom' ? config.customImage : config.image || '-'}
                          </span>
                        </div>
                        <div>
                          <span className="text-text-muted">Mode:</span>
                          <span className="text-text-primary ml-2">{config.mode}</span>
                        </div>
                        <div>
                          <span className="text-text-muted">Replicas:</span>
                          <span className="text-text-primary ml-2">{config.mode === 'global' ? 'All nodes' : config.replicas}</span>
                        </div>
                        <div>
                          <span className="text-text-muted">GPU Required:</span>
                          <span className={clsx('ml-2', config.requireGpu ? 'text-status-online' : 'text-text-muted')}>
                            {config.requireGpu ? 'Yes' : 'No'}
                          </span>
                        </div>
                        <div>
                          <span className="text-text-muted">Ports:</span>
                          <span className="text-text-primary ml-2">{config.ports.length || 'None'}</span>
                        </div>
                        <div>
                          <span className="text-text-muted">Mounts:</span>
                          <span className="text-text-primary ml-2">{config.mounts.length || 'None'}</span>
                        </div>
                      </div>
                      {/* Show mount details if any */}
                      {config.mounts.length > 0 && (
                        <div className="mt-3 pt-3 border-t border-border-subtle">
                          <span className="text-text-muted text-xs block mb-2">Volume Mounts:</span>
                          <div className="space-y-1">
                            {config.mounts.map((m, i) => (
                              <div key={i} className="text-xs font-mono text-text-secondary">
                                {m.source} → {m.target}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Error Message */}
                    {error && (
                      <div className="flex items-center gap-2 p-3 bg-status-error/10 border border-status-error/20 rounded-lg text-status-error">
                        <AlertCircle size={16} />
                        <span className="text-sm">{error}</span>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        {step !== 5 && (
          <div className="flex items-center justify-between p-4 border-t border-border-subtle bg-bg-tertiary">
            <button
              onClick={() => setStep(prev => prev - 1)}
              disabled={step === 1}
              className={clsx(
                'flex items-center gap-2 px-4 py-2 rounded-lg transition-colors',
                step === 1
                  ? 'text-text-muted cursor-not-allowed'
                  : 'text-text-secondary hover:text-text-primary hover:bg-bg-hover'
              )}
            >
              <ChevronLeft size={16} />
              Back
            </button>

            {step < 4 ? (
              <button
                onClick={() => setStep(prev => prev + 1)}
                disabled={!canProceed()}
                className={clsx(
                  'flex items-center gap-2 px-6 py-2 rounded-lg font-medium transition-colors',
                  canProceed()
                    ? 'bg-text-accent text-white hover:bg-text-accent/90'
                    : 'bg-bg-secondary text-text-muted cursor-not-allowed'
                )}
              >
                Next
                <ChevronRight size={16} />
              </button>
            ) : (
              <button
                onClick={handleDeploy}
                disabled={deploying || !canProceed()}
                className={clsx(
                  'flex items-center gap-2 px-6 py-2 rounded-lg font-medium transition-colors',
                  deploying
                    ? 'bg-text-accent/50 text-white cursor-wait'
                    : 'bg-text-accent text-white hover:bg-text-accent/90'
                )}
              >
                {deploying ? (
                  <>
                    <Loader2 size={16} className="animate-spin" />
                    Deploying...
                  </>
                ) : (
                  <>
                    <Rocket size={16} />
                    Deploy Service
                  </>
                )}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default DeploymentWizard;

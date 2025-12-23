import React, { useCallback, useEffect, useState, useMemo } from 'react';
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  addEdge,
  Panel,
  MarkerType,
  ReactFlowProvider,
} from 'reactflow';
import 'reactflow/dist/style.css';
import ServiceNode from '../components/nodes/ServiceNode';
import {
  RefreshCw, Plus, Rocket, Layers, Activity, AlertCircle, X, Loader2,
  Trash2, MinusCircle, PlusCircle, FileText, Server, Container, Play, Square
} from 'lucide-react';
import clsx from 'clsx';
import DeploymentWizard from '../components/DeploymentWizard';

const API_URL = `http://${window.location.hostname}:8765/api`;

// Node types for ReactFlow
const nodeTypes = {
  service: ServiceNode,
};

// Custom edge style
const edgeOptions = {
  type: 'smoothstep',
  animated: true,
  style: { stroke: '#00d4ff', strokeWidth: 2 },
  markerEnd: {
    type: MarkerType.ArrowClosed,
    color: '#00d4ff',
  },
};

// Auto-layout services in a grid/tree structure
const calculateLayout = (services) => {
  const nodes = [];
  const nodeWidth = 240;
  const nodeHeight = 180;
  const gapX = 100;
  const gapY = 120;

  // Group services by type (databases at bottom, apps in middle, web at top)
  const databases = [];
  const apps = [];
  const web = [];

  services.forEach(service => {
    const image = service.image?.toLowerCase() || '';
    const name = service.name?.toLowerCase() || '';

    if (image.includes('postgres') || image.includes('redis') || image.includes('mysql') ||
        image.includes('mongo') || image.includes('minio')) {
      databases.push(service);
    } else if (image.includes('nginx') || image.includes('traefik') || image.includes('caddy') ||
               name.includes('web') || name.includes('frontend')) {
      web.push(service);
    } else {
      apps.push(service);
    }
  });

  // Position databases at the bottom
  const canvasWidth = 1200;
  const dbRowY = 400;
  const dbRowWidth = databases.length * (nodeWidth + gapX);
  const dbStartX = (canvasWidth - dbRowWidth) / 2 + gapX / 2;

  databases.forEach((service, i) => {
    nodes.push({
      id: service.id || service.name,
      type: 'service',
      position: { x: dbStartX + i * (nodeWidth + gapX), y: dbRowY },
      data: {
        ...service,
        replicas: { running: service.running, desired: service.replicas },
      },
    });
  });

  // Position apps in the middle
  const appRowY = 200;
  const appRowWidth = apps.length * (nodeWidth + gapX);
  const appStartX = (canvasWidth - appRowWidth) / 2 + gapX / 2;

  apps.forEach((service, i) => {
    nodes.push({
      id: service.id || service.name,
      type: 'service',
      position: { x: appStartX + i * (nodeWidth + gapX), y: appRowY },
      data: {
        ...service,
        replicas: { running: service.running, desired: service.replicas },
      },
    });
  });

  // Position web/frontend at the top
  const webRowY = 50;
  const webRowWidth = web.length * (nodeWidth + gapX);
  const webStartX = (canvasWidth - webRowWidth) / 2 + gapX / 2;

  web.forEach((service, i) => {
    nodes.push({
      id: service.id || service.name,
      type: 'service',
      position: { x: webStartX + i * (nodeWidth + gapX), y: webRowY },
      data: {
        ...service,
        replicas: { running: service.running, desired: service.replicas },
      },
    });
  });

  return nodes;
};

// Infer edges based on service names and environment variables
const inferEdges = (services) => {
  const edges = [];
  const serviceNames = new Set(services.map(s => s.name.toLowerCase()));

  services.forEach(service => {
    const envVars = service.env || [];
    const name = service.name.toLowerCase();

    // Check environment variables for database connections
    envVars.forEach(envVar => {
      const envLower = envVar.toLowerCase();

      // Check for postgres connections
      if (envLower.includes('postgres') || envLower.includes('database_url')) {
        const pgService = services.find(s =>
          s.image?.toLowerCase().includes('postgres') ||
          s.name.toLowerCase().includes('postgres')
        );
        if (pgService && pgService.id !== service.id) {
          edges.push({
            id: `${service.id}-${pgService.id}`,
            source: service.id,
            target: pgService.id,
            ...edgeOptions,
          });
        }
      }

      // Check for redis connections
      if (envLower.includes('redis')) {
        const redisService = services.find(s =>
          s.image?.toLowerCase().includes('redis') ||
          s.name.toLowerCase().includes('redis')
        );
        if (redisService && redisService.id !== service.id) {
          edges.push({
            id: `${service.id}-${redisService.id}`,
            source: service.id,
            target: redisService.id,
            ...edgeOptions,
          });
        }
      }

      // Check for minio/s3 connections
      if (envLower.includes('minio') || envLower.includes('s3_')) {
        const minioService = services.find(s =>
          s.image?.toLowerCase().includes('minio') ||
          s.name.toLowerCase().includes('minio')
        );
        if (minioService && minioService.id !== service.id) {
          edges.push({
            id: `${service.id}-${minioService.id}`,
            source: service.id,
            target: minioService.id,
            ...edgeOptions,
          });
        }
      }
    });
  });

  // Remove duplicate edges
  const uniqueEdges = [];
  const seenEdges = new Set();
  edges.forEach(edge => {
    const key = `${edge.source}-${edge.target}`;
    if (!seenEdges.has(key)) {
      seenEdges.add(key);
      uniqueEdges.push(edge);
    }
  });

  return uniqueEdges;
};

const ArchitectureViewInner = () => {
  const [activeTab, setActiveTab] = useState('spark'); // 'swarm' or 'spark'
  const [services, setServices] = useState([]);
  const [sparkContainers, setSparkContainers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [selectedService, setSelectedService] = useState(null);
  const [selectedContainer, setSelectedContainer] = useState(null);

  // Action modals
  const [logsModal, setLogsModal] = useState({ open: false, logs: '', loading: false });
  const [scaleModal, setScaleModal] = useState({ open: false, replicas: 1, loading: false });
  const [actionLoading, setActionLoading] = useState(null); // 'stop', 'remove', 'restart'

  const loadServices = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch(`${API_URL}/swarm/services`);
      const data = await res.json();
      setServices(data);
      setError(null);
    } catch (e) {
      setError('Failed to load services');
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadSparkContainers = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch(`${API_URL}/swarm/containers`);
      const data = await res.json();
      setSparkContainers(data.containers || []);
      setError(null);
    } catch (e) {
      setError('Failed to load SPARK containers');
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadServices();
    // Refresh every 10 seconds
    const interval = setInterval(loadServices, 10000);
    return () => clearInterval(interval);
  }, [loadServices]);

  // Update nodes and edges when services change
  useEffect(() => {
    const layoutNodes = calculateLayout(services);
    const inferredEdges = inferEdges(services);
    setNodes(layoutNodes);
    setEdges(inferredEdges);
  }, [services, setNodes, setEdges]);

  const onConnect = useCallback(
    (params) => setEdges((eds) => addEdge({ ...params, ...edgeOptions }, eds)),
    [setEdges]
  );

  const onNodeClick = useCallback((event, node) => {
    setSelectedService(node.data);
  }, []);

  // Service action handlers
  const handleViewLogs = async (serviceName) => {
    setLogsModal({ open: true, logs: '', loading: true });
    try {
      const res = await fetch(`${API_URL}/swarm/services/${serviceName}/logs?tail=200`);
      const data = await res.json();
      setLogsModal({ open: true, logs: data.logs || 'No logs available', loading: false });
    } catch (e) {
      setLogsModal({ open: true, logs: `Error fetching logs: ${e.message}`, loading: false });
    }
  };

  const handleScale = async (serviceName, newReplicas) => {
    setScaleModal(prev => ({ ...prev, loading: true }));
    try {
      const res = await fetch(`${API_URL}/swarm/services/${serviceName}/scale`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ replicas: newReplicas }),
      });
      if (res.ok) {
        setScaleModal({ open: false, replicas: 1, loading: false });
        setSelectedService(null);
        loadServices();
      } else {
        const data = await res.json();
        alert(`Failed to scale: ${data.detail || 'Unknown error'}`);
        setScaleModal(prev => ({ ...prev, loading: false }));
      }
    } catch (e) {
      alert(`Error: ${e.message}`);
      setScaleModal(prev => ({ ...prev, loading: false }));
    }
  };

  const handleStopService = async (serviceName) => {
    if (!confirm(`Are you sure you want to scale "${serviceName}" to 0 replicas?`)) return;
    setActionLoading('stop');
    try {
      const res = await fetch(`${API_URL}/swarm/services/${serviceName}/scale`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ replicas: 0 }),
      });
      if (res.ok) {
        setSelectedService(null);
        loadServices();
      } else {
        const data = await res.json();
        alert(`Failed to stop: ${data.detail || 'Unknown error'}`);
      }
    } catch (e) {
      alert(`Error: ${e.message}`);
    } finally {
      setActionLoading(null);
    }
  };

  const handleRemoveService = async (serviceName) => {
    if (!confirm(`Are you sure you want to REMOVE "${serviceName}"? This cannot be undone.`)) return;
    setActionLoading('remove');
    try {
      const res = await fetch(`${API_URL}/swarm/services/${serviceName}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        setSelectedService(null);
        loadServices();
      } else {
        const data = await res.json();
        alert(`Failed to remove: ${data.detail || 'Unknown error'}`);
      }
    } catch (e) {
      alert(`Error: ${e.message}`);
    } finally {
      setActionLoading(null);
    }
  };

  // Calculate stats
  const stats = useMemo(() => {
    const total = services.length;
    const running = services.filter(s => s.running > 0).length;
    const stopped = total - running;
    return { total, running, stopped };
  }, [services]);

  return (
    <div className="h-full w-full relative">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={onNodeClick}
        nodeTypes={nodeTypes}
        fitView
        minZoom={0.3}
        maxZoom={2}
        defaultViewport={{ x: 0, y: 0, zoom: 0.8 }}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#1a1a2e" gap={20} size={1} />
        <Controls className="!bg-bg-secondary !border-border-default !rounded-lg" />
        <MiniMap
          className="!bg-bg-secondary !border-border-default !rounded-lg"
          nodeColor={(node) => {
            const running = node.data?.replicas?.running > 0;
            return running ? '#00d4ff' : '#666';
          }}
          maskColor="rgba(0, 0, 0, 0.8)"
        />

        {/* Header Panel */}
        <Panel position="top-left" className="!m-4">
          <div className="bg-bg-secondary/90 backdrop-blur border border-border-default rounded-xl p-4">
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <Layers size={20} className="text-text-accent" />
                <h1 className="text-lg font-bold text-text-primary">Architecture</h1>
              </div>

              {/* Stats */}
              <div className="flex items-center gap-4 ml-4 pl-4 border-l border-border-subtle">
                <div className="flex items-center gap-2">
                  <Activity size={14} className="text-status-online" />
                  <span className="text-text-primary text-sm">{stats.running} running</span>
                </div>
                {stats.stopped > 0 && (
                  <div className="flex items-center gap-2">
                    <AlertCircle size={14} className="text-status-error" />
                    <span className="text-text-muted text-sm">{stats.stopped} stopped</span>
                  </div>
                )}
                <span className="text-text-muted text-sm">{stats.total} total</span>
              </div>

              {/* Actions */}
              <div className="flex items-center gap-2 ml-auto">
                <button
                  onClick={loadServices}
                  disabled={loading}
                  className={clsx(
                    'p-2 rounded-lg transition-colors',
                    loading
                      ? 'bg-bg-tertiary text-text-muted'
                      : 'bg-bg-tertiary hover:bg-bg-hover text-text-secondary hover:text-text-primary'
                  )}
                >
                  <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
                </button>
                <button
                  onClick={() => setWizardOpen(true)}
                  className="flex items-center gap-2 px-4 py-2 bg-text-accent text-white rounded-lg hover:bg-text-accent/90 transition-colors"
                >
                  <Rocket size={16} />
                  Deploy
                </button>
              </div>
            </div>
          </div>
        </Panel>

        {/* Empty State */}
        {!loading && services.length === 0 && (
          <Panel position="top-center" className="!top-1/2 !-translate-y-1/2">
            <div className="bg-bg-secondary/90 backdrop-blur border border-border-default rounded-xl p-8 text-center">
              <Layers size={48} className="mx-auto mb-4 text-text-muted opacity-50" />
              <h2 className="text-xl font-bold text-text-primary mb-2">No Services Deployed</h2>
              <p className="text-text-muted mb-4">
                Deploy your first service to see it in the architecture view
              </p>
              <button
                onClick={() => setWizardOpen(true)}
                className="flex items-center gap-2 px-6 py-2 bg-text-accent text-white rounded-lg hover:bg-text-accent/90 transition-colors mx-auto"
              >
                <Plus size={16} />
                Deploy Service
              </button>
            </div>
          </Panel>
        )}

        {/* Error State */}
        {error && (
          <Panel position="bottom-center" className="!mb-4">
            <div className="bg-status-error/20 border border-status-error/30 rounded-lg px-4 py-2 flex items-center gap-2 text-status-error">
              <AlertCircle size={16} />
              {error}
            </div>
          </Panel>
        )}
      </ReactFlow>

      {/* Service Detail Panel */}
      {selectedService && (
        <div className="absolute top-4 right-4 w-80 bg-bg-secondary border border-border-default rounded-xl shadow-xl overflow-hidden">
          <div className="p-4 border-b border-border-subtle flex items-center justify-between">
            <h3 className="font-bold text-text-primary">{selectedService.name}</h3>
            <button
              onClick={() => setSelectedService(null)}
              className="text-text-muted hover:text-text-primary"
            >
              ×
            </button>
          </div>
          <div className="p-4 space-y-3 text-sm">
            <div>
              <span className="text-text-muted">Image:</span>
              <span className="text-text-primary ml-2 font-mono text-xs">
                {selectedService.image?.split('/').pop() || '-'}
              </span>
            </div>
            <div>
              <span className="text-text-muted">Mode:</span>
              <span className="text-text-primary ml-2">{selectedService.mode}</span>
            </div>
            <div>
              <span className="text-text-muted">Replicas:</span>
              <span className="text-text-primary ml-2">
                {selectedService.replicas?.running ?? selectedService.running ?? 0}/
                {selectedService.replicas?.desired ?? selectedService.replicas ?? 1}
              </span>
            </div>
            {selectedService.ports?.length > 0 && (
              <div>
                <span className="text-text-muted">Ports:</span>
                <div className="flex flex-wrap gap-1 mt-1">
                  {selectedService.ports.map((p, i) => (
                    <span key={i} className="px-2 py-0.5 bg-bg-tertiary rounded text-text-primary text-xs font-mono">
                      {p.PublishedPort}:{p.TargetPort}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
          <div className="p-4 border-t border-border-subtle flex gap-2">
            <button
              onClick={() => handleViewLogs(selectedService.name)}
              className="flex-1 py-2 text-xs bg-bg-tertiary hover:bg-bg-hover text-text-secondary rounded-lg flex items-center justify-center gap-1"
            >
              <FileText size={12} /> Logs
            </button>
            <button
              onClick={() => setScaleModal({
                open: true,
                replicas: selectedService.replicas?.desired ?? selectedService.replicas ?? 1,
                loading: false
              })}
              className="flex-1 py-2 text-xs bg-bg-tertiary hover:bg-bg-hover text-text-secondary rounded-lg flex items-center justify-center gap-1"
            >
              <PlusCircle size={12} /> Scale
            </button>
            <button
              onClick={() => handleRemoveService(selectedService.name)}
              disabled={actionLoading === 'remove'}
              className="flex-1 py-2 text-xs bg-status-error/10 hover:bg-status-error/20 text-status-error rounded-lg flex items-center justify-center gap-1"
            >
              {actionLoading === 'remove' ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Trash2 size={12} />
              )}
              Remove
            </button>
          </div>
        </div>
      )}

      {/* Logs Modal */}
      {logsModal.open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/70" onClick={() => setLogsModal({ open: false, logs: '', loading: false })} />
          <div className="relative bg-bg-secondary border border-border-default rounded-xl shadow-2xl w-full max-w-4xl max-h-[80vh] overflow-hidden">
            <div className="flex items-center justify-between p-4 border-b border-border-subtle">
              <h3 className="font-bold text-text-primary flex items-center gap-2">
                <FileText size={18} /> Service Logs: {selectedService?.name}
              </h3>
              <button onClick={() => setLogsModal({ open: false, logs: '', loading: false })} className="text-text-muted hover:text-text-primary">
                <X size={20} />
              </button>
            </div>
            <div className="p-4 overflow-auto max-h-[60vh]">
              {logsModal.loading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 size={24} className="animate-spin text-text-accent" />
                </div>
              ) : (
                <pre className="text-xs font-mono text-text-secondary whitespace-pre-wrap bg-bg-tertiary p-4 rounded-lg">
                  {logsModal.logs || 'No logs available'}
                </pre>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Scale Modal */}
      {scaleModal.open && selectedService && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/70" onClick={() => setScaleModal({ open: false, replicas: 1, loading: false })} />
          <div className="relative bg-bg-secondary border border-border-default rounded-xl shadow-2xl w-full max-w-md overflow-hidden">
            <div className="flex items-center justify-between p-4 border-b border-border-subtle">
              <h3 className="font-bold text-text-primary">Scale Service: {selectedService.name}</h3>
              <button onClick={() => setScaleModal({ open: false, replicas: 1, loading: false })} className="text-text-muted hover:text-text-primary">
                <X size={20} />
              </button>
            </div>
            <div className="p-6">
              <div className="flex items-center justify-center gap-4 mb-6">
                <button
                  onClick={() => setScaleModal(prev => ({ ...prev, replicas: Math.max(0, prev.replicas - 1) }))}
                  className="p-2 bg-bg-tertiary hover:bg-bg-hover rounded-lg text-text-primary"
                >
                  <MinusCircle size={24} />
                </button>
                <div className="text-4xl font-bold text-text-primary w-20 text-center">
                  {scaleModal.replicas}
                </div>
                <button
                  onClick={() => setScaleModal(prev => ({ ...prev, replicas: prev.replicas + 1 }))}
                  className="p-2 bg-bg-tertiary hover:bg-bg-hover rounded-lg text-text-primary"
                >
                  <PlusCircle size={24} />
                </button>
              </div>
              <p className="text-text-muted text-sm text-center mb-6">
                Current: {selectedService.replicas?.running ?? selectedService.running ?? 0} running / {selectedService.replicas?.desired ?? selectedService.replicas ?? 1} desired
              </p>
              <div className="flex gap-3">
                <button
                  onClick={() => setScaleModal({ open: false, replicas: 1, loading: false })}
                  className="flex-1 py-2 bg-bg-tertiary hover:bg-bg-hover text-text-secondary rounded-lg"
                >
                  Cancel
                </button>
                <button
                  onClick={() => handleScale(selectedService.name, scaleModal.replicas)}
                  disabled={scaleModal.loading}
                  className="flex-1 py-2 bg-text-accent hover:bg-text-accent/90 text-white rounded-lg flex items-center justify-center gap-2"
                >
                  {scaleModal.loading ? <Loader2 size={16} className="animate-spin" /> : null}
                  Apply
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Deployment Wizard */}
      <DeploymentWizard
        isOpen={wizardOpen}
        onClose={() => {
          setWizardOpen(false);
          loadServices();
        }}
      />
    </div>
  );
};

const ArchitectureView = () => (
  <ReactFlowProvider>
    <ArchitectureViewInner />
  </ReactFlowProvider>
);

export default ArchitectureView;

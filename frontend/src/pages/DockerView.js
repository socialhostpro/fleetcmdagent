import React, { useState, useEffect, useCallback } from 'react';
import {
  Server, Box, Activity, Play, Square, RefreshCw, Trash2,
  Plus, ChevronDown, ChevronRight, Terminal, Scale, Settings,
  AlertCircle, CheckCircle, XCircle, Clock, Layers
} from 'lucide-react';
import clsx from 'clsx';

const API_URL = `http://${window.location.hostname}:8765/api`;

const DockerView = () => {
  const [swarmStatus, setSwarmStatus] = useState(null);
  const [services, setServices] = useState([]);
  const [swarmNodes, setSwarmNodes] = useState([]);
  const [selectedService, setSelectedService] = useState(null);
  const [serviceLogs, setServiceLogs] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showCreateModal, setShowCreateModal] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      setError(null);
      const [statusRes, servicesRes, nodesRes] = await Promise.all([
        fetch(`${API_URL}/swarm/status`),
        fetch(`${API_URL}/swarm/services`),
        fetch(`${API_URL}/swarm/nodes`),
      ]);

      if (statusRes.ok) {
        setSwarmStatus(await statusRes.json());
      }
      if (servicesRes.ok) {
        setServices(await servicesRes.json());
      }
      if (nodesRes.ok) {
        setSwarmNodes(await nodesRes.json());
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 10000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const fetchServiceLogs = async (serviceId) => {
    try {
      const res = await fetch(`${API_URL}/swarm/services/${serviceId}/logs?tail=200`);
      if (res.ok) {
        const data = await res.json();
        setServiceLogs(data.logs);
      }
    } catch (err) {
      console.error('Failed to fetch logs:', err);
    }
  };

  const handleScaleService = async (serviceId, replicas) => {
    try {
      const res = await fetch(`${API_URL}/swarm/services/${serviceId}/scale`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ replicas }),
      });
      if (res.ok) {
        fetchData();
      }
    } catch (err) {
      console.error('Failed to scale service:', err);
    }
  };

  const handleDeleteService = async (serviceId) => {
    if (!window.confirm('Are you sure you want to delete this service?')) return;
    try {
      const res = await fetch(`${API_URL}/swarm/services/${serviceId}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        setSelectedService(null);
        fetchData();
      }
    } catch (err) {
      console.error('Failed to delete service:', err);
    }
  };

  const getStatusIcon = (status) => {
    switch (status?.toLowerCase()) {
      case 'running':
        return <CheckCircle size={14} className="text-status-online" />;
      case 'pending':
        return <Clock size={14} className="text-status-warning" />;
      case 'failed':
      case 'rejected':
        return <XCircle size={14} className="text-status-error" />;
      default:
        return <AlertCircle size={14} className="text-text-muted" />;
    }
  };

  if (isLoading) {
    return (
      <div className="h-full flex items-center justify-center bg-bg-primary">
        <RefreshCw size={24} className="animate-spin text-text-accent" />
      </div>
    );
  }

  return (
    <div className="h-full bg-bg-primary overflow-auto p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-text-primary flex items-center gap-2">
            <Layers size={24} className="text-cluster-spark" />
            Docker Swarm
          </h1>
          <p className="text-text-muted text-sm mt-1">Manage containers and services across your cluster</p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={fetchData}
            className="p-2 rounded-lg bg-bg-secondary border border-border-subtle hover:border-border-bright text-text-secondary hover:text-text-primary transition-colors"
          >
            <RefreshCw size={18} />
          </button>
          <button
            onClick={() => setShowCreateModal(true)}
            className="flex items-center gap-2 px-4 py-2 bg-cluster-spark hover:bg-cluster-spark/80 text-white rounded-lg font-medium transition-colors"
          >
            <Plus size={18} />
            Deploy Service
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-6 p-4 bg-status-error/10 border border-status-error/20 rounded-lg text-status-error">
          {error}
        </div>
      )}

      {/* Swarm Status Cards */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <div className="bg-bg-secondary rounded-lg border border-border-subtle p-4">
          <div className="flex items-center gap-2 text-text-muted text-sm mb-2">
            <Activity size={16} />
            Swarm Status
          </div>
          <div className={clsx(
            'text-lg font-bold',
            swarmStatus?.swarm?.LocalNodeState === 'active' ? 'text-status-online' : 'text-status-error'
          )}>
            {swarmStatus?.swarm?.LocalNodeState === 'active' ? 'Active' : 'Inactive'}
          </div>
        </div>

        <div className="bg-bg-secondary rounded-lg border border-border-subtle p-4">
          <div className="flex items-center gap-2 text-text-muted text-sm mb-2">
            <Server size={16} />
            Nodes
          </div>
          <div className="text-lg font-bold text-text-primary">
            {swarmStatus?.nodes || swarmNodes.length || 0}
          </div>
          <div className="text-xs text-text-muted">
            {swarmStatus?.managers || 0} manager(s)
          </div>
        </div>

        <div className="bg-bg-secondary rounded-lg border border-border-subtle p-4">
          <div className="flex items-center gap-2 text-text-muted text-sm mb-2">
            <Box size={16} />
            Services
          </div>
          <div className="text-lg font-bold text-text-primary">{services.length}</div>
        </div>

        <div className="bg-bg-secondary rounded-lg border border-border-subtle p-4">
          <div className="flex items-center gap-2 text-text-muted text-sm mb-2">
            <Box size={16} />
            Containers
          </div>
          <div className="text-lg font-bold text-text-primary">
            {swarmStatus?.containers_running || 0}
            <span className="text-text-muted text-sm font-normal ml-1">
              / {swarmStatus?.containers || 0}
            </span>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-6">
        {/* Services List */}
        <div className="col-span-2 bg-bg-secondary rounded-lg border border-border-subtle">
          <div className="p-4 border-b border-border-subtle">
            <h2 className="text-lg font-bold text-text-primary">Services</h2>
          </div>
          <div className="divide-y divide-border-subtle">
            {services.length === 0 ? (
              <div className="p-8 text-center text-text-muted">
                No services deployed. Click "Deploy Service" to get started.
              </div>
            ) : (
              services.map((service) => (
                <div
                  key={service.id}
                  className={clsx(
                    'p-4 cursor-pointer transition-colors',
                    selectedService?.id === service.id ? 'bg-bg-hover' : 'hover:bg-bg-tertiary'
                  )}
                  onClick={() => {
                    setSelectedService(service);
                    fetchServiceLogs(service.id);
                  }}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex items-start gap-3">
                      <div className="p-2 bg-bg-tertiary rounded-lg">
                        <Box size={20} className="text-cluster-spark" />
                      </div>
                      <div>
                        <div className="font-medium text-text-primary">{service.name}</div>
                        <div className="text-sm text-text-muted font-mono truncate max-w-md">
                          {service.image}
                        </div>
                        <div className="flex items-center gap-4 mt-2 text-xs text-text-muted">
                          <span className="flex items-center gap-1">
                            {getStatusIcon(service.running > 0 ? 'running' : 'pending')}
                            {service.running}/{service.replicas || '?'} running
                          </span>
                          <span>{service.mode}</span>
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {/* Scale controls */}
                      <div className="flex items-center gap-1 bg-bg-tertiary rounded-lg p-1">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            if (service.replicas > 1) {
                              handleScaleService(service.id, service.replicas - 1);
                            }
                          }}
                          className="p-1 rounded hover:bg-bg-hover text-text-secondary"
                          disabled={service.mode === 'global'}
                        >
                          <ChevronDown size={14} />
                        </button>
                        <span className="px-2 text-sm font-mono text-text-primary">
                          {service.replicas || 'G'}
                        </span>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleScaleService(service.id, (service.replicas || 1) + 1);
                          }}
                          className="p-1 rounded hover:bg-bg-hover text-text-secondary"
                          disabled={service.mode === 'global'}
                        >
                          <ChevronRight size={14} />
                        </button>
                      </div>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteService(service.id);
                        }}
                        className="p-2 rounded-lg hover:bg-status-error/20 text-text-muted hover:text-status-error transition-colors"
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Nodes List */}
        <div className="bg-bg-secondary rounded-lg border border-border-subtle">
          <div className="p-4 border-b border-border-subtle">
            <h2 className="text-lg font-bold text-text-primary">Swarm Nodes</h2>
          </div>
          <div className="divide-y divide-border-subtle max-h-[400px] overflow-auto">
            {swarmNodes.length === 0 ? (
              <div className="p-8 text-center text-text-muted">
                No swarm nodes found
              </div>
            ) : (
              swarmNodes.map((node) => (
                <div key={node.id} className="p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="flex items-center gap-2">
                        <Server size={16} className="text-text-accent" />
                        <span className="font-medium text-text-primary">{node.hostname}</span>
                        {node.role === 'manager' && (
                          <span className="px-2 py-0.5 text-xs bg-cluster-spark/20 text-cluster-spark rounded">
                            Manager
                          </span>
                        )}
                      </div>
                      <div className="text-sm text-text-muted mt-1">{node.ip}</div>
                    </div>
                    <div className={clsx(
                      'px-2 py-1 rounded text-xs font-medium',
                      node.status === 'ready'
                        ? 'bg-status-online/10 text-status-online'
                        : 'bg-status-error/10 text-status-error'
                    )}>
                      {node.status}
                    </div>
                  </div>
                  <div className="mt-2 flex items-center gap-4 text-xs text-text-muted">
                    <span>{node.platform?.os}/{node.platform?.arch}</span>
                    <span>{node.resources?.cpus?.toFixed(0) || '?'} CPUs</span>
                    <span>{((node.resources?.memory || 0) / 1e9).toFixed(1)} GB</span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Service Detail / Logs Panel */}
      {selectedService && (
        <div className="mt-6 bg-bg-secondary rounded-lg border border-border-subtle">
          <div className="p-4 border-b border-border-subtle flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Terminal size={20} className="text-text-accent" />
              <h2 className="text-lg font-bold text-text-primary">
                Logs: {selectedService.name}
              </h2>
            </div>
            <button
              onClick={() => fetchServiceLogs(selectedService.id)}
              className="p-2 rounded-lg hover:bg-bg-hover text-text-secondary hover:text-text-primary transition-colors"
            >
              <RefreshCw size={16} />
            </button>
          </div>
          <div className="p-4 max-h-[300px] overflow-auto">
            <pre className="text-sm text-text-secondary font-mono whitespace-pre-wrap">
              {serviceLogs || 'No logs available'}
            </pre>
          </div>
        </div>
      )}

      {/* Create Service Modal */}
      {showCreateModal && (
        <CreateServiceModal
          onClose={() => setShowCreateModal(false)}
          onCreated={() => {
            setShowCreateModal(false);
            fetchData();
          }}
        />
      )}
    </div>
  );
};

// Create Service Modal
const CreateServiceModal = ({ onClose, onCreated }) => {
  const [name, setName] = useState('');
  const [image, setImage] = useState('');
  const [replicas, setReplicas] = useState(1);
  const [mode, setMode] = useState('replicated');
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState(null);

  const presetImages = [
    { name: 'NVIDIA L4T Base', image: 'nvcr.io/nvidia/l4t-base:r32.6.1' },
    { name: 'PyTorch', image: 'nvcr.io/nvidia/l4t-pytorch:r32.6.1-pth1.9-py3' },
    { name: 'TensorFlow', image: 'nvcr.io/nvidia/l4t-tensorflow:r32.6.1-tf2.5-py3' },
    { name: 'Ollama', image: 'ollama/ollama:latest' },
    { name: 'Nginx', image: 'nginx:alpine' },
    { name: 'Redis', image: 'redis:alpine' },
  ];

  const handleCreate = async () => {
    setIsCreating(true);
    setError(null);

    try {
      const res = await fetch(`${API_URL}/swarm/services`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          image,
          replicas: mode === 'global' ? 1 : replicas,
          mode,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.detail || 'Failed to create service');
      }

      onCreated();
    } catch (err) {
      setError(err.message);
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
      <div className="bg-bg-secondary rounded-lg w-full max-w-lg border border-border-subtle">
        <div className="p-4 border-b border-border-subtle">
          <h2 className="text-lg font-bold text-text-primary">Deploy New Service</h2>
          <p className="text-text-muted text-sm">Create a new Docker Swarm service</p>
        </div>

        <div className="p-4 space-y-4">
          {/* Preset Images */}
          <div>
            <label className="block text-sm text-text-secondary mb-2">Quick Select</label>
            <div className="flex flex-wrap gap-2">
              {presetImages.map((preset) => (
                <button
                  key={preset.image}
                  onClick={() => {
                    setImage(preset.image);
                    setName(preset.name.toLowerCase().replace(/\s+/g, '-'));
                  }}
                  className={clsx(
                    'px-3 py-1 text-xs rounded-lg border transition-colors',
                    image === preset.image
                      ? 'bg-text-accent/20 border-text-accent text-text-accent'
                      : 'bg-bg-tertiary border-border-subtle text-text-secondary hover:text-text-primary'
                  )}
                >
                  {preset.name}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-sm text-text-secondary mb-1">Service Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full bg-bg-tertiary border border-border-subtle rounded-lg px-3 py-2 text-text-primary focus:outline-none focus:border-text-accent"
              placeholder="my-service"
            />
          </div>

          <div>
            <label className="block text-sm text-text-secondary mb-1">Image</label>
            <input
              type="text"
              value={image}
              onChange={(e) => setImage(e.target.value)}
              className="w-full bg-bg-tertiary border border-border-subtle rounded-lg px-3 py-2 text-text-primary font-mono text-sm focus:outline-none focus:border-text-accent"
              placeholder="nginx:latest"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-text-secondary mb-1">Mode</label>
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value)}
                className="w-full bg-bg-tertiary border border-border-subtle rounded-lg px-3 py-2 text-text-primary focus:outline-none focus:border-text-accent"
              >
                <option value="replicated">Replicated</option>
                <option value="global">Global</option>
              </select>
            </div>

            <div>
              <label className="block text-sm text-text-secondary mb-1">Replicas</label>
              <input
                type="number"
                value={replicas}
                onChange={(e) => setReplicas(parseInt(e.target.value) || 1)}
                min={1}
                disabled={mode === 'global'}
                className="w-full bg-bg-tertiary border border-border-subtle rounded-lg px-3 py-2 text-text-primary focus:outline-none focus:border-text-accent disabled:opacity-50"
              />
            </div>
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
          <button
            onClick={onClose}
            disabled={isCreating}
            className="px-4 py-2 text-text-secondary hover:text-text-primary transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={!name || !image || isCreating}
            className="px-4 py-2 bg-cluster-spark hover:bg-cluster-spark/80 text-white rounded-lg font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
          >
            {isCreating ? (
              <>
                <RefreshCw size={16} className="animate-spin" />
                Creating...
              </>
            ) : (
              'Deploy Service'
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

export default DockerView;

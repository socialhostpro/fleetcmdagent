import React, { useState, useEffect, useRef, useMemo } from 'react';
import { fetchNetworkScan, fetchCredentials, saveCredential, installNode, getInstallStatus, setNodeCluster, fetchClusters } from '../api';
import {
  Search, Monitor, Wifi, AlertCircle, Key, Download, Terminal, Loader2,
  Server, Cpu, Router, HelpCircle, X, CheckCircle, XCircle, RefreshCw,
  Filter, Eye, ChevronDown, Database, Clock, Plus, Settings, ListTodo,
  Zap, Activity, Box, AlertTriangle
} from 'lucide-react';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import StatusDot from '../components/nodes/StatusDot';
import NodeDetailsModal from '../components/NodeDetailsModal';

// Device type configurations
const DEVICE_CONFIGS = {
  spark: {
    icon: Server,
    color: '#76b900',
    bgColor: 'bg-cluster-spark/10',
    borderColor: 'border-cluster-spark',
    label: 'DGX SPARK',
    description: 'Control Plane',
  },
  agx: {
    icon: Cpu,
    color: '#3498db',
    bgColor: 'bg-blue-500/10',
    borderColor: 'border-blue-500',
    label: 'AGX XAVIER',
    description: 'Jetson Node',
  },
  windows: {
    icon: Monitor,
    color: '#00a4ef',
    bgColor: 'bg-sky-500/10',
    borderColor: 'border-sky-500',
    label: 'WINDOWS',
    description: 'Windows PC',
  },
  linux: {
    icon: Terminal,
    color: '#f39c12',
    bgColor: 'bg-orange-500/10',
    borderColor: 'border-orange-500',
    label: 'LINUX',
    description: 'Linux Server',
  },
  router: {
    icon: Router,
    color: '#9b59b6',
    bgColor: 'bg-purple-500/10',
    borderColor: 'border-purple-500',
    label: 'GATEWAY',
    description: 'Router/Gateway',
  },
  unknown: {
    icon: HelpCircle,
    color: '#666666',
    bgColor: 'bg-gray-500/10',
    borderColor: 'border-gray-500',
    label: 'UNKNOWN',
    description: 'Unidentified',
  },
};

const NetworkView = () => {
  const [subnet, setSubnet] = useState('192.168.1.0/24');
  const [hosts, setHosts] = useState([]);
  const [scanStats, setScanStats] = useState(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [filterType, setFilterType] = useState('all');
  const [showFilterMenu, setShowFilterMenu] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [lastScanTime, setLastScanTime] = useState(null);
  const [isCached, setIsCached] = useState(false);

  // Vault & Install State
  const [showVault, setShowVault] = useState(false);
  const [credentials, setCredentials] = useState([]);
  const [newCred, setNewCred] = useState({ name: '', username: '', password: '' });
  const [installTarget, setInstallTarget] = useState(null);
  const [selectedCred, setSelectedCred] = useState('');
  const [installStatus, setInstallStatus] = useState(null);
  const [joiningNode, setJoiningNode] = useState(null);
  const [detailsHost, setDetailsHost] = useState(null);
  const [installQueue, setInstallQueue] = useState(null);
  const [selectedForQueue, setSelectedForQueue] = useState([]);
  const [showBatchInstall, setShowBatchInstall] = useState(false);
  const [batchInstallMode, setBatchInstallMode] = useState('install'); // 'install' or 'reinstall'
  const [batchQueueStatus, setBatchQueueStatus] = useState(null);
  const [availableClusters, setAvailableClusters] = useState(['vision', 'media-gen', 'inference']); // Default clusters
  const pollInterval = useRef(null);
  const queuePollInterval = useRef(null);
  const API_URL = `http://${window.location.hostname}:8765`;

  // Assign node to cluster
  const handleAssignCluster = async (host, clusterName) => {
    try {
      // Get the swarm node ID from the host's registered data
      const nodeId = host.swarm_node_id || host.fleet_node_id;
      if (!nodeId) {
        console.error('No swarm node ID found for host', host.ip);
        return;
      }
      await setNodeCluster(nodeId, clusterName);
      // Refresh to show updated cluster assignment
      await loadLastScan();
    } catch (e) {
      console.error('Failed to assign cluster:', e);
    }
  };

  const loadLastScan = async () => {
    setLoading(true);
    try {
      const result = await fetchNetworkScan(subnet, false);
      if (result.hosts) {
        setHosts(result.hosts);
        setScanStats({
          count: result.count,
          fleet_nodes: result.fleet_nodes,
          by_type: result.by_type
        });
        setIsCached(true);
        setLastScanTime(new Date());
      }
    } catch (e) {
      console.error("Failed to load last scan", e);
    } finally {
      setLoading(false);
    }
  };

  const loadCredentials = async () => {
    try {
      const creds = await fetchCredentials();
      setCredentials(creds);
    } catch (e) {
      console.error("Failed to load credentials", e);
    }
  };

  useEffect(() => {
    loadCredentials();
    loadLastScan();
    return () => {
      if (pollInterval.current) clearInterval(pollInterval.current);
    };
  }, []);

  const filteredHosts = useMemo(() => {
    let result = hosts;

    // Apply type filter
    if (filterType === 'fleet') {
      result = result.filter(h => h.is_fleet_node);
    } else if (filterType === 'not_installed') {
      result = result.filter(h => {
        const deviceType = h.device?.type || 'unknown';
        const isInstallable = deviceType === 'agx' || deviceType === 'linux';
        return isInstallable && !h.is_fleet_node;
      });
    } else if (filterType !== 'all') {
      result = result.filter(h => h.device?.type === filterType);
    }

    // Apply search filter
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase().trim();
      result = result.filter(h =>
        h.ip?.toLowerCase().includes(query) ||
        h.name?.toLowerCase().includes(query) ||
        h.mac?.toLowerCase().includes(query) ||
        h.fleet_node_id?.toLowerCase().includes(query) ||
        h.device?.label?.toLowerCase().includes(query)
      );
    }

    return result;
  }, [hosts, filterType, searchQuery]);

  const startPolling = (taskId) => {
    if (pollInterval.current) clearInterval(pollInterval.current);
    pollInterval.current = setInterval(async () => {
      try {
        const status = await getInstallStatus(taskId);
        setInstallStatus({
          status: status.status,
          log: status.logs
        });

        if (status.status === 'completed' || status.status === 'failed' || status.status === 'error') {
          clearInterval(pollInterval.current);
        }
      } catch (e) {
        console.error("Polling error", e);
      }
    }, 2000);
  };

  const handleScan = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchNetworkScan(subnet, true);
      if (result.error) {
        setError(result.error);
      } else {
        setHosts(result.hosts || []);
        setScanStats({
          count: result.count,
          fleet_nodes: result.fleet_nodes,
          by_type: result.by_type
        });
        setIsCached(false);
        setLastScanTime(new Date());
      }
    } catch (err) {
      setError('Failed to scan network');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  // Quick refresh - only updates fleet nodes from Redis heartbeats (instant)
  const handleQuickRefresh = async () => {
    setRefreshing(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/api/network/refresh`);
      const result = await res.json();
      if (result.error) {
        setError(result.error);
      } else {
        // Merge with existing hosts - update fleet nodes, keep non-fleet from last scan
        const nonFleetHosts = hosts.filter(h => !h.is_fleet_node);
        const updatedHosts = [...result.hosts, ...nonFleetHosts];
        setHosts(updatedHosts);
        setScanStats({
          count: updatedHosts.length,
          fleet_nodes: result.fleet_nodes,
          by_type: {
            ...scanStats?.by_type,
            ...result.by_type
          }
        });
        setLastScanTime(new Date());
      }
    } catch (err) {
      setError('Failed to refresh fleet nodes');
      console.error(err);
    } finally {
      setRefreshing(false);
    }
  };

  const handleSaveCred = async () => {
    if (!newCred.name || !newCred.username || !newCred.password) return;
    await saveCredential(newCred);
    setNewCred({ name: '', username: '', password: '' });
    loadCredentials();
  };

  const handleInstall = async () => {
    if (!installTarget || !selectedCred) return;
    setInstallStatus({ status: 'running', log: 'Starting installation...' });
    try {
      const result = await installNode(installTarget.ip, selectedCred);
      if (result.task_id) {
        startPolling(result.task_id);
      } else {
        setInstallStatus({ status: 'error', log: 'Failed to start task' });
      }
    } catch (e) {
      setInstallStatus({ status: 'error', log: 'Installation failed: ' + e.message });
    }
  };

  const handleJoinSwarm = async (host, credentialId) => {
    if (!credentialId) {
      alert('Please select a credential first');
      return;
    }
    setJoiningNode(host.ip);
    try {
      const res = await fetch(`${API_URL}/api/discovery/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ip: host.ip,
          credential_id: credentialId,
        })
      });
      const data = await res.json();
      if (res.ok && data.status === 'success') {
        alert(`${host.ip} joined swarm successfully!`);
      } else {
        alert(`Failed to join: ${data.detail || data.message || 'Unknown error'}`);
      }
    } catch (e) {
      alert(`Error: ${e.message}`);
    } finally {
      setJoiningNode(null);
    }
  };

  // Toggle node selection for batch install
  const toggleNodeSelection = (host) => {
    if (selectedForQueue.find(h => h.ip === host.ip)) {
      setSelectedForQueue(selectedForQueue.filter(h => h.ip !== host.ip));
    } else {
      setSelectedForQueue([...selectedForQueue, host]);
    }
  };

  // Select all installable nodes (not yet installed)
  const selectAllInstallable = () => {
    const installable = filteredHosts.filter(h => {
      const deviceType = h.device?.type || 'unknown';
      return (deviceType === 'agx' || deviceType === 'linux') && !h.is_fleet_node;
    });
    setSelectedForQueue(installable);
    setBatchInstallMode('install');
  };

  // Select all fleet nodes for reinstall
  const selectAllFleetNodes = () => {
    const fleetNodes = filteredHosts.filter(h => h.is_fleet_node);
    setSelectedForQueue(fleetNodes);
    setBatchInstallMode('reinstall');
  };

  // Clear selection
  const clearSelection = () => {
    setSelectedForQueue([]);
  };

  // Start batch installation
  const startBatchInstall = async (credentialId) => {
    if (!credentialId || selectedForQueue.length === 0) return;

    try {
      const nodes = selectedForQueue.map(host => ({
        ip: host.ip,
        hostname: host.name || host.ip,
        credential_id: credentialId,
        node_alias: host.fleet_node_id || `node-${host.ip.split('.').pop()}`
      }));

      const res = await fetch(`${API_URL}/api/install-queue/queue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nodes })
      });

      if (res.ok) {
        const data = await res.json();
        setBatchQueueStatus(data);
        setShowBatchInstall(false);
        // Start polling for queue status
        startQueuePolling();
      } else {
        const err = await res.json();
        alert(`Failed to start batch install: ${err.detail || 'Unknown error'}`);
      }
    } catch (e) {
      alert(`Error: ${e.message}`);
    }
  };

  // Poll queue status
  const startQueuePolling = () => {
    if (queuePollInterval.current) clearInterval(queuePollInterval.current);
    queuePollInterval.current = setInterval(async () => {
      try {
        const res = await fetch(`${API_URL}/api/install-queue/queue`);
        if (res.ok) {
          const data = await res.json();
          setBatchQueueStatus(data);
          // Stop polling if all done
          if (data.summary.running === 0 && data.summary.queued === 0) {
            clearInterval(queuePollInterval.current);
          }
        }
      } catch (e) {
        console.error('Queue poll error:', e);
      }
    }, 3000);
  };

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (queuePollInterval.current) clearInterval(queuePollInterval.current);
    };
  }, []);

  return (
    <div className="h-full overflow-auto bg-bg-primary p-6">
      {/* Header */}
      <div className="flex justify-between items-start mb-6">
        <div>
          <h1 className="text-2xl font-bold text-text-primary flex items-center gap-2">
            <Wifi className="text-text-accent" /> Network Discovery
          </h1>
          <p className="text-text-muted text-sm mt-1">
            Scan for devices and install Fleet Agent on nodes
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {selectedForQueue.length > 0 && (
            <>
              <button
                onClick={() => setShowBatchInstall(true)}
                className="px-4 py-2 bg-cluster-spark hover:bg-cluster-spark/80 rounded-lg flex items-center gap-2 text-white font-medium transition-colors"
              >
                <ListTodo size={16} />
                {batchInstallMode === 'reinstall' ? 'Batch Reinstall' : 'Batch Install'} ({selectedForQueue.length})
              </button>
              <button
                onClick={clearSelection}
                className="px-3 py-2 bg-bg-tertiary hover:bg-bg-hover border border-border-subtle rounded-lg flex items-center gap-1 text-text-muted hover:text-text-primary transition-colors"
                title="Clear selection"
              >
                <X size={14} />
              </button>
            </>
          )}
          <button
            onClick={selectAllInstallable}
            className="px-4 py-2 bg-status-warning/10 hover:bg-status-warning/20 border border-status-warning/30 rounded-lg flex items-center gap-2 text-status-warning transition-colors"
          >
            <Plus size={16} /> Select Uninstalled
          </button>
          <button
            onClick={selectAllFleetNodes}
            className="px-4 py-2 bg-blue-500/10 hover:bg-blue-500/20 border border-blue-500/30 rounded-lg flex items-center gap-2 text-blue-500 transition-colors"
          >
            <RefreshCw size={16} /> Select Fleet Nodes
          </button>
          <Link
            to="/settings"
            className="px-4 py-2 bg-text-accent/10 hover:bg-text-accent/20 border border-text-accent/30 rounded-lg flex items-center gap-2 text-text-accent transition-colors"
          >
            <Settings size={16} /> Auto-Discovery
          </Link>
          <button
            onClick={() => setShowVault(!showVault)}
            className="px-4 py-2 bg-bg-tertiary hover:bg-bg-hover border border-border-subtle rounded-lg flex items-center gap-2 text-text-secondary hover:text-text-primary transition-colors"
          >
            <Key size={16} /> Credential Vault
          </button>
        </div>
      </div>

      {/* Vault Panel */}
      {showVault && (
        <div className="mb-6 bg-bg-secondary p-4 rounded-lg border border-border-subtle">
          <h3 className="font-bold mb-4 flex items-center gap-2 text-text-primary">
            <Key size={18} /> Saved Credentials
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 mb-4">
            {credentials.map(c => (
              <div key={c.id} className="p-3 bg-bg-tertiary rounded-lg border border-border-subtle flex justify-between items-center">
                <div>
                  <div className="font-medium text-text-primary text-sm">{c.name}</div>
                  <div className="text-xs text-text-muted">{c.username}</div>
                </div>
                <StatusDot status="online" size="sm" />
              </div>
            ))}
            {credentials.length === 0 && (
              <div className="text-text-muted text-sm col-span-full">No credentials saved</div>
            )}
          </div>
          <div className="flex gap-2 items-end">
            <div className="flex-1">
              <label className="text-xs text-text-muted mb-1 block">Name</label>
              <input
                className="w-full bg-bg-tertiary border border-border-subtle rounded-lg px-3 py-2 text-text-primary text-sm focus:outline-none focus:border-text-accent"
                value={newCred.name}
                onChange={e => setNewCred({ ...newCred, name: e.target.value })}
                placeholder="e.g. Jetson Default"
              />
            </div>
            <div className="flex-1">
              <label className="text-xs text-text-muted mb-1 block">Username</label>
              <input
                className="w-full bg-bg-tertiary border border-border-subtle rounded-lg px-3 py-2 text-text-primary text-sm focus:outline-none focus:border-text-accent"
                value={newCred.username}
                onChange={e => setNewCred({ ...newCred, username: e.target.value })}
                placeholder="nvidia"
              />
            </div>
            <div className="flex-1">
              <label className="text-xs text-text-muted mb-1 block">Password</label>
              <input
                type="password"
                className="w-full bg-bg-tertiary border border-border-subtle rounded-lg px-3 py-2 text-text-primary text-sm focus:outline-none focus:border-text-accent"
                value={newCred.password}
                onChange={e => setNewCred({ ...newCred, password: e.target.value })}
              />
            </div>
            <button
              onClick={handleSaveCred}
              className="px-4 py-2 bg-text-accent hover:bg-text-accent/80 rounded-lg text-bg-primary font-medium transition-colors"
            >
              Save
            </button>
          </div>
        </div>
      )}

      {/* Scan Controls */}
      <div className="flex gap-4 items-end bg-bg-secondary p-4 rounded-lg border border-border-subtle mb-6">
        <div className="flex-1 max-w-xs">
          <label className="block text-xs text-text-muted mb-1">Target Subnet</label>
          <input
            type="text"
            value={subnet}
            onChange={(e) => setSubnet(e.target.value)}
            className="w-full bg-bg-tertiary border border-border-subtle rounded-lg px-3 py-2 text-text-primary focus:outline-none focus:border-text-accent"
            placeholder="192.168.1.0/24"
          />
        </div>
        <div className="flex-1">
          <label className="block text-xs text-text-muted mb-1">Search Devices</label>
          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-bg-tertiary border border-border-subtle rounded-lg pl-9 pr-3 py-2 text-text-primary focus:outline-none focus:border-text-accent"
              placeholder="IP, hostname, MAC..."
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary"
              >
                <X size={14} />
              </button>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {/* Cache indicator */}
          {lastScanTime && (
            <div className={clsx(
              'px-3 py-2 rounded-lg text-xs flex items-center gap-2',
              isCached ? 'bg-status-warning/10 text-status-warning border border-status-warning/30' : 'bg-status-online/10 text-status-online border border-status-online/30'
            )}>
              {isCached ? <Database size={14} /> : <Clock size={14} />}
              {isCached ? 'Cached' : 'Fresh'}
            </div>
          )}
          {/* Quick Refresh - instant update of fleet nodes from Redis */}
          <button
            onClick={handleQuickRefresh}
            disabled={refreshing}
            className={clsx(
              'px-4 py-2 rounded-lg font-medium flex items-center gap-2 transition-colors border',
              refreshing
                ? 'bg-bg-tertiary text-text-muted cursor-not-allowed border-border-subtle'
                : 'bg-cluster-spark/10 hover:bg-cluster-spark/20 text-cluster-spark border-cluster-spark/30'
            )}
            title="Quick refresh - updates fleet nodes instantly from heartbeats"
          >
            {refreshing ? (
              <>
                <Loader2 size={16} className="animate-spin" /> Refreshing...
              </>
            ) : (
              <>
                <Zap size={16} /> Quick Refresh
              </>
            )}
          </button>
          {/* Full Network Scan */}
          <button
            onClick={handleScan}
            disabled={loading}
            className={clsx(
              'px-6 py-2 rounded-lg font-medium flex items-center gap-2 transition-colors',
              loading
                ? 'bg-bg-tertiary text-text-muted cursor-not-allowed'
                : 'bg-text-accent hover:bg-text-accent/80 text-bg-primary'
            )}
          >
            {loading ? (
              <>
                <Loader2 size={18} className="animate-spin" /> Scanning...
              </>
            ) : (
              <>
                <RefreshCw size={18} /> Full Scan
              </>
            )}
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-status-error/10 border border-status-error/30 text-status-error p-4 rounded-lg mb-6 flex items-center gap-2">
          <AlertCircle size={20} /> {error}
        </div>
      )}

      {/* Stats & Filters */}
      {scanStats && !loading && (
        <div className="flex flex-wrap items-center gap-4 mb-6">
          {/* Device Type Stats */}
          <div className="flex items-center gap-2 flex-wrap">
            <FilterButton
              active={filterType === 'all'}
              onClick={() => setFilterType('all')}
              count={scanStats.count}
              label="All"
              color="#666"
            />
            <FilterButton
              active={filterType === 'fleet'}
              onClick={() => setFilterType('fleet')}
              count={scanStats.fleet_nodes || 0}
              label="Fleet Nodes"
              color="#76b900"
            />
            <FilterButton
              active={filterType === 'not_installed'}
              onClick={() => setFilterType('not_installed')}
              count={scanStats.not_installed || 0}
              label="Not Installed"
              color="#f59e0b"
            />
            {Object.entries(scanStats.by_type || {}).map(([type, count]) => {
              const config = DEVICE_CONFIGS[type] || DEVICE_CONFIGS.unknown;
              return (
                <FilterButton
                  key={type}
                  active={filterType === type}
                  onClick={() => setFilterType(type)}
                  count={count}
                  label={config.label}
                  color={config.color}
                />
              );
            })}
          </div>

          <div className="ml-auto text-text-muted text-sm">
            Showing {filteredHosts.length} of {hosts.length} devices
          </div>
        </div>
      )}

      {/* Hosts Grouped by Cluster */}
      {(() => {
        // Group hosts by cluster
        const clusters = {};
        const unassigned = [];

        filteredHosts.forEach(host => {
          const cluster = host.cluster || '';
          if (cluster && host.is_fleet_node) {
            if (!clusters[cluster]) clusters[cluster] = [];
            clusters[cluster].push(host);
          } else {
            unassigned.push(host);
          }
        });

        const clusterNames = Object.keys(clusters).sort();

        return (
          <>
            {/* Clustered Nodes */}
            {clusterNames.map(clusterName => (
              <div key={clusterName} className="mb-6">
                <div className="flex items-center gap-2 mb-3">
                  <div className="px-3 py-1 bg-cluster-spark/20 text-cluster-spark rounded-lg text-sm font-semibold uppercase tracking-wide">
                    {clusterName} Cluster
                  </div>
                  <span className="text-text-muted text-sm">{clusters[clusterName].length} nodes</span>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-3">
                  {clusters[clusterName].map((host, idx) => {
                    const installJob = batchQueueStatus?.jobs?.find(j => j.ip === host.ip);
                    return (
                      <HostCardCompact
                        key={idx}
                        host={host}
                        credentials={credentials}
                        joiningNode={joiningNode}
                        onInstall={() => setInstallTarget(host)}
                        onJoinSwarm={handleJoinSwarm}
                        onDetails={() => setDetailsHost(host)}
                        isSelected={selectedForQueue.some(h => h.ip === host.ip)}
                        onToggleSelect={toggleNodeSelection}
                        installJob={installJob}
                        availableClusters={availableClusters}
                        onAssignCluster={handleAssignCluster}
                      />
                    );
                  })}
                </div>
              </div>
            ))}

            {/* Unassigned / Other Devices */}
            {unassigned.length > 0 && (
              <div className="mb-6">
                {clusterNames.length > 0 && (
                  <div className="flex items-center gap-2 mb-3">
                    <div className="px-3 py-1 bg-bg-tertiary text-text-muted rounded-lg text-sm font-semibold uppercase tracking-wide">
                      Other Devices
                    </div>
                    <span className="text-text-muted text-sm">{unassigned.length} devices</span>
                  </div>
                )}
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                  {unassigned.map((host, idx) => {
                    const installJob = batchQueueStatus?.jobs?.find(j => j.ip === host.ip);
                    return (
                      <HostCard
                        key={idx}
                        host={host}
                        credentials={credentials}
                        joiningNode={joiningNode}
                        onInstall={() => setInstallTarget(host)}
                        onJoinSwarm={handleJoinSwarm}
                        onDetails={() => setDetailsHost(host)}
                        isSelected={selectedForQueue.some(h => h.ip === host.ip)}
                        onToggleSelect={toggleNodeSelection}
                        installJob={installJob}
                      />
                    );
                  })}
                </div>
              </div>
            )}

            {filteredHosts.length === 0 && !loading && (
              <div className="text-center py-12 text-text-muted">
                {hosts.length === 0 ? 'No devices found. Run a scan to discover devices.' : 'No devices match the current filter.'}
              </div>
            )}
          </>
        );
      })()}

      {/* Install Modal */}
      {installTarget && (
        <InstallModal
          host={installTarget}
          credentials={credentials}
          selectedCred={selectedCred}
          setSelectedCred={setSelectedCred}
          installStatus={installStatus}
          onInstall={handleInstall}
          onClose={() => {
            setInstallTarget(null);
            setInstallStatus(null);
          }}
        />
      )}

      {/* Details Modal */}
      {detailsHost && (
        <NodeDetailsModal
          host={detailsHost}
          credentials={credentials}
          onClose={() => setDetailsHost(null)}
          onInstall={(host) => {
            setDetailsHost(null);
            setInstallTarget(host);
          }}
        />
      )}

      {/* Batch Install Modal */}
      {showBatchInstall && (
        <BatchInstallModal
          selectedNodes={selectedForQueue}
          credentials={credentials}
          onInstall={startBatchInstall}
          onClose={() => setShowBatchInstall(false)}
          onRemoveNode={(ip) => setSelectedForQueue(selectedForQueue.filter(h => h.ip !== ip))}
          mode={batchInstallMode}
        />
      )}

      {/* Batch Queue Status Panel */}
      {batchQueueStatus && batchQueueStatus.jobs?.length > 0 && (
        <div className="fixed bottom-4 right-4 w-96 bg-bg-secondary border border-border-subtle rounded-lg shadow-xl z-40 max-h-96 overflow-hidden">
          <div className="p-3 border-b border-border-subtle flex items-center justify-between bg-bg-tertiary">
            <div className="flex items-center gap-2">
              <ListTodo size={16} className="text-text-accent" />
              <span className="font-semibold text-text-primary">Install Queue</span>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <span className="px-2 py-0.5 bg-status-online/20 text-status-online rounded">
                {batchQueueStatus.summary?.completed || 0} done
              </span>
              <span className="px-2 py-0.5 bg-blue-500/20 text-blue-500 rounded">
                {batchQueueStatus.summary?.running || 0} running
              </span>
              <span className="px-2 py-0.5 bg-yellow-500/20 text-yellow-500 rounded">
                {batchQueueStatus.summary?.queued || 0} queued
              </span>
              <button
                onClick={() => setBatchQueueStatus(null)}
                className="p-1 hover:bg-bg-hover rounded"
              >
                <X size={12} />
              </button>
            </div>
          </div>
          <div className="max-h-64 overflow-y-auto">
            {batchQueueStatus.jobs?.map(job => (
              <div key={job.id} className="p-2 border-b border-border-subtle last:border-0">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm text-text-primary font-mono">{job.ip}</span>
                  <span className={clsx(
                    'px-2 py-0.5 rounded text-xs',
                    job.status === 'completed' && 'bg-status-online/20 text-status-online',
                    job.status === 'running' && 'bg-blue-500/20 text-blue-500',
                    job.status === 'queued' && 'bg-yellow-500/20 text-yellow-500',
                    job.status === 'failed' && 'bg-status-error/20 text-status-error'
                  )}>
                    {job.status}
                  </span>
                </div>
                {job.status === 'running' && (
                  <div className="w-full h-1 bg-bg-tertiary rounded overflow-hidden">
                    <div
                      className="h-full bg-blue-500 transition-all"
                      style={{ width: `${job.progress}%` }}
                    />
                  </div>
                )}
                {job.error && (
                  <div className="text-xs text-status-error mt-1 truncate">{job.error}</div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

const FilterButton = ({ active, onClick, count, label, color }) => (
  <button
    onClick={onClick}
    className={clsx(
      'px-3 py-1.5 rounded-lg text-sm flex items-center gap-2 transition-colors border',
      active
        ? 'bg-text-accent/10 border-text-accent text-text-accent'
        : 'bg-bg-tertiary border-border-subtle text-text-secondary hover:text-text-primary hover:border-border-bright'
    )}
  >
    <span
      className="w-2 h-2 rounded-full"
      style={{ backgroundColor: color }}
    />
    {label}
    <span className="text-xs opacity-70">({count})</span>
  </button>
);

const HostCard = ({ host, credentials, joiningNode, onInstall, onJoinSwarm, onDetails, isSelected, onToggleSelect, installJob }) => {
  const [selectedCred, setSelectedCred] = useState('');
  const deviceType = host.device?.type || 'unknown';
  const config = DEVICE_CONFIGS[deviceType] || DEVICE_CONFIGS.unknown;
  const Icon = config.icon;
  const isJetsonOrLinux = deviceType === 'agx' || deviceType === 'linux';
  const isJoining = joiningNode === host.ip;
  const canBeFleetNode = isJetsonOrLinux && !host.is_fleet_node;
  const isSpark = deviceType === 'spark';
  const isInstalling = installJob?.status === 'running' || installJob?.status === 'queued';
  const installFailed = installJob?.status === 'failed';
  const installCompleted = installJob?.status === 'completed';

  return (
    <div
      className={clsx(
        'bg-bg-secondary border-2 rounded-lg p-4 hover:border-border-bright transition-all relative',
        host.is_fleet_node ? config.borderColor : canBeFleetNode ? 'border-status-warning/50' : 'border-border-subtle',
        host.is_fleet_node && 'shadow-lg',
        canBeFleetNode && 'shadow-md',
        isSelected && 'ring-2 ring-cluster-spark ring-offset-2 ring-offset-bg-primary',
        installJob && 'pt-8'
      )}
      style={host.is_fleet_node ? { boxShadow: `0 0 20px ${config.color}20` } : canBeFleetNode ? { boxShadow: '0 0 15px rgba(245, 158, 11, 0.2)' } : {}}
    >
      {/* Selection Checkbox (for installable nodes and fleet nodes) */}
      {(canBeFleetNode || host.is_fleet_node) && onToggleSelect && !isInstalling && (
        <button
          onClick={(e) => { e.stopPropagation(); onToggleSelect(host); }}
          className={clsx(
            'absolute top-2 right-2 w-6 h-6 rounded border-2 flex items-center justify-center transition-all',
            isSelected
              ? 'bg-cluster-spark border-cluster-spark text-white'
              : 'bg-bg-tertiary border-border-subtle hover:border-cluster-spark'
          )}
        >
          {isSelected && <CheckCircle size={14} />}
        </button>
      )}

      {/* Install Status Banner */}
      {installJob && (
        <div className={clsx(
          'absolute top-0 left-0 right-0 px-3 py-1.5 text-xs font-medium flex items-center justify-between rounded-t-lg',
          installJob.status === 'running' && 'bg-blue-500/20 text-blue-400 border-b border-blue-500/30',
          installJob.status === 'queued' && 'bg-yellow-500/20 text-yellow-400 border-b border-yellow-500/30',
          installJob.status === 'completed' && 'bg-status-online/20 text-status-online border-b border-status-online/30',
          installJob.status === 'failed' && 'bg-status-error/20 text-status-error border-b border-status-error/30'
        )}>
          <span className="flex items-center gap-1.5">
            {installJob.status === 'running' && <Loader2 size={12} className="animate-spin" />}
            {installJob.status === 'queued' && <Clock size={12} />}
            {installJob.status === 'completed' && <CheckCircle size={12} />}
            {installJob.status === 'failed' && <AlertTriangle size={12} />}
            {installJob.status === 'running' && `Installing... ${installJob.progress}%`}
            {installJob.status === 'queued' && 'Queued for install'}
            {installJob.status === 'completed' && 'Install complete - rebooting'}
            {installJob.status === 'failed' && 'Install failed'}
          </span>
          {installJob.status === 'failed' && installJob.error && (
            <span className="text-[10px] opacity-80 truncate max-w-[120px]" title={installJob.error}>
              {installJob.error}
            </span>
          )}
        </div>
      )}

      {/* Header */}
      <div className="flex items-start justify-between mb-3">
        <div
          className={clsx('p-2 rounded-lg', config.bgColor)}
          style={{ color: config.color }}
        >
          <Icon size={24} />
        </div>
        <div className="flex items-center gap-2">
          {isSpark && (
            <span className="px-2 py-0.5 text-xs bg-cluster-spark/20 text-cluster-spark rounded border border-cluster-spark/30 animate-pulse">
              SPARK
            </span>
          )}
          {host.is_fleet_node && !isSpark && (
            <span className="px-2 py-0.5 text-xs bg-cluster-spark/20 text-cluster-spark rounded border border-cluster-spark/30">
              FLEET
            </span>
          )}
          {canBeFleetNode && (
            <span className="px-2 py-0.5 text-xs bg-status-warning/20 text-status-warning rounded border border-status-warning/30">
              NOT INSTALLED
            </span>
          )}
          <span className="px-2 py-0.5 text-xs bg-status-online/20 text-status-online rounded border border-status-online/30">
            ONLINE
          </span>
        </div>
      </div>

      {/* Device Info */}
      <div className="mb-3">
        <div className="font-mono text-lg font-bold text-text-primary">{host.ip}</div>
        <div className="text-text-secondary text-sm truncate">
          {host.name || 'Unknown Host'}
        </div>
        <div className="flex items-center gap-2 mt-1">
          <span
            className="px-2 py-0.5 text-xs rounded font-medium"
            style={{
              backgroundColor: `${config.color}20`,
              color: config.color,
            }}
          >
            {host.device?.label || config.label}
          </span>
          {host.fleet_node_id && (
            <span className="text-xs text-text-muted">
              {host.fleet_node_id}
            </span>
          )}
        </div>
      </div>

      {/* Ports */}
      {host.open_ports && host.open_ports.length > 0 && (
        <div className="mb-3 text-xs">
          <span className="text-text-muted">Ports: </span>
          <span className="text-text-secondary font-mono">
            {host.open_ports.slice(0, 5).join(', ')}
            {host.open_ports.length > 5 && ` +${host.open_ports.length - 5}`}
          </span>
        </div>
      )}

      {/* MAC Address */}
      {host.mac && (
        <div className="mb-3 text-xs">
          <span className="text-text-muted">MAC: </span>
          <span className="text-text-secondary font-mono">{host.mac}</span>
        </div>
      )}

      {/* Power & Activity (for fleet nodes) */}
      {host.is_fleet_node && host.registered_data && (
        <div className="mb-3 p-2 bg-bg-tertiary rounded-lg">
          <div className="grid grid-cols-2 gap-2 text-xs">
            {/* Power */}
            <div className="flex items-center gap-1.5">
              <Zap size={12} className="text-yellow-500" />
              <span className="text-text-muted">Power:</span>
              <span className="text-text-primary font-medium">
                {host.registered_data.power?.total_w?.toFixed(1) || '0'}W
              </span>
            </div>
            {/* Activity */}
            <div className="flex items-center gap-1.5">
              <Activity size={12} className={clsx(
                host.registered_data.activity?.status === 'computing' && 'text-green-500',
                host.registered_data.activity?.status === 'working' && 'text-blue-500',
                host.registered_data.activity?.status === 'ready' && 'text-yellow-500',
                host.registered_data.activity?.status === 'idle' && 'text-gray-500'
              )} />
              <span className="text-text-muted">Status:</span>
              <span className={clsx(
                'font-medium capitalize',
                host.registered_data.activity?.status === 'computing' && 'text-green-500',
                host.registered_data.activity?.status === 'working' && 'text-blue-500',
                host.registered_data.activity?.status === 'ready' && 'text-yellow-500',
                host.registered_data.activity?.status === 'idle' && 'text-gray-400'
              )}>
                {host.registered_data.activity?.status || 'Unknown'}
              </span>
            </div>
            {/* CPU */}
            <div className="flex items-center gap-1.5">
              <Cpu size={12} className="text-blue-400" />
              <span className="text-text-muted">CPU:</span>
              <span className="text-text-primary">
                {host.registered_data.cpu_percent?.toFixed(0) || '0'}%
              </span>
            </div>
            {/* Containers */}
            <div className="flex items-center gap-1.5">
              <Box size={12} className="text-purple-400" />
              <span className="text-text-muted">Containers:</span>
              <span className="text-text-primary">
                {host.registered_data.activity?.containers || '0'}
              </span>
            </div>
          </div>
          {/* Activity Detail */}
          {host.registered_data.activity?.detail && (
            <div className="mt-1.5 pt-1.5 border-t border-border-subtle text-xs text-text-muted truncate">
              {host.registered_data.activity.detail}
            </div>
          )}
        </div>
      )}

      {/* Quick Join Swarm (for Jetson/Linux only) */}
      {isJetsonOrLinux && !host.is_fleet_node && (
        <div className="mb-3 p-2 bg-bg-tertiary rounded-lg">
          <div className="text-xs text-text-muted mb-1">Quick Join Swarm</div>
          <div className="flex gap-2">
            <select
              value={selectedCred}
              onChange={(e) => setSelectedCred(e.target.value)}
              className="flex-1 bg-bg-secondary border border-border-subtle rounded px-2 py-1 text-text-primary text-xs"
            >
              <option value="">Select credential...</option>
              {credentials.map(c => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
            <button
              onClick={() => onJoinSwarm(host, selectedCred)}
              disabled={!selectedCred || isJoining}
              className={clsx(
                'px-2 py-1 rounded text-xs flex items-center gap-1',
                selectedCred && !isJoining
                  ? 'bg-status-online/20 text-status-online hover:bg-status-online/30'
                  : 'bg-bg-secondary text-text-muted cursor-not-allowed'
              )}
            >
              {isJoining ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Plus size={12} />
              )}
              Join
            </button>
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="pt-3 border-t border-border-subtle flex gap-2">
        <button
          onClick={onInstall}
          disabled={deviceType === 'windows' || deviceType === 'router'}
          className={clsx(
            'flex-1 py-2 text-xs rounded-lg flex items-center justify-center gap-1 transition-colors',
            deviceType === 'windows' || deviceType === 'router'
              ? 'bg-bg-tertiary text-text-muted cursor-not-allowed'
              : 'bg-text-accent hover:bg-text-accent/80 text-bg-primary'
          )}
        >
          <Download size={14} />
          {host.is_fleet_node ? 'Reinstall' : 'Install Agent'}
        </button>
        <button
          onClick={onDetails}
          className="flex-1 py-2 text-xs bg-bg-tertiary hover:bg-bg-hover text-text-secondary rounded-lg flex items-center justify-center gap-1 transition-colors"
        >
          <Eye size={14} /> Details
        </button>
      </div>
    </div>
  );
};

// Compact card for clustered nodes - skinnier layout
const HostCardCompact = ({ host, credentials, joiningNode, onInstall, onJoinSwarm, onDetails, isSelected, onToggleSelect, installJob, availableClusters, onAssignCluster }) => {
  const deviceType = host.device?.type || 'unknown';
  const config = DEVICE_CONFIGS[deviceType] || DEVICE_CONFIGS.unknown;
  const Icon = config.icon;
  const isInstalling = installJob?.status === 'running' || installJob?.status === 'queued';
  const activity = host.registered_data?.activity?.status || 'unknown';
  const power = host.registered_data?.power?.total_w || 0;
  const currentCluster = host.cluster || '';
  const [showClusterMenu, setShowClusterMenu] = useState(false);

  return (
    <div
      onClick={onDetails}
      className={clsx(
        'bg-bg-secondary border rounded-lg p-3 cursor-pointer transition-all hover:border-border-bright relative',
        host.is_fleet_node ? 'border-cluster-spark/50' : 'border-border-subtle',
        isSelected && 'ring-2 ring-cluster-spark'
      )}
    >
      {/* Install Status Banner */}
      {installJob && (
        <div className={clsx(
          'absolute top-0 left-0 right-0 px-2 py-1 text-[10px] font-medium flex items-center gap-1 rounded-t-lg',
          installJob.status === 'running' && 'bg-blue-500/20 text-blue-400',
          installJob.status === 'queued' && 'bg-yellow-500/20 text-yellow-400',
          installJob.status === 'completed' && 'bg-status-online/20 text-status-online',
          installJob.status === 'failed' && 'bg-status-error/20 text-status-error'
        )}>
          {installJob.status === 'running' && <Loader2 size={10} className="animate-spin" />}
          {installJob.status === 'running' && `${installJob.progress}%`}
          {installJob.status === 'queued' && 'Queued'}
          {installJob.status === 'completed' && 'Done'}
          {installJob.status === 'failed' && 'Failed'}
        </div>
      )}

      {/* Selection Checkbox */}
      {onToggleSelect && !isInstalling && (
        <button
          onClick={(e) => { e.stopPropagation(); onToggleSelect(host); }}
          className={clsx(
            'absolute top-1 right-1 w-5 h-5 rounded border flex items-center justify-center transition-all',
            isSelected
              ? 'bg-cluster-spark border-cluster-spark text-white'
              : 'bg-bg-tertiary border-border-subtle hover:border-cluster-spark'
          )}
        >
          {isSelected && <CheckCircle size={10} />}
        </button>
      )}

      {/* Content */}
      <div className={clsx('flex items-center gap-2', installJob && 'mt-4')}>
        <div
          className={clsx('p-1.5 rounded', config.bgColor)}
          style={{ color: config.color }}
        >
          <Icon size={16} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-text-primary truncate">
            {host.fleet_node_id || host.name || host.ip}
          </div>
          <div className="text-[10px] text-text-muted font-mono">
            {host.ip}
          </div>
        </div>
      </div>

      {/* Status Row */}
      <div className="mt-2 flex items-center justify-between text-[10px]">
        <span className={clsx(
          'px-1.5 py-0.5 rounded',
          activity === 'computing' && 'bg-status-warning/20 text-status-warning',
          activity === 'idle' && 'bg-status-online/20 text-status-online',
          activity === 'ready' && 'bg-blue-500/20 text-blue-500',
          !['computing', 'idle', 'ready'].includes(activity) && 'bg-bg-tertiary text-text-muted'
        )}>
          {activity}
        </span>
        {power > 0 && (
          <span className="text-text-muted">
            {power.toFixed(0)}W
          </span>
        )}
      </div>

      {/* Cluster Assignment */}
      {host.is_fleet_node && onAssignCluster && (
        <div className="mt-2 relative">
          <button
            onClick={(e) => { e.stopPropagation(); setShowClusterMenu(!showClusterMenu); }}
            className="w-full px-2 py-1 text-[10px] bg-bg-tertiary hover:bg-bg-primary rounded border border-border-subtle flex items-center justify-between"
          >
            <span className={currentCluster ? 'text-cluster-spark' : 'text-text-muted'}>
              {currentCluster || 'Unassigned'}
            </span>
            <ChevronDown size={10} />
          </button>
          {showClusterMenu && (
            <div className="absolute top-full left-0 right-0 mt-1 bg-bg-secondary border border-border-subtle rounded shadow-lg z-50">
              {availableClusters?.map(cluster => (
                <button
                  key={cluster}
                  onClick={(e) => {
                    e.stopPropagation();
                    onAssignCluster(host, cluster);
                    setShowClusterMenu(false);
                  }}
                  className={clsx(
                    'w-full px-2 py-1 text-[10px] text-left hover:bg-bg-tertiary',
                    currentCluster === cluster && 'bg-cluster-spark/20 text-cluster-spark'
                  )}
                >
                  {cluster}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

const InstallModal = ({
  host,
  credentials,
  selectedCred,
  setSelectedCred,
  installStatus,
  onInstall,
  onClose
}) => {
  const deviceConfig = DEVICE_CONFIGS[host.device?.type] || DEVICE_CONFIGS.unknown;

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
      <div className="bg-bg-secondary rounded-lg w-full max-w-lg border border-border-subtle max-h-[90vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="p-4 border-b border-border-subtle flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div
              className={clsx('p-2 rounded-lg', deviceConfig.bgColor)}
              style={{ color: deviceConfig.color }}
            >
              <deviceConfig.icon size={20} />
            </div>
            <div>
              <h3 className="font-bold text-text-primary">Install Fleet Agent</h3>
              <p className="text-text-muted text-sm">{host.ip} • {host.name || 'Unknown'}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg hover:bg-bg-hover text-text-muted hover:text-text-primary transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        {/* Content */}
        <div className="p-4 flex-1 overflow-auto">
          {!installStatus ? (
            <>
              <div className="mb-4">
                <label className="block text-sm text-text-secondary mb-2">Select Credential</label>
                <select
                  className="w-full bg-bg-tertiary border border-border-subtle rounded-lg px-3 py-2 text-text-primary focus:outline-none focus:border-text-accent"
                  value={selectedCred}
                  onChange={e => setSelectedCred(e.target.value)}
                >
                  <option value="">-- Select SSH Credential --</option>
                  {credentials.map(c => (
                    <option key={c.id} value={c.id}>{c.name} ({c.username})</option>
                  ))}
                </select>
              </div>

              <div className="p-3 bg-bg-tertiary rounded-lg text-sm text-text-muted mb-4">
                <p>The Fleet Agent will:</p>
                <ul className="list-disc list-inside mt-2 space-y-1 text-text-secondary">
                  <li>Install required dependencies</li>
                  <li>Join the Docker Swarm cluster</li>
                  <li>Start the metrics collection agent</li>
                  <li>Connect back to: <span className="text-text-accent">{window.location.hostname}</span></li>
                </ul>
              </div>
            </>
          ) : (
            <>
              {/* Status Banner */}
              <div className={clsx(
                'flex items-center gap-3 p-3 rounded-lg mb-4',
                installStatus.status === 'running' && 'bg-text-accent/10 border border-text-accent/30',
                installStatus.status === 'completed' && 'bg-status-online/10 border border-status-online/30',
                (installStatus.status === 'error' || installStatus.status === 'failed') && 'bg-status-error/10 border border-status-error/30'
              )}>
                {installStatus.status === 'running' && (
                  <Loader2 size={20} className="animate-spin text-text-accent" />
                )}
                {installStatus.status === 'completed' && (
                  <CheckCircle size={20} className="text-status-online" />
                )}
                {(installStatus.status === 'error' || installStatus.status === 'failed') && (
                  <XCircle size={20} className="text-status-error" />
                )}
                <div className="flex-1">
                  <div className={clsx(
                    'font-medium',
                    installStatus.status === 'running' && 'text-text-accent',
                    installStatus.status === 'completed' && 'text-status-online',
                    (installStatus.status === 'error' || installStatus.status === 'failed') && 'text-status-error'
                  )}>
                    {installStatus.status === 'running' && 'Installing Agent...'}
                    {installStatus.status === 'completed' && 'Installation Complete'}
                    {(installStatus.status === 'error' || installStatus.status === 'failed') && 'Installation Failed'}
                  </div>
                </div>
              </div>

              {/* Log Output */}
              <div className="bg-bg-primary p-4 rounded-lg font-mono text-xs text-text-secondary h-64 overflow-y-auto border border-border-subtle whitespace-pre-wrap">
                {installStatus.log}
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-border-subtle flex justify-end gap-3">
          {!installStatus ? (
            <>
              <button
                onClick={onClose}
                className="px-4 py-2 text-text-secondary hover:text-text-primary transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={onInstall}
                disabled={!selectedCred}
                className="px-6 py-2 bg-text-accent hover:bg-text-accent/80 text-bg-primary rounded-lg font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                Start Installation
              </button>
            </>
          ) : (
            installStatus.status !== 'running' && (
              <button
                onClick={onClose}
                className="px-4 py-2 bg-bg-tertiary hover:bg-bg-hover text-text-primary rounded-lg transition-colors"
              >
                Close
              </button>
            )
          )}
        </div>
      </div>
    </div>
  );
};

// Batch Install Modal
const BatchInstallModal = ({ selectedNodes, credentials, onInstall, onClose, onRemoveNode, mode = 'install' }) => {
  const [selectedCred, setSelectedCred] = useState('');
  const isReinstall = mode === 'reinstall';

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
      <div className="bg-bg-secondary rounded-lg w-full max-w-2xl border border-border-subtle max-h-[90vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="p-4 border-b border-border-subtle flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className={clsx(
              'p-2 rounded-lg',
              isReinstall ? 'bg-blue-500/20 text-blue-500' : 'bg-cluster-spark/20 text-cluster-spark'
            )}>
              {isReinstall ? <RefreshCw size={24} /> : <ListTodo size={24} />}
            </div>
            <div>
              <h3 className="font-bold text-text-primary">
                {isReinstall ? 'Batch Reinstall Fleet Agent' : 'Batch Install Fleet Agent'}
              </h3>
              <p className="text-text-muted text-sm">{selectedNodes.length} nodes selected</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg hover:bg-bg-hover text-text-muted hover:text-text-primary transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        {/* Content */}
        <div className="p-4 flex-1 overflow-auto">
          {/* Credential Selection */}
          <div className="mb-4">
            <label className="block text-sm text-text-secondary mb-2">Select SSH Credential</label>
            <select
              className="w-full bg-bg-tertiary border border-border-subtle rounded-lg px-3 py-2 text-text-primary focus:outline-none focus:border-text-accent"
              value={selectedCred}
              onChange={e => setSelectedCred(e.target.value)}
            >
              <option value="">-- Select SSH Credential --</option>
              {credentials.map(c => (
                <option key={c.id} value={c.id}>{c.name} ({c.username})</option>
              ))}
            </select>
          </div>

          {/* Selected Nodes List */}
          <div className="mb-4">
            <label className="block text-sm text-text-secondary mb-2">
              {isReinstall ? 'Nodes to Reinstall' : 'Nodes to Install'}
            </label>
            <div className="space-y-2 max-h-64 overflow-auto">
              {selectedNodes.map(host => (
                <div key={host.ip} className="flex items-center justify-between p-3 bg-bg-tertiary rounded-lg">
                  <div className="flex items-center gap-3">
                    <Cpu size={16} className={isReinstall ? 'text-blue-500' : 'text-status-warning'} />
                    <div>
                      <div className="font-mono text-sm text-text-primary">{host.ip}</div>
                      <div className="text-xs text-text-muted">
                        {host.fleet_node_id || host.name || 'Unknown'}
                        {host.is_fleet_node && (
                          <span className="ml-2 px-1.5 py-0.5 bg-cluster-spark/20 text-cluster-spark rounded text-[10px]">
                            FLEET
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  <button
                    onClick={() => onRemoveNode(host.ip)}
                    className="p-1.5 hover:bg-bg-hover rounded text-text-muted hover:text-status-error transition-colors"
                    title="Remove from selection"
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* Info Box */}
          <div className={clsx(
            'p-3 rounded-lg text-sm text-text-secondary border',
            isReinstall
              ? 'bg-blue-500/10 border-blue-500/30'
              : 'bg-text-accent/10 border-text-accent/30'
          )}>
            <p className={clsx('font-medium mb-1', isReinstall ? 'text-blue-500' : 'text-text-accent')}>
              {isReinstall ? 'Parallel Reinstallation' : 'Parallel Installation'}
            </p>
            <p>
              Up to 3 nodes will be {isReinstall ? 'reinstalled' : 'installed'} simultaneously.
              Each {isReinstall ? 'reinstallation' : 'installation'} takes 3-5 minutes.
              Nodes will reboot after {isReinstall ? 'reinstallation' : 'installation'}.
            </p>
            {isReinstall && (
              <p className="mt-2 text-status-warning">
                Warning: This will stop any running containers and reinstall the fleet agent.
              </p>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-border-subtle flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-text-secondary hover:text-text-primary transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => onInstall(selectedCred)}
            disabled={!selectedCred || selectedNodes.length === 0}
            className={clsx(
              'px-6 py-2 text-white rounded-lg font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2',
              isReinstall ? 'bg-blue-500 hover:bg-blue-600' : 'bg-cluster-spark hover:bg-cluster-spark/80'
            )}
          >
            {isReinstall ? <RefreshCw size={16} /> : <Download size={16} />}
            Start {isReinstall ? 'Reinstallation' : 'Installation'} ({selectedNodes.length} nodes)
          </button>
        </div>
      </div>
    </div>
  );
};

export default NetworkView;

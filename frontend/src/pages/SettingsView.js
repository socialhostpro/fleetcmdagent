import React, { useState, useEffect } from 'react';
import {
  Settings, Network, Key, Search, Plus, Trash2,
  Save, RefreshCw, Eye, EyeOff, Check, AlertCircle,
  Loader2, Server, Cpu, Wifi, WifiOff
} from 'lucide-react';
import clsx from 'clsx';

const API_URL = `http://${window.location.hostname}:8765`;

const SettingsView = () => {
  const [activeTab, setActiveTab] = useState('discovery');

  return (
    <div className="h-full overflow-auto bg-bg-primary p-6">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-text-primary flex items-center gap-2">
          <Settings size={24} />
          Settings
        </h1>
        <p className="text-text-muted text-sm mt-1">
          Configure Fleet Commander settings
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 mb-6 border-b border-border-subtle pb-2">
        <TabButton
          active={activeTab === 'discovery'}
          onClick={() => setActiveTab('discovery')}
          icon={<Network size={16} />}
          label="Discovery"
        />
        <TabButton
          active={activeTab === 'credentials'}
          onClick={() => setActiveTab('credentials')}
          icon={<Key size={16} />}
          label="Credentials"
        />
      </div>

      {/* Tab Content */}
      {activeTab === 'discovery' && <DiscoverySettings />}
      {activeTab === 'credentials' && <CredentialsSettings />}
    </div>
  );
};

const TabButton = ({ active, onClick, icon, label }) => (
  <button
    onClick={onClick}
    className={clsx(
      'flex items-center gap-2 px-4 py-2 rounded-lg transition-colors',
      active
        ? 'bg-text-accent/10 text-text-accent'
        : 'text-text-secondary hover:text-text-primary hover:bg-bg-hover'
    )}
  >
    {icon}
    {label}
  </button>
);

// Discovery Settings Tab
const DiscoverySettings = () => {
  const [settings, setSettings] = useState({
    enabled: false,
    auto_join: false,
    default_credential_id: null,
    scan_subnets: ['192.168.1.0/24'],
    scan_interval_minutes: 60,
    exclude_ips: []
  });
  const [credentials, setCredentials] = useState([]);
  const [discoveredNodes, setDiscoveredNodes] = useState([]);
  const [scanStatus, setScanStatus] = useState({ status: 'idle' });
  const [saving, setSaving] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [newSubnet, setNewSubnet] = useState('');
  const [newExclude, setNewExclude] = useState('');

  // Load settings and data
  useEffect(() => {
    loadSettings();
    loadCredentials();
    loadDiscoveredNodes();

    // Poll scan status if scanning
    const interval = setInterval(() => {
      if (scanning) {
        loadScanStatus();
        loadDiscoveredNodes();
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [scanning]);

  const loadSettings = async () => {
    try {
      const res = await fetch(`${API_URL}/api/discovery/settings`);
      const data = await res.json();
      setSettings(data);
    } catch (e) {
      console.error('Failed to load discovery settings:', e);
    }
  };

  const loadCredentials = async () => {
    try {
      const res = await fetch(`${API_URL}/api/vault`);
      const data = await res.json();
      setCredentials(data);
    } catch (e) {
      console.error('Failed to load credentials:', e);
    }
  };

  const loadDiscoveredNodes = async () => {
    try {
      const res = await fetch(`${API_URL}/api/discovery/nodes`);
      const data = await res.json();
      setDiscoveredNodes(data);
    } catch (e) {
      console.error('Failed to load discovered nodes:', e);
    }
  };

  const loadScanStatus = async () => {
    try {
      const res = await fetch(`${API_URL}/api/discovery/scan-status`);
      const data = await res.json();
      setScanStatus(data);
      if (data.status !== 'running') {
        setScanning(false);
      }
    } catch (e) {
      console.error('Failed to load scan status:', e);
    }
  };

  const saveSettings = async () => {
    setSaving(true);
    try {
      const res = await fetch(`${API_URL}/api/discovery/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings)
      });
      if (res.ok) {
        // Success notification could be added here
      }
    } catch (e) {
      console.error('Failed to save settings:', e);
    } finally {
      setSaving(false);
    }
  };

  const startScan = async () => {
    setScanning(true);
    try {
      await fetch(`${API_URL}/api/discovery/scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
    } catch (e) {
      console.error('Failed to start scan:', e);
      setScanning(false);
    }
  };

  const joinNode = async (ip, clusterId = null) => {
    try {
      const res = await fetch(`${API_URL}/api/discovery/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ip,
          credential_id: settings.default_credential_id,
          cluster_label: clusterId
        })
      });
      const data = await res.json();
      if (res.ok) {
        loadDiscoveredNodes();
      }
      return data;
    } catch (e) {
      console.error('Failed to join node:', e);
    }
  };

  const autoJoinAll = async () => {
    try {
      const res = await fetch(`${API_URL}/api/discovery/auto-join-all`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      if (res.ok) {
        // Start polling for updates
        setScanning(true);
      }
    } catch (e) {
      console.error('Failed to auto-join:', e);
    }
  };

  const addSubnet = () => {
    if (newSubnet && !settings.scan_subnets.includes(newSubnet)) {
      setSettings(prev => ({
        ...prev,
        scan_subnets: [...prev.scan_subnets, newSubnet]
      }));
      setNewSubnet('');
    }
  };

  const removeSubnet = (subnet) => {
    setSettings(prev => ({
      ...prev,
      scan_subnets: prev.scan_subnets.filter(s => s !== subnet)
    }));
  };

  const addExclude = () => {
    if (newExclude && !settings.exclude_ips.includes(newExclude)) {
      setSettings(prev => ({
        ...prev,
        exclude_ips: [...prev.exclude_ips, newExclude]
      }));
      setNewExclude('');
    }
  };

  const removeExclude = (ip) => {
    setSettings(prev => ({
      ...prev,
      exclude_ips: prev.exclude_ips.filter(i => i !== ip)
    }));
  };

  const pendingNodes = discoveredNodes.filter(
    n => n.ssh_accessible && n.swarm_status === 'not_joined'
  );

  return (
    <div className="space-y-6">
      {/* Discovery Toggle */}
      <div className="bg-bg-secondary border border-border-default rounded-lg p-4">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="font-semibold text-text-primary">Network Auto-Discovery</h3>
            <p className="text-text-muted text-sm">
              Automatically discover and add AGX/Linux nodes to the cluster
            </p>
          </div>
          <ToggleSwitch
            checked={settings.enabled}
            onChange={(v) => setSettings(prev => ({ ...prev, enabled: v }))}
          />
        </div>

        {/* Auto-Join Toggle */}
        <div className="flex items-center justify-between py-3 border-t border-border-subtle">
          <div>
            <div className="text-text-primary text-sm">Auto-Join Discovered Nodes</div>
            <div className="text-text-muted text-xs">
              Automatically join new nodes to swarm using default credentials
            </div>
          </div>
          <ToggleSwitch
            checked={settings.auto_join}
            onChange={(v) => setSettings(prev => ({ ...prev, auto_join: v }))}
          />
        </div>

        {/* Default Credential */}
        <div className="py-3 border-t border-border-subtle">
          <label className="block text-text-secondary text-sm mb-2">Default SSH Credential</label>
          <select
            value={settings.default_credential_id || ''}
            onChange={(e) => setSettings(prev => ({ ...prev, default_credential_id: e.target.value || null }))}
            className="w-full bg-bg-tertiary border border-border-default rounded-lg px-4 py-2 text-text-primary focus:outline-none focus:border-text-accent"
          >
            <option value="">Select credential...</option>
            {credentials.map(cred => (
              <option key={cred.id} value={cred.id}>
                {cred.name} ({cred.username})
              </option>
            ))}
          </select>
          {credentials.length === 0 && (
            <p className="text-status-warning text-xs mt-2">
              No credentials in vault. Add credentials in the Credentials tab.
            </p>
          )}
        </div>

        {/* Scan Subnets */}
        <div className="py-3 border-t border-border-subtle">
          <label className="block text-text-secondary text-sm mb-2">Scan Subnets</label>
          <div className="flex flex-wrap gap-2 mb-2">
            {settings.scan_subnets.map(subnet => (
              <span
                key={subnet}
                className="flex items-center gap-1 px-2 py-1 bg-bg-tertiary rounded text-text-primary text-sm"
              >
                {subnet}
                <button
                  onClick={() => removeSubnet(subnet)}
                  className="text-text-muted hover:text-status-error"
                >
                  <Trash2 size={12} />
                </button>
              </span>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              type="text"
              value={newSubnet}
              onChange={(e) => setNewSubnet(e.target.value)}
              placeholder="192.168.2.0/24"
              className="flex-1 bg-bg-tertiary border border-border-default rounded px-3 py-1.5 text-text-primary text-sm"
            />
            <button
              onClick={addSubnet}
              className="px-3 py-1.5 bg-bg-tertiary border border-border-default rounded hover:border-text-accent text-text-secondary"
            >
              <Plus size={16} />
            </button>
          </div>
        </div>

        {/* Exclude IPs */}
        <div className="py-3 border-t border-border-subtle">
          <label className="block text-text-secondary text-sm mb-2">Exclude IPs</label>
          <div className="flex flex-wrap gap-2 mb-2">
            {settings.exclude_ips.map(ip => (
              <span
                key={ip}
                className="flex items-center gap-1 px-2 py-1 bg-bg-tertiary rounded text-text-primary text-sm"
              >
                {ip}
                <button
                  onClick={() => removeExclude(ip)}
                  className="text-text-muted hover:text-status-error"
                >
                  <Trash2 size={12} />
                </button>
              </span>
            ))}
            {settings.exclude_ips.length === 0 && (
              <span className="text-text-muted text-sm">No excluded IPs</span>
            )}
          </div>
          <div className="flex gap-2">
            <input
              type="text"
              value={newExclude}
              onChange={(e) => setNewExclude(e.target.value)}
              placeholder="192.168.1.1"
              className="flex-1 bg-bg-tertiary border border-border-default rounded px-3 py-1.5 text-text-primary text-sm"
            />
            <button
              onClick={addExclude}
              className="px-3 py-1.5 bg-bg-tertiary border border-border-default rounded hover:border-text-accent text-text-secondary"
            >
              <Plus size={16} />
            </button>
          </div>
        </div>

        {/* Save Button */}
        <div className="pt-4 border-t border-border-subtle">
          <button
            onClick={saveSettings}
            disabled={saving}
            className="flex items-center gap-2 px-4 py-2 bg-text-accent text-white rounded-lg hover:bg-text-accent/90 disabled:opacity-50"
          >
            {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
            Save Settings
          </button>
        </div>
      </div>

      {/* Network Scan */}
      <div className="bg-bg-secondary border border-border-default rounded-lg p-4">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-text-primary">Network Scan</h3>
          <div className="flex items-center gap-2">
            {scanStatus.status === 'running' && (
              <span className="text-text-muted text-sm">
                {scanStatus.progress}% - {scanStatus.current_ip}
              </span>
            )}
            <button
              onClick={startScan}
              disabled={scanning}
              className="flex items-center gap-2 px-4 py-2 bg-bg-tertiary border border-border-default rounded-lg hover:border-text-accent text-text-secondary disabled:opacity-50"
            >
              {scanning ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <Search size={16} />
              )}
              {scanning ? 'Scanning...' : 'Scan Network'}
            </button>
          </div>
        </div>

        {/* Scan Progress */}
        {scanStatus.status === 'running' && (
          <div className="mb-4">
            <div className="h-2 bg-bg-tertiary rounded-full overflow-hidden">
              <div
                className="h-full bg-text-accent transition-all"
                style={{ width: `${scanStatus.progress}%` }}
              />
            </div>
          </div>
        )}

        {/* Discovered Nodes */}
        <div className="space-y-2">
          <div className="flex items-center justify-between text-text-muted text-sm">
            <span>Discovered Nodes ({discoveredNodes.length})</span>
            {pendingNodes.length > 0 && (
              <button
                onClick={autoJoinAll}
                className="flex items-center gap-1 text-text-accent hover:underline"
              >
                <Plus size={14} />
                Auto-Join All ({pendingNodes.length})
              </button>
            )}
          </div>

          {discoveredNodes.length === 0 ? (
            <div className="text-center py-8 text-text-muted">
              <Network size={32} className="mx-auto mb-2 opacity-50" />
              <p>No nodes discovered yet. Run a network scan.</p>
            </div>
          ) : (
            <div className="grid gap-2">
              {discoveredNodes.map(node => (
                <DiscoveredNodeCard
                  key={node.ip}
                  node={node}
                  onJoin={joinNode}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

const DiscoveredNodeCard = ({ node, onJoin }) => {
  const [joining, setJoining] = useState(false);
  const [selectedCluster, setSelectedCluster] = useState('');

  const handleJoin = async () => {
    setJoining(true);
    await onJoin(node.ip, selectedCluster || null);
    setJoining(false);
  };

  const isJoined = node.swarm_status === 'worker' || node.swarm_status === 'manager';

  return (
    <div className={clsx(
      'flex items-center justify-between p-3 rounded-lg border',
      isJoined
        ? 'bg-status-online/5 border-status-online/20'
        : 'bg-bg-tertiary border-border-default'
    )}>
      <div className="flex items-center gap-3">
        <div className={clsx(
          'p-2 rounded-lg',
          node.os_type === 'jetson' ? 'bg-cluster-spark/20' : 'bg-bg-secondary'
        )}>
          {node.os_type === 'jetson' ? (
            <Cpu size={20} className="text-cluster-spark" />
          ) : (
            <Server size={20} className="text-text-muted" />
          )}
        </div>
        <div>
          <div className="flex items-center gap-2">
            <span className="text-text-primary font-medium">{node.hostname || node.ip}</span>
            {node.os_type === 'jetson' && (
              <span className="text-xs px-1.5 py-0.5 bg-cluster-spark/20 text-cluster-spark rounded">
                {node.jetson_model?.toUpperCase() || 'JETSON'}
              </span>
            )}
          </div>
          <div className="flex items-center gap-3 text-text-muted text-xs">
            <span>{node.ip}</span>
            <span className="flex items-center gap-1">
              {node.ssh_accessible ? (
                <><Wifi size={10} className="text-status-online" /> SSH</>
              ) : (
                <><WifiOff size={10} className="text-status-error" /> No SSH</>
              )}
            </span>
            {node.docker_installed && (
              <span className="text-status-online">Docker</span>
            )}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2">
        {isJoined ? (
          <span className="flex items-center gap-1 text-status-online text-sm">
            <Check size={14} />
            Joined
          </span>
        ) : node.ssh_accessible ? (
          <>
            <select
              value={selectedCluster}
              onChange={(e) => setSelectedCluster(e.target.value)}
              className="bg-bg-secondary border border-border-default rounded px-2 py-1 text-text-primary text-xs"
            >
              <option value="">No cluster</option>
              <option value="vision">Vision</option>
              <option value="media-gen">Media-Gen</option>
              <option value="media-proc">Media-Proc</option>
              <option value="llm">LLM</option>
              <option value="voice">Voice</option>
              <option value="music">Music</option>
            </select>
            <button
              onClick={handleJoin}
              disabled={joining}
              className="flex items-center gap-1 px-3 py-1 bg-text-accent text-white rounded text-sm hover:bg-text-accent/90 disabled:opacity-50"
            >
              {joining ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Plus size={12} />
              )}
              Join
            </button>
          </>
        ) : (
          <span className="text-status-error text-sm">Not accessible</span>
        )}
      </div>
    </div>
  );
};

// Credentials Settings Tab
const CredentialsSettings = () => {
  const [credentials, setCredentials] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [newCred, setNewCred] = useState({ name: '', username: '', password: '' });
  const [showPassword, setShowPassword] = useState({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadCredentials();
  }, []);

  const loadCredentials = async () => {
    try {
      const res = await fetch(`${API_URL}/api/vault`);
      const data = await res.json();
      setCredentials(data);
    } catch (e) {
      console.error('Failed to load credentials:', e);
    }
  };

  const saveCredential = async () => {
    if (!newCred.name || !newCred.username || !newCred.password) return;

    setSaving(true);
    try {
      const res = await fetch(`${API_URL}/api/vault`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newCred)
      });
      if (res.ok) {
        setNewCred({ name: '', username: '', password: '' });
        setShowForm(false);
        loadCredentials();
      }
    } catch (e) {
      console.error('Failed to save credential:', e);
    } finally {
      setSaving(false);
    }
  };

  const deleteCredential = async (id) => {
    try {
      await fetch(`${API_URL}/api/vault/${id}`, { method: 'DELETE' });
      loadCredentials();
    } catch (e) {
      console.error('Failed to delete credential:', e);
    }
  };

  const toggleShowPassword = (id) => {
    setShowPassword(prev => ({ ...prev, [id]: !prev[id] }));
  };

  return (
    <div className="space-y-4">
      {/* Add Credential Button */}
      <div className="flex justify-end">
        <button
          onClick={() => setShowForm(!showForm)}
          className="flex items-center gap-2 px-4 py-2 bg-text-accent text-white rounded-lg hover:bg-text-accent/90"
        >
          <Plus size={16} />
          Add Credential
        </button>
      </div>

      {/* New Credential Form */}
      {showForm && (
        <div className="bg-bg-secondary border border-border-default rounded-lg p-4">
          <h3 className="font-semibold text-text-primary mb-4">New Credential</h3>
          <div className="grid grid-cols-3 gap-4 mb-4">
            <div>
              <label className="block text-text-secondary text-sm mb-1">Name</label>
              <input
                type="text"
                value={newCred.name}
                onChange={(e) => setNewCred(prev => ({ ...prev, name: e.target.value }))}
                placeholder="AGX Default"
                className="w-full bg-bg-tertiary border border-border-default rounded px-3 py-2 text-text-primary"
              />
            </div>
            <div>
              <label className="block text-text-secondary text-sm mb-1">Username</label>
              <input
                type="text"
                value={newCred.username}
                onChange={(e) => setNewCred(prev => ({ ...prev, username: e.target.value }))}
                placeholder="jetson"
                className="w-full bg-bg-tertiary border border-border-default rounded px-3 py-2 text-text-primary"
              />
            </div>
            <div>
              <label className="block text-text-secondary text-sm mb-1">Password</label>
              <input
                type="password"
                value={newCred.password}
                onChange={(e) => setNewCred(prev => ({ ...prev, password: e.target.value }))}
                placeholder="Password"
                className="w-full bg-bg-tertiary border border-border-default rounded px-3 py-2 text-text-primary"
              />
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={saveCredential}
              disabled={saving}
              className="flex items-center gap-2 px-4 py-2 bg-text-accent text-white rounded-lg hover:bg-text-accent/90 disabled:opacity-50"
            >
              {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
              Save
            </button>
            <button
              onClick={() => setShowForm(false)}
              className="px-4 py-2 bg-bg-tertiary text-text-secondary rounded-lg hover:bg-bg-hover"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Credentials List */}
      <div className="bg-bg-secondary border border-border-default rounded-lg overflow-hidden">
        {credentials.length === 0 ? (
          <div className="text-center py-12 text-text-muted">
            <Key size={32} className="mx-auto mb-2 opacity-50" />
            <p>No credentials saved</p>
            <p className="text-sm">Add credentials to enable auto-join functionality</p>
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="bg-bg-tertiary border-b border-border-subtle">
                <th className="text-left px-4 py-3 text-text-muted text-sm font-medium">Name</th>
                <th className="text-left px-4 py-3 text-text-muted text-sm font-medium">Username</th>
                <th className="text-left px-4 py-3 text-text-muted text-sm font-medium">Password</th>
                <th className="text-right px-4 py-3 text-text-muted text-sm font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {credentials.map(cred => (
                <tr key={cred.id} className="border-b border-border-subtle last:border-0">
                  <td className="px-4 py-3 text-text-primary">{cred.name}</td>
                  <td className="px-4 py-3 text-text-secondary font-mono">{cred.username}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className="text-text-secondary font-mono">
                        {showPassword[cred.id] ? cred.password : '••••••••'}
                      </span>
                      <button
                        onClick={() => toggleShowPassword(cred.id)}
                        className="text-text-muted hover:text-text-primary"
                      >
                        {showPassword[cred.id] ? <EyeOff size={14} /> : <Eye size={14} />}
                      </button>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => deleteCredential(cred.id)}
                      className="text-text-muted hover:text-status-error"
                    >
                      <Trash2 size={16} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};

// Toggle Switch Component
const ToggleSwitch = ({ checked, onChange }) => (
  <button
    onClick={() => onChange(!checked)}
    className={clsx(
      'w-12 h-6 rounded-full transition-colors relative',
      checked ? 'bg-text-accent' : 'bg-bg-tertiary border border-border-default'
    )}
  >
    <div className={clsx(
      'absolute top-1 w-4 h-4 rounded-full bg-white transition-transform',
      checked ? 'left-7' : 'left-1'
    )} />
  </button>
);

export default SettingsView;

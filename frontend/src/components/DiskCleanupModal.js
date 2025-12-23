import React, { useState, useEffect } from 'react';
import { X, HardDrive, Trash2, RefreshCw, AlertTriangle, Check, Loader2, FolderOpen, Package, FileText, Archive, Terminal, Bot, Globe } from 'lucide-react';
import clsx from 'clsx';

const API_URL = `http://${window.location.hostname}:8765/api`;

const categoryIcons = {
  docker: Package,
  apt_cache: Archive,
  journal: FileText,
  logs: FileText,
  tmp: FolderOpen,
  pip_cache: Terminal,
};

const categoryLabels = {
  docker: 'Docker (images, containers, cache)',
  apt_cache: 'APT Cache',
  journal: 'System Journal Logs',
  logs: 'Log Files',
  tmp: 'Temporary Files',
  pip_cache: 'Pip Cache',
};

const DiskCleanupModal = ({ isOpen, onClose, nodeId, nodeIp }) => {
  const [analysis, setAnalysis] = useState(null);
  const [loading, setLoading] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [cleaningCategory, setCleaningCategory] = useState(null);
  const [error, setError] = useState(null);
  const [results, setResults] = useState({});
  const [cleanupLog, setCleanupLog] = useState(null);
  const [cleanupStatus, setCleanupStatus] = useState(null);
  const [username, setUsername] = useState(localStorage.getItem('jetson_user') || 'jetson');
  const [password, setPassword] = useState(localStorage.getItem('jetson_pass') || '');
  const [showCredentials, setShowCredentials] = useState(true);
  const [vaultCredentials, setVaultCredentials] = useState([]);
  const [selectedCredId, setSelectedCredId] = useState('');

  // Fetch credentials from vault on mount
  useEffect(() => {
    const fetchVaultCredentials = async () => {
      try {
        const res = await fetch(`${API_URL}/vault/`);
        if (res.ok) {
          const creds = await res.json();
          setVaultCredentials(creds);
          // Auto-select if there's only one credential
          if (creds.length === 1) {
            setSelectedCredId(creds[0].id);
            setUsername(creds[0].username);
            setPassword(creds[0].password);
          }
        }
      } catch (err) {
        console.error('Failed to fetch vault credentials:', err);
      }
    };
    if (isOpen) {
      fetchVaultCredentials();
    }
  }, [isOpen]);

  // Handle credential selection
  const handleCredentialSelect = (credId) => {
    setSelectedCredId(credId);
    const cred = vaultCredentials.find(c => c.id === credId);
    if (cred) {
      setUsername(cred.username);
      setPassword(cred.password);
    }
  };

  const analyze = async () => {
    setLoading(true);
    setError(null);
    try {
      // Add timeout controller - SSH can hang if node unreachable
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 35000); // 35s timeout

      const res = await fetch(`${API_URL}/maintenance/disk/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ node_ip: nodeIp, username, password }),
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.detail || 'Failed to analyze disk - check credentials');
      }
      const data = await res.json();
      setAnalysis(data);
      setShowCredentials(false);
      // Save working credentials
      localStorage.setItem('jetson_user', username);
      localStorage.setItem('jetson_pass', password);
    } catch (err) {
      if (err.name === 'AbortError') {
        setError('Connection timeout - node unreachable or SSH not responding');
      } else {
        setError(err.message);
      }
      setShowCredentials(true);
    } finally {
      setLoading(false);
    }
  };

  const cleanCategory = async (category) => {
    setCleaningCategory(category);
    setCleaning(true);
    try {
      const res = await fetch(`${API_URL}/maintenance/disk/cleanup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          node_ip: nodeIp,
          actions: [category],
          username,
          password
        }),
      });
      if (!res.ok) throw new Error('Cleanup failed');
      const data = await res.json();
      setResults(prev => ({ ...prev, [category]: data }));
      // Re-analyze after cleanup
      setTimeout(() => analyze(), 1000);
    } catch (err) {
      setError(err.message);
    } finally {
      setCleaning(false);
      setCleaningCategory(null);
    }
  };

  // Poll for cleanup task status
  const pollCleanupStatus = async (taskId) => {
    setCleanupStatus('running');
    setCleanupLog('Starting cleanup...\n');

    const poll = async () => {
      try {
        const res = await fetch(`${API_URL}/maintenance/disk/cleanup/${taskId}`);
        if (res.ok) {
          const data = await res.json();
          setCleanupLog(data.log || 'Running...');
          if (data.status === 'completed') {
            setCleanupStatus('completed');
            setCleaning(false);
            // Re-analyze after cleanup
            setTimeout(() => analyze(), 1000);
            return;
          } else if (data.status === 'error') {
            setCleanupStatus('error');
            setCleanupLog(data.log + '\n\nError: ' + (data.error || 'Unknown error'));
            setCleaning(false);
            return;
          }
        }
        // Keep polling
        setTimeout(poll, 2000);
      } catch (err) {
        console.error('Poll error:', err);
        setTimeout(poll, 2000);
      }
    };
    poll();
  };

  const cleanAll = async () => {
    setCleaning(true);
    setCleanupLog(null);
    setCleanupStatus(null);
    try {
      // AGGRESSIVE cleanup - all categories including AI outputs, Ollama, and browsers
      const actions = ['docker', 'apt', 'logs', 'journal', 'tmp', 'pip', 'outputs'];
      // Only include ollama/browsers if they're installed
      if (analysis?.ollama?.installed) actions.push('ollama');
      if (analysis?.browsers?.installed) actions.push('browsers');

      const res = await fetch(`${API_URL}/maintenance/disk/cleanup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          node_ip: nodeIp,
          actions,
          username,
          password
        }),
      });
      if (!res.ok) throw new Error('Cleanup failed');
      const data = await res.json();
      setResults({ all: data });

      // Start polling for results
      if (data.task_id) {
        pollCleanupStatus(data.task_id);
      }
    } catch (err) {
      setError(err.message);
      setCleaning(false);
    }
  };

  useEffect(() => {
    if (isOpen && nodeIp && password) {
      analyze();
    }
  }, [isOpen, nodeIp]);

  if (!isOpen) return null;

  const formatSize = (bytes) => {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const parseSize = (sizeStr) => {
    if (!sizeStr) return 0;
    const match = sizeStr.match(/^([\d.]+)\s*([KMGT]?B?)$/i);
    if (!match) return 0;
    const num = parseFloat(match[1]);
    const unit = match[2].toUpperCase();
    const multipliers = { 'B': 1, 'K': 1024, 'KB': 1024, 'M': 1024*1024, 'MB': 1024*1024, 'G': 1024*1024*1024, 'GB': 1024*1024*1024, 'T': 1024*1024*1024*1024, 'TB': 1024*1024*1024*1024 };
    return num * (multipliers[unit] || 1);
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-bg-secondary border border-border-default rounded-lg w-[600px] max-h-[80vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle bg-bg-tertiary">
          <div className="flex items-center gap-3">
            <HardDrive className="text-text-accent" size={20} />
            <div>
              <h2 className="font-semibold text-text-primary">Disk Cleanup</h2>
              <p className="text-xs text-text-muted">{nodeId} ({nodeIp})</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded hover:bg-bg-hover text-text-muted hover:text-text-primary"
          >
            <X size={18} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-4">
          {showCredentials && !analysis ? (
            <div className="space-y-4">
              <div className="bg-bg-tertiary rounded-lg p-4">
                <h3 className="text-sm font-semibold text-text-primary mb-3">SSH Credentials</h3>
                <p className="text-xs text-text-muted mb-4">Select from vault or enter credentials manually</p>
                <div className="space-y-3">
                  {/* Vault Credential Selector */}
                  {vaultCredentials.length > 0 && (
                    <div>
                      <label className="block text-xs text-text-muted mb-1">Select from Vault</label>
                      <select
                        value={selectedCredId}
                        onChange={(e) => handleCredentialSelect(e.target.value)}
                        className="w-full bg-bg-primary border border-border-subtle rounded px-3 py-2 text-text-primary text-sm focus:outline-none focus:border-text-accent"
                      >
                        <option value="">-- Manual Entry --</option>
                        {vaultCredentials.map((cred) => (
                          <option key={cred.id} value={cred.id}>
                            {cred.name || cred.username} {cred.host ? `(${cred.host})` : ''}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                  {vaultCredentials.length === 0 && (
                    <p className="text-xs text-text-muted italic">No saved credentials in vault. Add credentials on the Discovery page.</p>
                  )}
                  <div>
                    <label className="block text-xs text-text-muted mb-1">Username</label>
                    <input
                      type="text"
                      value={username}
                      onChange={(e) => { setUsername(e.target.value); setSelectedCredId(''); }}
                      className="w-full bg-bg-primary border border-border-subtle rounded px-3 py-2 text-text-primary text-sm focus:outline-none focus:border-text-accent"
                      placeholder="jetson"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-text-muted mb-1">Password</label>
                    <input
                      type="password"
                      value={password}
                      onChange={(e) => { setPassword(e.target.value); setSelectedCredId(''); }}
                      className="w-full bg-bg-primary border border-border-subtle rounded px-3 py-2 text-text-primary text-sm focus:outline-none focus:border-text-accent"
                      placeholder="Enter password"
                    />
                  </div>
                </div>
                {error && (
                  <div className="mt-3 p-2 bg-status-error/10 border border-status-error/20 rounded text-status-error text-xs">
                    {error}
                  </div>
                )}
                <button
                  onClick={analyze}
                  disabled={!username || !password || loading}
                  className="mt-4 w-full flex items-center justify-center gap-2 px-4 py-2 bg-text-accent text-white rounded hover:bg-text-accent/80 disabled:opacity-50"
                >
                  {loading ? <Loader2 size={16} className="animate-spin" /> : <HardDrive size={16} />}
                  {loading ? 'Connecting...' : 'Analyze Disk'}
                </button>
              </div>
            </div>
          ) : loading ? (
            <div className="flex flex-col items-center justify-center py-12">
              <Loader2 className="animate-spin text-text-accent mb-3" size={32} />
              <p className="text-text-secondary">Analyzing disk usage...</p>
            </div>
          ) : error && !showCredentials ? (
            <div className="flex flex-col items-center justify-center py-12">
              <AlertTriangle className="text-status-error mb-3" size={32} />
              <p className="text-status-error">{error}</p>
              <button
                onClick={() => setShowCredentials(true)}
                className="mt-4 px-4 py-2 bg-text-accent text-white rounded hover:bg-text-accent/80"
              >
                Update Credentials
              </button>
            </div>
          ) : analysis ? (
            <div className="space-y-4">
              {/* Disk Overview */}
              <div className="bg-bg-tertiary rounded-lg p-4">
                <h3 className="text-sm font-semibold text-text-primary mb-3">Disk Overview</h3>
                <div className="grid grid-cols-3 gap-4">
                  <div>
                    <p className="text-xs text-text-muted">Total</p>
                    <p className="text-lg font-mono text-text-primary">{analysis.disk?.total || 'N/A'}</p>
                  </div>
                  <div>
                    <p className="text-xs text-text-muted">Used</p>
                    <p className="text-lg font-mono text-text-primary">{analysis.disk?.used || 'N/A'}</p>
                  </div>
                  <div>
                    <p className="text-xs text-text-muted">Free</p>
                    <p className="text-lg font-mono text-status-online">{analysis.disk?.free || 'N/A'}</p>
                  </div>
                </div>
                {/* Progress bar */}
                <div className="mt-3">
                  <div className="h-2 bg-bg-primary rounded-full overflow-hidden">
                    <div
                      className={clsx(
                        'h-full rounded-full transition-all',
                        (analysis.disk?.percent || 0) > 80 ? 'bg-status-error' :
                        (analysis.disk?.percent || 0) > 60 ? 'bg-status-warning' : 'bg-status-online'
                      )}
                      style={{ width: `${analysis.disk?.percent || 0}%` }}
                    />
                  </div>
                  <p className="text-xs text-text-muted mt-1 text-right">{parseFloat(analysis.disk?.percent || 0).toFixed(1)}% used</p>
                </div>
              </div>

              {/* Cleanup Categories */}
              <div>
                <h3 className="text-sm font-semibold text-text-primary mb-3">Cleanable Items</h3>
                <div className="space-y-2">
                  {/* Docker */}
                  <CleanupItem
                    icon={Package}
                    label="Docker"
                    details={[
                      `${analysis.docker?.images_count || 0} images`,
                      `${analysis.docker?.containers_count || 0} containers`,
                      `${analysis.docker?.volumes_count || 0} volumes`,
                    ]}
                    size={analysis.docker?.build_cache || 'N/A'}
                    onClean={() => cleanCategory('docker')}
                    cleaning={cleaningCategory === 'docker'}
                    done={results.docker}
                  />

                  {/* Journal */}
                  <CleanupItem
                    icon={FileText}
                    label="System Journal"
                    details={[`Logs older than 3 days`]}
                    size={analysis.journal?.size || 'N/A'}
                    onClean={() => cleanCategory('journal')}
                    cleaning={cleaningCategory === 'journal'}
                    done={results.journal}
                  />

                  {/* APT Cache */}
                  <CleanupItem
                    icon={Archive}
                    label="APT Cache"
                    details={['Downloaded package files']}
                    size={analysis.apt_cache?.size || 'N/A'}
                    onClean={() => cleanCategory('apt')}
                    cleaning={cleaningCategory === 'apt'}
                    done={results.apt}
                  />

                  {/* Logs */}
                  <CleanupItem
                    icon={FileText}
                    label="Log Files"
                    details={['/var/log files']}
                    size={analysis.logs?.size || 'N/A'}
                    onClean={() => cleanCategory('logs')}
                    cleaning={cleaningCategory === 'logs'}
                    done={results.logs}
                  />

                  {/* Tmp */}
                  <CleanupItem
                    icon={FolderOpen}
                    label="Temporary Files"
                    details={['/tmp and /var/tmp']}
                    size={analysis.tmp?.size || 'N/A'}
                    onClean={() => cleanCategory('tmp')}
                    cleaning={cleaningCategory === 'tmp'}
                    done={results.tmp}
                  />

                  {/* Pip Cache */}
                  <CleanupItem
                    icon={Terminal}
                    label="Pip Cache"
                    details={['Python package cache']}
                    size={analysis.pip_cache?.size || 'N/A'}
                    onClean={() => cleanCategory('pip')}
                    cleaning={cleaningCategory === 'pip'}
                    done={results.pip}
                  />

                  {/* Ollama - Big space consumer! */}
                  {analysis.ollama?.installed && (
                    <CleanupItem
                      icon={Bot}
                      label="Ollama Models"
                      details={['LLM models (1-8GB each!)']}
                      size={analysis.ollama?.size || 'N/A'}
                      onClean={() => cleanCategory('ollama')}
                      cleaning={cleaningCategory === 'ollama'}
                      done={results.ollama}
                      warning={true}
                    />
                  )}

                  {/* Browsers */}
                  {analysis.browsers?.installed && (
                    <CleanupItem
                      icon={Globe}
                      label="Browsers"
                      details={analysis.browsers?.details || ['Chromium, Firefox, Thunderbird']}
                      size={analysis.browsers?.size || 'N/A'}
                      onClean={() => cleanCategory('browsers')}
                      cleaning={cleaningCategory === 'browsers'}
                      done={results.browsers}
                      warning={true}
                    />
                  )}
                </div>
              </div>

              {/* Large Directories */}
              {analysis.large_dirs && analysis.large_dirs.length > 0 && (
                <div>
                  <h3 className="text-sm font-semibold text-text-primary mb-3">Largest Directories</h3>
                  <div className="bg-bg-tertiary rounded-lg overflow-hidden">
                    {analysis.large_dirs.map((dir, i) => (
                      <div
                        key={i}
                        className={clsx(
                          'flex items-center justify-between px-3 py-2 text-sm',
                          i > 0 && 'border-t border-border-subtle'
                        )}
                      >
                        <span className="font-mono text-text-secondary truncate flex-1">{dir.path}</span>
                        <span className="font-mono text-text-primary ml-4">{dir.size}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Cleanup Log Output */}
              {cleanupLog && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="text-sm font-semibold text-text-primary">Cleanup Output</h3>
                    <span className={clsx(
                      "text-xs px-2 py-0.5 rounded",
                      cleanupStatus === 'completed' ? "bg-status-online/20 text-status-online" :
                      cleanupStatus === 'error' ? "bg-status-error/20 text-status-error" :
                      "bg-text-accent/20 text-text-accent"
                    )}>
                      {cleanupStatus === 'completed' ? 'Completed' :
                       cleanupStatus === 'error' ? 'Error' : 'Running...'}
                    </span>
                  </div>
                  <div className="bg-bg-primary border border-border-subtle rounded-lg p-3 max-h-48 overflow-auto">
                    <pre className="text-xs text-text-secondary font-mono whitespace-pre-wrap">
                      {cleanupLog}
                    </pre>
                  </div>
                  {cleanupStatus === 'completed' && (
                    <button
                      onClick={() => { setCleanupLog(null); setCleanupStatus(null); }}
                      className="mt-2 text-xs text-text-muted hover:text-text-primary"
                    >
                      Clear log
                    </button>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-12">
              <HardDrive className="text-text-muted mb-3" size={32} />
              <p className="text-text-secondary">Click analyze to check disk usage</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-border-subtle bg-bg-tertiary">
          <button
            onClick={analyze}
            disabled={loading}
            className="flex items-center gap-2 px-3 py-1.5 text-sm text-text-secondary hover:text-text-primary disabled:opacity-50"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-4 py-1.5 text-sm text-text-secondary hover:text-text-primary"
            >
              Close
            </button>
            <button
              onClick={cleanAll}
              disabled={cleaning || !analysis}
              className="flex items-center gap-2 px-4 py-1.5 bg-status-error text-white rounded text-sm hover:bg-status-error/80 disabled:opacity-50"
            >
              {cleaning ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Trash2 size={14} />
              )}
              Clean All
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

const CleanupItem = ({ icon: Icon, label, details, size, onClean, cleaning, done, warning }) => {
  return (
    <div className={clsx(
      "flex items-center justify-between rounded-lg p-3",
      warning ? "bg-status-warning/10 border border-status-warning/20" : "bg-bg-tertiary"
    )}>
      <div className="flex items-center gap-3">
        <div className={clsx(
          "p-2 rounded",
          warning ? "bg-status-warning/20" : "bg-bg-secondary"
        )}>
          <Icon size={16} className={warning ? "text-status-warning" : "text-text-muted"} />
        </div>
        <div>
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium text-text-primary">{label}</p>
            {warning && (
              <span className="text-xs px-1.5 py-0.5 bg-status-warning/20 text-status-warning rounded">
                Large
              </span>
            )}
          </div>
          <p className="text-xs text-text-muted">{Array.isArray(details) ? details.join(' | ') : details}</p>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <span className={clsx(
          "font-mono text-sm",
          warning ? "text-status-warning font-semibold" : "text-text-secondary"
        )}>{size}</span>
        {done ? (
          <div className="p-1.5 rounded bg-status-online/20">
            <Check size={14} className="text-status-online" />
          </div>
        ) : (
          <button
            onClick={onClean}
            disabled={cleaning}
            className={clsx(
              "p-1.5 rounded disabled:opacity-50 transition-colors",
              warning
                ? "bg-status-warning/20 hover:bg-status-error/20 text-status-warning hover:text-status-error"
                : "bg-bg-secondary hover:bg-status-error/20 text-text-muted hover:text-status-error"
            )}
          >
            {cleaning ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Trash2 size={14} />
            )}
          </button>
        )}
      </div>
    </div>
  );
};

export default DiskCleanupModal;

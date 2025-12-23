import React, { useState, useEffect, useRef } from 'react';
import { fetchNetworkScan, fetchCredentials, saveCredential, installNode, getInstallStatus } from '../api';
import { Search, Monitor, Wifi, AlertCircle, Key, Download, Terminal, Loader2 } from 'lucide-react';

const NetworkView = () => {
  const [subnet, setSubnet] = useState('192.168.1.0/24');
  const [hosts, setHosts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  
  // Vault & Install State
  const [showVault, setShowVault] = useState(false);
  const [credentials, setCredentials] = useState([]);
  const [newCred, setNewCred] = useState({ name: '', username: '', password: '' });
  const [installTarget, setInstallTarget] = useState(null);
  const [selectedCred, setSelectedCred] = useState('');
  const [installStatus, setInstallStatus] = useState(null);
  const pollInterval = useRef(null);

  const loadLastScan = async () => {
    setLoading(true);
    try {
      const result = await fetchNetworkScan(subnet, false);
      if (result.hosts) {
        setHosts(result.hosts);
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

  return (
    <div className="p-6 bg-gray-900 min-h-full text-white">
      <div className="flex justify-between items-start mb-8">
        <div>
          <h2 className="text-2xl font-bold mb-2 flex items-center gap-2">
            <Wifi className="text-blue-400" /> Network Discovery
          </h2>
          <p className="text-gray-400 text-sm">Scan for devices and install Fleet Agent</p>
        </div>
        <button 
          onClick={() => setShowVault(!showVault)}
          className="px-4 py-2 bg-gray-800 hover:bg-gray-700 rounded border border-gray-700 flex items-center gap-2"
        >
          <Key size={16} /> Credential Vault
        </button>
      </div>

      {/* Vault Modal/Panel */}
      {showVault && (
        <div className="mb-8 bg-gray-800 p-4 rounded-lg border border-gray-700">
          <h3 className="font-bold mb-4 flex items-center gap-2"><Key size={18} /> Saved Credentials</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
            {credentials.map(c => (
              <div key={c.id} className="p-3 bg-gray-900 rounded border border-gray-700 flex justify-between">
                <div>
                  <div className="font-bold text-sm">{c.name}</div>
                  <div className="text-xs text-gray-400">{c.username}</div>
                </div>
              </div>
            ))}
          </div>
          <div className="flex gap-2 items-end">
            <div className="flex-1">
              <label className="text-xs text-gray-400">Name</label>
              <input className="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1" 
                value={newCred.name} onChange={e => setNewCred({...newCred, name: e.target.value})} />
            </div>
            <div className="flex-1">
              <label className="text-xs text-gray-400">Username</label>
              <input className="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1" 
                value={newCred.username} onChange={e => setNewCred({...newCred, username: e.target.value})} />
            </div>
            <div className="flex-1">
              <label className="text-xs text-gray-400">Password</label>
              <input type="password" className="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1" 
                value={newCred.password} onChange={e => setNewCred({...newCred, password: e.target.value})} />
            </div>
            <button onClick={handleSaveCred} className="px-4 py-1 bg-blue-600 rounded h-[34px]">Save</button>
          </div>
        </div>
      )}

      {/* Scan Controls */}
      <div className="flex gap-4 items-center bg-gray-800 p-4 rounded-lg border border-gray-700 mb-6">
        <div className="flex-1">
          <label className="block text-xs text-gray-400 mb-1">Target Subnet</label>
          <input 
            type="text" 
            value={subnet}
            onChange={(e) => setSubnet(e.target.value)}
            className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white focus:border-blue-500 outline-none"
            placeholder="192.168.1.0/24"
          />
        </div>
        <button 
          onClick={handleScan}
          disabled={loading}
          className={`px-6 py-2 rounded font-medium flex items-center gap-2 ${loading ? 'bg-gray-600 cursor-not-allowed' : 'bg-blue-600 hover:bg-blue-500'}`}
        >
          {loading ? <><Loader2 size={18} className="animate-spin" /> Scanning...</> : <><Search size={18} /> Scan Network</>}
        </button>
      </div>

      {error && (
        <div className="bg-red-900/50 border border-red-700 text-red-200 p-4 rounded-lg mb-6 flex items-center gap-2">
          <AlertCircle size={20} /> {error}
        </div>
      )}

      {!loading && hosts.length > 0 && (
        <div className="mb-4 text-sm text-gray-400">
          Found {hosts.length} devices on the network.
        </div>
      )}

      {/* Hosts Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {hosts.map((host, idx) => (
          <div key={idx} className="bg-gray-800 border border-gray-700 rounded-lg p-4 hover:border-blue-500 transition-colors">
            <div className="flex items-start justify-between mb-2">
              <div className="p-2 bg-gray-700 rounded-full">
                <Monitor size={24} className="text-green-400" />
              </div>
              <span className="px-2 py-1 bg-green-900/30 text-green-400 text-xs rounded border border-green-900/50">
                ONLINE
              </span>
            </div>
            <div className="font-mono text-lg font-bold">{host.ip}</div>
            <div className="text-gray-400 text-sm truncate">{host.name || 'Unknown Host'}</div>
            
            <div className="mt-4 pt-4 border-t border-gray-700 flex gap-2">
              <button 
                onClick={() => setInstallTarget(host)}
                className="flex-1 py-2 text-xs bg-blue-600 hover:bg-blue-500 rounded flex items-center justify-center gap-1"
              >
                <Download size={14} /> Install Agent
              </button>
              <button className="flex-1 py-2 text-xs bg-gray-700 hover:bg-gray-600 rounded flex items-center justify-center gap-1">
                <Terminal size={14} /> SSH
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Install Modal */}
      {installTarget && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
          <div className="bg-gray-800 p-6 rounded-lg w-full max-w-lg border border-gray-700 max-h-[90vh] flex flex-col">
            <h3 className="text-xl font-bold mb-4 flex-shrink-0">Install Agent on {installTarget.ip}</h3>
            
            {!installStatus ? (
              <>
                <div className="mb-4">
                  <label className="block text-sm text-gray-400 mb-2">Select Credential</label>
                  <select 
                    className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2"
                    value={selectedCred}
                    onChange={e => setSelectedCred(e.target.value)}
                  >
                    <option value="">-- Select --</option>
                    {credentials.map(c => (
                      <option key={c.id} value={c.id}>{c.name} ({c.username})</option>
                    ))}
                  </select>
                  <p className="text-xs text-gray-500 mt-2">
                    Agent will connect back to: <span className="text-blue-400">{window.location.hostname}</span>
                  </p>
                </div>
                <div className="flex justify-end gap-3">
                  <button onClick={() => setInstallTarget(null)} className="px-4 py-2 text-gray-400 hover:text-white">Cancel</button>
                  <button 
                    onClick={handleInstall}
                    disabled={!selectedCred}
                    className="px-6 py-2 bg-blue-600 hover:bg-blue-500 rounded disabled:opacity-50"
                  >
                    Start Installation
                  </button>
                </div>
              </>
            ) : (
              <div className="flex flex-col h-full">
                <div className={`flex items-center gap-3 mb-4 p-3 rounded ${
                  installStatus.status === 'running' ? 'bg-blue-900/30 border border-blue-800' :
                  installStatus.status === 'success' ? 'bg-green-900/30 border border-green-800' :
                  'bg-red-900/30 border border-red-800'
                }`}>
                  {installStatus.status === 'running' && <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-blue-400"></div>}
                  {installStatus.status === 'success' && <div className="text-green-400 font-bold">✓ Installation Complete</div>}
                  {installStatus.status === 'error' && <div className="text-red-400 font-bold">✗ Installation Failed</div>}
                  
                  <div className="flex-1 text-sm">
                    {installStatus.status === 'running' ? 'Installing Agent...' : 
                     installStatus.status === 'success' ? 'Agent installed successfully. It should appear in the dashboard shortly.' :
                     'An error occurred during installation.'}
                  </div>
                </div>

                <div className="flex-1 bg-black p-4 rounded font-mono text-xs overflow-auto whitespace-pre-wrap border border-gray-800">
                  {installStatus.log}
                </div>
                
                {installStatus.status !== 'running' && (
                  <div className="mt-4 pt-2 flex justify-end">
                    <button onClick={() => { setInstallTarget(null); setInstallStatus(null); }} className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded text-white text-sm">
                      Close
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default NetworkView;

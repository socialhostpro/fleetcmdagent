import React, { useEffect, useState } from 'react';
import { useAgentStore } from '../stores';
import { useFleetWebSocket } from '../hooks/useFleetWebSocket';
import {
  Server, Cpu, Thermometer, HardDrive, RefreshCw,
  Terminal, Play, Square, RotateCcw, Wifi, WifiOff
} from 'lucide-react';

/**
 * Agents View - Manage fleet agents
 */
function AgentsView() {
  const { connected } = useFleetWebSocket();
  const { agents, loading, fetchAgents, sendCommand } = useAgentStore();
  const [selectedAgent, setSelectedAgent] = useState(null);
  const [commandOutput, setCommandOutput] = useState('');
  const [commandInput, setCommandInput] = useState('');
  const [commandLoading, setCommandLoading] = useState(false);

  useEffect(() => {
    fetchAgents();
    const interval = setInterval(fetchAgents, 10000);
    return () => clearInterval(interval);
  }, [fetchAgents]);

  const handleCommand = async (nodeId, command) => {
    setCommandLoading(true);
    setCommandOutput('Running command...');
    try {
      const result = await sendCommand(nodeId, { type: 'shell', command });
      setCommandOutput(result.output || result.error || 'No output');
    } catch (error) {
      setCommandOutput(`Error: ${error.message}`);
    }
    setCommandLoading(false);
  };

  const handleCustomCommand = async () => {
    if (!selectedAgent || !commandInput.trim()) return;
    await handleCommand(selectedAgent.node_id, commandInput);
  };

  const onlineAgents = agents.filter(a => a.status === 'online');
  const offlineAgents = agents.filter(a => a.status === 'offline');

  // Group by cluster
  const clusters = {};
  agents.forEach(agent => {
    const cluster = agent.cluster || 'default';
    if (!clusters[cluster]) clusters[cluster] = [];
    clusters[cluster].push(agent);
  });

  return (
    <div className="min-h-screen bg-gray-900 text-white p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Fleet Agents</h1>
          <p className="text-gray-400 text-sm">
            {onlineAgents.length} online, {offlineAgents.length} offline
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-sm ${
            connected ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'
          }`}>
            {connected ? <Wifi className="w-4 h-4" /> : <WifiOff className="w-4 h-4" />}
            {connected ? 'Live' : 'Offline'}
          </div>
          <button
            onClick={() => fetchAgents()}
            disabled={loading}
            className="flex items-center gap-2 px-4 py-2 bg-gray-800 hover:bg-gray-700 rounded-lg transition-colors"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Agent List */}
        <div className="lg:col-span-2 space-y-6">
          {Object.entries(clusters).map(([clusterName, clusterAgents]) => (
            <div key={clusterName} className="bg-gray-800 rounded-lg overflow-hidden">
              <div className="px-4 py-3 border-b border-gray-700 flex items-center justify-between">
                <h2 className="font-semibold capitalize">{clusterName} Cluster</h2>
                <span className="text-sm text-gray-400">
                  {clusterAgents.filter(a => a.status === 'online').length}/{clusterAgents.length} online
                </span>
              </div>
              <div className="divide-y divide-gray-700">
                {clusterAgents.map(agent => (
                  <div
                    key={agent.node_id}
                    className={`p-4 cursor-pointer transition-colors ${
                      selectedAgent?.node_id === agent.node_id
                        ? 'bg-gray-700'
                        : 'hover:bg-gray-700/50'
                    }`}
                    onClick={() => setSelectedAgent(agent)}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <Server className={`w-5 h-5 ${
                          agent.status === 'online' ? 'text-green-400' : 'text-red-400'
                        }`} />
                        <div>
                          <div className="font-medium">{agent.node_id}</div>
                          <div className="text-sm text-gray-400">
                            {agent.ip_address || '-'} | {agent.gpu_count || 0} GPUs
                          </div>
                        </div>
                      </div>
                      <span className={`px-2 py-1 rounded text-xs ${
                        agent.status === 'online'
                          ? 'bg-green-500/20 text-green-400'
                          : 'bg-red-500/20 text-red-400'
                      }`}>
                        {agent.status}
                      </span>
                    </div>

                    {/* Quick metrics for online agents */}
                    {agent.status === 'online' && agent.gpus?.length > 0 && (
                      <div className="mt-3 grid grid-cols-4 gap-4 text-sm">
                        <div className="flex items-center gap-2">
                          <Cpu className="w-4 h-4 text-blue-400" />
                          <span className="text-gray-400">CPU:</span>
                          <span>{agent.system?.cpu_percent?.toFixed(0) || 0}%</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <Thermometer className="w-4 h-4 text-orange-400" />
                          <span className="text-gray-400">GPU:</span>
                          <span>{agent.gpus[0]?.utilization || 0}%</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <Thermometer className="w-4 h-4 text-red-400" />
                          <span className="text-gray-400">Temp:</span>
                          <span>{agent.gpus[0]?.temperature || 0}°C</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <HardDrive className="w-4 h-4 text-purple-400" />
                          <span className="text-gray-400">Disk:</span>
                          <span>{agent.system?.disk_percent?.toFixed(0) || 0}%</span>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Agent Details / Command Panel */}
        <div className="space-y-4">
          {selectedAgent ? (
            <>
              {/* Agent Info */}
              <div className="bg-gray-800 rounded-lg p-4">
                <h3 className="font-semibold mb-3">{selectedAgent.node_id}</h3>
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-gray-400">Status</span>
                    <span className={selectedAgent.status === 'online' ? 'text-green-400' : 'text-red-400'}>
                      {selectedAgent.status}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">Cluster</span>
                    <span>{selectedAgent.cluster}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">IP</span>
                    <span>{selectedAgent.ip_address || '-'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">GPUs</span>
                    <span>{selectedAgent.gpu_count || 0}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">Version</span>
                    <span>{selectedAgent.agent_version || '1.0.0'}</span>
                  </div>
                </div>
              </div>

              {/* Quick Actions */}
              <div className="bg-gray-800 rounded-lg p-4">
                <h3 className="font-semibold mb-3">Quick Actions</h3>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => handleCommand(selectedAgent.node_id, 'nvidia-smi')}
                    disabled={selectedAgent.status !== 'online' || commandLoading}
                    className="flex items-center justify-center gap-2 p-2 bg-gray-700 hover:bg-gray-600 rounded transition-colors disabled:opacity-50"
                  >
                    <Cpu className="w-4 h-4" />
                    <span className="text-sm">GPU Info</span>
                  </button>
                  <button
                    onClick={() => handleCommand(selectedAgent.node_id, 'docker ps')}
                    disabled={selectedAgent.status !== 'online' || commandLoading}
                    className="flex items-center justify-center gap-2 p-2 bg-gray-700 hover:bg-gray-600 rounded transition-colors disabled:opacity-50"
                  >
                    <Play className="w-4 h-4" />
                    <span className="text-sm">Containers</span>
                  </button>
                  <button
                    onClick={() => handleCommand(selectedAgent.node_id, 'df -h')}
                    disabled={selectedAgent.status !== 'online' || commandLoading}
                    className="flex items-center justify-center gap-2 p-2 bg-gray-700 hover:bg-gray-600 rounded transition-colors disabled:opacity-50"
                  >
                    <HardDrive className="w-4 h-4" />
                    <span className="text-sm">Disk Usage</span>
                  </button>
                  <button
                    onClick={() => handleCommand(selectedAgent.node_id, 'uptime')}
                    disabled={selectedAgent.status !== 'online' || commandLoading}
                    className="flex items-center justify-center gap-2 p-2 bg-gray-700 hover:bg-gray-600 rounded transition-colors disabled:opacity-50"
                  >
                    <RotateCcw className="w-4 h-4" />
                    <span className="text-sm">Uptime</span>
                  </button>
                </div>
              </div>

              {/* Custom Command */}
              <div className="bg-gray-800 rounded-lg p-4">
                <h3 className="font-semibold mb-3 flex items-center gap-2">
                  <Terminal className="w-4 h-4" />
                  Run Command
                </h3>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={commandInput}
                    onChange={(e) => setCommandInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleCustomCommand()}
                    placeholder="Enter command..."
                    disabled={selectedAgent.status !== 'online'}
                    className="flex-1 bg-gray-700 border border-gray-600 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500 disabled:opacity-50"
                  />
                  <button
                    onClick={handleCustomCommand}
                    disabled={selectedAgent.status !== 'online' || commandLoading || !commandInput.trim()}
                    className="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded transition-colors disabled:opacity-50"
                  >
                    Run
                  </button>
                </div>
              </div>

              {/* Command Output */}
              {commandOutput && (
                <div className="bg-gray-800 rounded-lg p-4">
                  <h3 className="font-semibold mb-3">Output</h3>
                  <pre className="bg-gray-900 rounded p-3 text-sm text-gray-300 overflow-x-auto max-h-64 overflow-y-auto">
                    {commandOutput}
                  </pre>
                </div>
              )}
            </>
          ) : (
            <div className="bg-gray-800 rounded-lg p-8 text-center text-gray-400">
              <Server className="w-12 h-12 mx-auto mb-4 opacity-50" />
              <p>Select an agent to view details</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default AgentsView;

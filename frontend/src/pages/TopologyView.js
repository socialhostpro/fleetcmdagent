import React, { useEffect, useState } from 'react';
import { useAgentStore } from '../stores';
import { useFleetWebSocket } from '../hooks/useFleetWebSocket';
import { NodeTopologyMap } from '../components/topology';
import { RefreshCw, Wifi, WifiOff, ZoomIn, ZoomOut, Maximize } from 'lucide-react';

/**
 * Topology View - Full-screen node topology map
 */
function TopologyView() {
  const { connected } = useFleetWebSocket();
  const fetchAgents = useAgentStore(state => state.fetchAgents);
  const agents = useAgentStore(state => state.agents);
  const [selectedAgent, setSelectedAgent] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetchAgents();
  }, [fetchAgents]);

  const handleRefresh = async () => {
    setLoading(true);
    await fetchAgents();
    setLoading(false);
  };

  const handleNodeClick = (agent) => {
    setSelectedAgent(agent);
  };

  const onlineCount = agents.filter(a => a.status === 'online').length;
  const totalCount = agents.length;

  return (
    <div className="min-h-screen bg-gray-900 text-white flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-gray-800">
        <div>
          <h1 className="text-xl font-bold">Node Topology</h1>
          <p className="text-gray-400 text-sm">
            {onlineCount}/{totalCount} nodes online
          </p>
        </div>
        <div className="flex items-center gap-3">
          {/* Connection status */}
          <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-sm ${
            connected ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'
          }`}>
            {connected ? <Wifi className="w-4 h-4" /> : <WifiOff className="w-4 h-4" />}
            {connected ? 'Live' : 'Offline'}
          </div>

          {/* Refresh */}
          <button
            onClick={handleRefresh}
            disabled={loading}
            className="p-2 bg-gray-800 hover:bg-gray-700 rounded-lg transition-colors"
          >
            <RefreshCw className={`w-5 h-5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Topology Map */}
      <div className="flex-1">
        <NodeTopologyMap onNodeClick={handleNodeClick} />
      </div>

      {/* Agent Details Drawer */}
      {selectedAgent && (
        <div className="fixed right-0 top-0 h-full w-96 bg-gray-800 border-l border-gray-700 shadow-xl z-50 overflow-y-auto">
          <div className="p-4 border-b border-gray-700 flex items-center justify-between">
            <h2 className="text-lg font-semibold">{selectedAgent.node_id}</h2>
            <button
              onClick={() => setSelectedAgent(null)}
              className="p-2 hover:bg-gray-700 rounded-lg transition-colors"
            >
              &times;
            </button>
          </div>

          <div className="p-4 space-y-4">
            {/* Status */}
            <div className="flex items-center gap-2">
              <span className={`px-3 py-1 rounded-full text-sm ${
                selectedAgent.status === 'online'
                  ? 'bg-green-500/20 text-green-400'
                  : 'bg-red-500/20 text-red-400'
              }`}>
                {selectedAgent.status}
              </span>
              <span className="px-3 py-1 bg-gray-700 rounded-full text-sm text-gray-300">
                {selectedAgent.cluster}
              </span>
            </div>

            {/* System Info */}
            <div className="bg-gray-700/50 rounded-lg p-4">
              <h3 className="text-sm font-medium text-gray-400 mb-2">System</h3>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-400">Hostname</span>
                  <span>{selectedAgent.hostname || selectedAgent.node_id}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">IP Address</span>
                  <span>{selectedAgent.ip_address || '-'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">CPU</span>
                  <span>{selectedAgent.system?.cpu_percent?.toFixed(1) || 0}%</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Memory</span>
                  <span>{selectedAgent.system?.memory_percent?.toFixed(1) || 0}%</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Disk</span>
                  <span>{selectedAgent.system?.disk_percent?.toFixed(1) || 0}%</span>
                </div>
              </div>
            </div>

            {/* GPUs */}
            {selectedAgent.gpus?.length > 0 && (
              <div className="bg-gray-700/50 rounded-lg p-4">
                <h3 className="text-sm font-medium text-gray-400 mb-2">GPUs ({selectedAgent.gpus.length})</h3>
                <div className="space-y-3">
                  {selectedAgent.gpus.map((gpu, i) => (
                    <div key={i} className="text-sm">
                      <div className="font-medium truncate">{gpu.name}</div>
                      <div className="grid grid-cols-2 gap-2 mt-1 text-gray-400">
                        <span>Util: {gpu.utilization}%</span>
                        <span>Temp: {gpu.temperature}°C</span>
                        <span>Mem: {gpu.memory_used}MB</span>
                        <span>Power: {gpu.power_draw?.toFixed(0) || 0}W</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Containers */}
            {selectedAgent.containers?.length > 0 && (
              <div className="bg-gray-700/50 rounded-lg p-4">
                <h3 className="text-sm font-medium text-gray-400 mb-2">
                  Containers ({selectedAgent.containers.length})
                </h3>
                <div className="space-y-2">
                  {selectedAgent.containers.slice(0, 5).map((container, i) => (
                    <div key={i} className="flex items-center justify-between text-sm">
                      <span className="truncate">{container.name}</span>
                      <span className={`px-2 py-0.5 rounded text-xs ${
                        container.state === 'running'
                          ? 'bg-green-500/20 text-green-400'
                          : 'bg-gray-600 text-gray-400'
                      }`}>
                        {container.state}
                      </span>
                    </div>
                  ))}
                  {selectedAgent.containers.length > 5 && (
                    <span className="text-xs text-gray-500">
                      + {selectedAgent.containers.length - 5} more
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default TopologyView;

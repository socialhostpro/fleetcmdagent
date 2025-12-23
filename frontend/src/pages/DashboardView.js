import React, { useEffect, useState } from 'react';
import { useAgentStore, useJobStore, useAlertStore } from '../stores';
import { useFleetWebSocket } from '../hooks/useFleetWebSocket';
import { ClusterOverview, AlertsBanner } from '../components/dashboard';
import { NodeTopologyMap } from '../components/topology';
import { JobTimeline, JobQueue } from '../components/jobs';
import { RefreshCw, Maximize2, Minimize2, Wifi, WifiOff } from 'lucide-react';

/**
 * Dashboard View - Main overview of the fleet
 */
function DashboardView() {
  const { connected } = useFleetWebSocket();
  const fetchAgents = useAgentStore(state => state.fetchAgents);
  const fetchJobs = useJobStore(state => state.fetchJobs);
  const fetchActiveAlerts = useAlertStore(state => state.fetchActiveAlerts);

  const [topologyExpanded, setTopologyExpanded] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState(null);
  const [selectedJob, setSelectedJob] = useState(null);
  const [loading, setLoading] = useState(false);

  // Initial data fetch
  useEffect(() => {
    const loadData = async () => {
      setLoading(true);
      await Promise.all([
        fetchAgents(),
        fetchJobs(),
        fetchActiveAlerts(),
      ]);
      setLoading(false);
    };
    loadData();
  }, [fetchAgents, fetchJobs, fetchActiveAlerts]);

  const handleRefresh = async () => {
    setLoading(true);
    await Promise.all([
      fetchAgents(),
      fetchJobs(),
      fetchActiveAlerts(),
    ]);
    setLoading(false);
  };

  const handleNodeClick = (agent) => {
    setSelectedAgent(agent);
    // Could open a modal or navigate to agent details
    console.log('Selected agent:', agent);
  };

  const handleJobClick = (job) => {
    setSelectedJob(job);
    // Could open a modal or navigate to job details
    console.log('Selected job:', job);
  };

  return (
    <div className="min-h-screen bg-gray-900 text-white p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Fleet Commander</h1>
          <p className="text-gray-400 text-sm">Real-time cluster monitoring and management</p>
        </div>
        <div className="flex items-center gap-4">
          {/* Connection status */}
          <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full ${
            connected ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'
          }`}>
            {connected ? <Wifi className="w-4 h-4" /> : <WifiOff className="w-4 h-4" />}
            <span className="text-sm">{connected ? 'Connected' : 'Disconnected'}</span>
          </div>

          {/* Refresh button */}
          <button
            onClick={handleRefresh}
            disabled={loading}
            className="flex items-center gap-2 px-4 py-2 bg-gray-800 hover:bg-gray-700 rounded-lg transition-colors"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            <span>Refresh</span>
          </button>
        </div>
      </div>

      {/* Alerts Banner */}
      <AlertsBanner />

      {/* Stats Overview */}
      <ClusterOverview />

      {/* Main Content Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mt-6">
        {/* Topology Map */}
        <div className={`bg-gray-800 rounded-lg overflow-hidden ${topologyExpanded ? 'lg:col-span-2' : ''}`}>
          <div className="flex items-center justify-between p-4 border-b border-gray-700">
            <h2 className="text-lg font-semibold">Node Topology</h2>
            <button
              onClick={() => setTopologyExpanded(!topologyExpanded)}
              className="p-2 hover:bg-gray-700 rounded transition-colors"
            >
              {topologyExpanded ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
            </button>
          </div>
          <div className={`${topologyExpanded ? 'h-[600px]' : 'h-[400px]'}`}>
            <NodeTopologyMap onNodeClick={handleNodeClick} />
          </div>
        </div>

        {/* Jobs Section */}
        {!topologyExpanded && (
          <div className="space-y-6">
            <JobTimeline onJobClick={handleJobClick} maxJobs={10} />
            <JobQueue onJobClick={handleJobClick} />
          </div>
        )}
      </div>

      {/* Expanded Jobs (when topology is expanded) */}
      {topologyExpanded && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mt-6">
          <JobTimeline onJobClick={handleJobClick} maxJobs={10} />
          <JobQueue onJobClick={handleJobClick} />
        </div>
      )}

      {/* Selected Agent Modal (placeholder) */}
      {selectedAgent && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setSelectedAgent(null)}>
          <div className="bg-gray-800 rounded-lg p-6 max-w-lg w-full mx-4" onClick={e => e.stopPropagation()}>
            <h3 className="text-xl font-bold mb-4">{selectedAgent.node_id}</h3>
            <pre className="text-sm text-gray-400 overflow-auto max-h-96">
              {JSON.stringify(selectedAgent, null, 2)}
            </pre>
            <button
              onClick={() => setSelectedAgent(null)}
              className="mt-4 w-full py-2 bg-gray-700 hover:bg-gray-600 rounded-lg transition-colors"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default DashboardView;

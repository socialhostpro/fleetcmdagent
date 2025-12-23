import React from 'react';
import { useAgentStore, useMetricsStore, useJobStore, useAlertStore } from '../../stores';
import { Server, Cpu, HardDrive, AlertTriangle, Activity, Layers } from 'lucide-react';

/**
 * Cluster Overview - Summary cards for the dashboard
 */
function ClusterOverview() {
  const agents = useAgentStore(state => state.agents);
  const clusterMetrics = useMetricsStore(state => state.clusterMetrics);
  const getAverageGpuUtilization = useMetricsStore(state => state.getAverageGpuUtilization);
  const runningJobs = useJobStore(state => state.runningJobs);
  const pendingJobs = useJobStore(state => state.pendingJobs);
  const activeAlerts = useAlertStore(state => state.activeAlerts);
  const getCriticalAlerts = useAlertStore(state => state.getCriticalAlerts);

  const onlineAgents = agents.filter(a => a.status === 'online');
  const offlineAgents = agents.filter(a => a.status === 'offline');
  const totalGpus = agents.reduce((sum, a) => sum + (a.gpu_count || 0), 0);
  const avgGpuUtil = getAverageGpuUtilization();
  const criticalAlerts = getCriticalAlerts();

  const StatCard = ({ icon: Icon, label, value, subValue, color, alert }) => (
    <div className={`bg-gray-800 rounded-lg p-4 border-l-4 ${color}`}>
      <div className="flex items-center justify-between">
        <div>
          <p className="text-gray-400 text-sm">{label}</p>
          <p className="text-2xl font-bold text-white mt-1">{value}</p>
          {subValue && <p className="text-xs text-gray-500 mt-1">{subValue}</p>}
        </div>
        <div className={`p-3 rounded-lg bg-gray-700/50`}>
          <Icon className={`w-6 h-6 ${alert ? 'text-red-400 animate-pulse' : 'text-gray-400'}`} />
        </div>
      </div>
    </div>
  );

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
      {/* Nodes */}
      <StatCard
        icon={Server}
        label="Nodes Online"
        value={`${onlineAgents.length}/${agents.length}`}
        subValue={offlineAgents.length > 0 ? `${offlineAgents.length} offline` : 'All healthy'}
        color={offlineAgents.length > 0 ? 'border-red-500' : 'border-green-500'}
        alert={offlineAgents.length > 0}
      />

      {/* GPUs */}
      <StatCard
        icon={Cpu}
        label="Total GPUs"
        value={totalGpus}
        subValue={`${avgGpuUtil}% avg utilization`}
        color={avgGpuUtil > 90 ? 'border-red-500' : avgGpuUtil > 70 ? 'border-yellow-500' : 'border-blue-500'}
      />

      {/* Clusters */}
      <StatCard
        icon={Layers}
        label="Clusters"
        value={Object.keys(clusterMetrics).length}
        subValue={Object.keys(clusterMetrics).join(', ') || 'No clusters'}
        color="border-purple-500"
      />

      {/* Jobs */}
      <StatCard
        icon={Activity}
        label="Active Jobs"
        value={runningJobs.length}
        subValue={`${pendingJobs.length} in queue`}
        color="border-blue-500"
      />

      {/* Disk (average across nodes) */}
      <StatCard
        icon={HardDrive}
        label="Avg Disk Usage"
        value={`${Math.round(
          agents.reduce((sum, a) => sum + (a.system?.disk_percent || 0), 0) / Math.max(1, agents.length)
        )}%`}
        subValue="Across all nodes"
        color="border-purple-500"
      />

      {/* Alerts */}
      <StatCard
        icon={AlertTriangle}
        label="Active Alerts"
        value={activeAlerts.length}
        subValue={criticalAlerts.length > 0 ? `${criticalAlerts.length} critical` : 'No critical'}
        color={criticalAlerts.length > 0 ? 'border-red-500' : activeAlerts.length > 0 ? 'border-yellow-500' : 'border-green-500'}
        alert={criticalAlerts.length > 0}
      />
    </div>
  );
}

export default ClusterOverview;

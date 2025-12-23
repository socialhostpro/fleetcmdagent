import React, { memo } from 'react';
import { Layers, Users, Cpu } from 'lucide-react';

/**
 * Cluster Group - Visual grouping of nodes in a cluster
 */
function ClusterGroup({ data }) {
  const { name, nodeCount, onlineCount, color, metrics } = data;
  const offlineCount = nodeCount - onlineCount;

  return (
    <div className="w-full h-full">
      {/* Cluster header */}
      <div className="absolute -top-1 left-4 flex items-center gap-2 bg-gray-800 px-3 py-1.5 rounded-lg border"
           style={{ borderColor: color?.border || '#6b7280' }}>
        <Layers className="w-4 h-4" style={{ color: color?.border || '#6b7280' }} />
        <span className="font-semibold text-white capitalize">{name}</span>
        <div className="flex items-center gap-2 ml-2 text-sm">
          <span className="flex items-center gap-1 text-green-400">
            <Users className="w-3 h-3" />
            {onlineCount}
          </span>
          {offlineCount > 0 && (
            <span className="text-red-400">
              / {offlineCount} offline
            </span>
          )}
        </div>
      </div>

      {/* Cluster metrics (if available) */}
      {metrics && (
        <div className="absolute -top-1 right-4 flex items-center gap-3 bg-gray-800 px-3 py-1.5 rounded-lg border"
             style={{ borderColor: color?.border || '#6b7280' }}>
          <div className="flex items-center gap-1 text-sm">
            <Cpu className="w-3 h-3 text-yellow-400" />
            <span className="text-gray-300">
              {metrics.totalGpus} GPUs @ {metrics.avgGpuUtil || 0}%
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

export default memo(ClusterGroup);

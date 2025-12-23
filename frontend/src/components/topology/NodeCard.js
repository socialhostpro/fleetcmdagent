import React, { memo } from 'react';
import { Handle, Position } from 'reactflow';
import { Cpu, HardDrive, Thermometer, Zap, Server } from 'lucide-react';

/**
 * Node Card - Displays agent/node information in the topology map
 */
function NodeCard({ data }) {
  const { agent, onClick } = data;
  const isOnline = agent?.status === 'online';
  const system = agent?.system || {};
  const gpus = agent?.gpus || [];

  const avgGpuUtil = gpus.length > 0
    ? Math.round(gpus.reduce((sum, g) => sum + (g.utilization || 0), 0) / gpus.length)
    : 0;

  const avgGpuTemp = gpus.length > 0
    ? Math.round(gpus.reduce((sum, g) => sum + (g.temperature || 0), 0) / gpus.length)
    : 0;

  return (
    <div
      className={`
        relative bg-gray-800 rounded-lg p-4 min-w-[260px] cursor-pointer
        border-2 transition-all duration-200 hover:scale-105
        ${isOnline ? 'border-green-500 shadow-lg shadow-green-500/20' : 'border-red-500 shadow-lg shadow-red-500/20'}
      `}
      onClick={onClick}
    >
      {/* Connection handles */}
      <Handle type="target" position={Position.Top} className="w-3 h-3 bg-gray-600" />
      <Handle type="source" position={Position.Bottom} className="w-3 h-3 bg-gray-600" />

      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Server className={`w-5 h-5 ${isOnline ? 'text-green-400' : 'text-red-400'}`} />
          <span className="font-semibold text-white">{agent?.node_id || 'Unknown'}</span>
        </div>
        <div className={`
          px-2 py-0.5 rounded-full text-xs font-medium
          ${isOnline ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}
        `}>
          {isOnline ? 'Online' : 'Offline'}
        </div>
      </div>

      {/* Cluster badge */}
      <div className="mb-3">
        <span className="px-2 py-1 bg-gray-700 rounded text-xs text-gray-300">
          {agent?.cluster || 'default'}
        </span>
        {gpus.length > 0 && (
          <span className="ml-2 px-2 py-1 bg-blue-500/20 rounded text-xs text-blue-400">
            {gpus.length} GPU{gpus.length > 1 ? 's' : ''}
          </span>
        )}
      </div>

      {/* Metrics grid */}
      {isOnline && (
        <div className="grid grid-cols-2 gap-2 text-sm">
          {/* GPU Utilization */}
          <div className="flex items-center gap-2 text-gray-300">
            <Zap className="w-4 h-4 text-yellow-400" />
            <div className="flex-1">
              <div className="flex justify-between">
                <span>GPU</span>
                <span className={avgGpuUtil > 80 ? 'text-red-400' : 'text-green-400'}>
                  {avgGpuUtil}%
                </span>
              </div>
              <div className="w-full h-1.5 bg-gray-700 rounded-full mt-1">
                <div
                  className={`h-full rounded-full transition-all ${
                    avgGpuUtil > 80 ? 'bg-red-500' : avgGpuUtil > 50 ? 'bg-yellow-500' : 'bg-green-500'
                  }`}
                  style={{ width: `${avgGpuUtil}%` }}
                />
              </div>
            </div>
          </div>

          {/* GPU Temperature */}
          <div className="flex items-center gap-2 text-gray-300">
            <Thermometer className="w-4 h-4 text-orange-400" />
            <div className="flex-1">
              <div className="flex justify-between">
                <span>Temp</span>
                <span className={avgGpuTemp > 80 ? 'text-red-400' : 'text-green-400'}>
                  {avgGpuTemp}°C
                </span>
              </div>
              <div className="w-full h-1.5 bg-gray-700 rounded-full mt-1">
                <div
                  className={`h-full rounded-full transition-all ${
                    avgGpuTemp > 80 ? 'bg-red-500' : avgGpuTemp > 60 ? 'bg-yellow-500' : 'bg-green-500'
                  }`}
                  style={{ width: `${Math.min(100, avgGpuTemp)}%` }}
                />
              </div>
            </div>
          </div>

          {/* CPU */}
          <div className="flex items-center gap-2 text-gray-300">
            <Cpu className="w-4 h-4 text-blue-400" />
            <div className="flex-1">
              <div className="flex justify-between">
                <span>CPU</span>
                <span>{Math.round(system.cpu_percent || 0)}%</span>
              </div>
              <div className="w-full h-1.5 bg-gray-700 rounded-full mt-1">
                <div
                  className="h-full bg-blue-500 rounded-full transition-all"
                  style={{ width: `${system.cpu_percent || 0}%` }}
                />
              </div>
            </div>
          </div>

          {/* Disk */}
          <div className="flex items-center gap-2 text-gray-300">
            <HardDrive className="w-4 h-4 text-purple-400" />
            <div className="flex-1">
              <div className="flex justify-between">
                <span>Disk</span>
                <span className={system.disk_percent > 90 ? 'text-red-400' : ''}>
                  {Math.round(system.disk_percent || 0)}%
                </span>
              </div>
              <div className="w-full h-1.5 bg-gray-700 rounded-full mt-1">
                <div
                  className={`h-full rounded-full transition-all ${
                    system.disk_percent > 90 ? 'bg-red-500' : 'bg-purple-500'
                  }`}
                  style={{ width: `${system.disk_percent || 0}%` }}
                />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Offline message */}
      {!isOnline && (
        <div className="text-center text-gray-500 py-4">
          <p className="text-sm">No heartbeat received</p>
          <p className="text-xs mt-1">Last seen: {agent?.last_heartbeat || 'Never'}</p>
        </div>
      )}

      {/* GPU names tooltip */}
      {gpus.length > 0 && (
        <div className="mt-2 pt-2 border-t border-gray-700">
          <p className="text-xs text-gray-500 truncate">
            {gpus.map(g => g.name).join(', ')}
          </p>
        </div>
      )}
    </div>
  );
}

export default memo(NodeCard);

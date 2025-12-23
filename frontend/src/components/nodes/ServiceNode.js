import React, { memo } from 'react';
import { Handle, Position } from 'reactflow';
import {
  Database, Server, Layers, Container, Globe, HardDrive,
  Cpu, Image, Video, Brain, Mic, Music, Box, ExternalLink
} from 'lucide-react';
import clsx from 'clsx';
import StatusDot from './StatusDot';

// Service icon mapping based on image name or service type
const getServiceIcon = (service) => {
  const image = service.image?.toLowerCase() || '';
  const name = service.name?.toLowerCase() || '';

  if (image.includes('postgres') || image.includes('postgis')) return { icon: Database, color: '#336791', bg: 'bg-blue-500/10' };
  if (image.includes('redis')) return { icon: Database, color: '#DC382D', bg: 'bg-red-500/10' };
  if (image.includes('mysql') || image.includes('mariadb')) return { icon: Database, color: '#00758F', bg: 'bg-cyan-500/10' };
  if (image.includes('mongo')) return { icon: Database, color: '#47A248', bg: 'bg-green-500/10' };
  if (image.includes('minio') || image.includes('s3')) return { icon: HardDrive, color: '#C72C48', bg: 'bg-pink-500/10' };
  if (image.includes('nginx') || image.includes('traefik') || image.includes('caddy')) return { icon: Globe, color: '#009639', bg: 'bg-green-500/10' };
  if (image.includes('comfyui') || image.includes('stable-diffusion') || name.includes('vision')) return { icon: Image, color: '#8B5CF6', bg: 'bg-purple-500/10' };
  if (image.includes('llama') || image.includes('mistral') || name.includes('llm')) return { icon: Brain, color: '#EC4899', bg: 'bg-pink-500/10' };
  if (image.includes('whisper') || image.includes('xtts') || name.includes('voice')) return { icon: Mic, color: '#F59E0B', bg: 'bg-amber-500/10' };
  if (image.includes('musicgen') || name.includes('music')) return { icon: Music, color: '#10B981', bg: 'bg-emerald-500/10' };
  if (image.includes('wan') || image.includes('animatediff') || name.includes('video')) return { icon: Video, color: '#3B82F6', bg: 'bg-blue-500/10' };
  if (image.includes('pytorch') || image.includes('tensorflow')) return { icon: Cpu, color: '#EE4C2C', bg: 'bg-orange-500/10' };

  return { icon: Container, color: '#0DB7ED', bg: 'bg-sky-500/10' };
};

const ServiceNode = ({ data, selected }) => {
  const { icon: Icon, color, bg } = getServiceIcon(data);
  const isRunning = data.replicas?.running > 0 || data.state === 'running';
  const replicaText = data.replicas ? `${data.replicas.running}/${data.replicas.desired}` : '1/1';

  return (
    <div
      className={clsx(
        'bg-bg-secondary rounded-xl border-2 p-4 min-w-[200px] max-w-[280px] transition-all duration-200',
        selected ? 'border-text-accent shadow-lg shadow-text-accent/20' : 'border-border-default hover:border-border-bright',
        !isRunning && 'opacity-60'
      )}
      style={selected ? { boxShadow: `0 0 20px ${color}30` } : {}}
    >
      {/* Connection handles */}
      <Handle
        type="target"
        position={Position.Top}
        className="!bg-text-accent !border-2 !border-bg-secondary !w-3 !h-3"
      />
      <Handle
        type="source"
        position={Position.Bottom}
        className="!bg-text-accent !border-2 !border-bg-secondary !w-3 !h-3"
      />
      <Handle
        type="target"
        position={Position.Left}
        id="left"
        className="!bg-text-accent !border-2 !border-bg-secondary !w-3 !h-3"
      />
      <Handle
        type="source"
        position={Position.Right}
        id="right"
        className="!bg-text-accent !border-2 !border-bg-secondary !w-3 !h-3"
      />

      {/* Header */}
      <div className="flex items-start gap-3 mb-3">
        <div className={clsx('p-2 rounded-lg', bg)}>
          <Icon size={24} style={{ color }} />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="font-bold text-text-primary truncate">{data.name}</h3>
          <p className="text-text-muted text-xs truncate">
            {data.image?.split('/').pop()?.split(':')[0] || 'service'}
          </p>
        </div>
      </div>

      {/* Status */}
      <div className="flex items-center gap-2 mb-3">
        <StatusDot status={isRunning ? 'online' : 'offline'} />
        <span className={clsx(
          'text-sm',
          isRunning ? 'text-status-online' : 'text-status-error'
        )}>
          {isRunning ? 'Online' : 'Offline'}
        </span>
        <span className="text-text-muted text-xs ml-auto">
          {replicaText} replicas
        </span>
      </div>

      {/* Mounts/Volumes */}
      {data.mounts && data.mounts.length > 0 && (
        <div className="space-y-1 pt-2 border-t border-border-subtle">
          {data.mounts.slice(0, 2).map((mount, idx) => (
            <div key={idx} className="flex items-center gap-2 text-text-muted text-xs">
              <Box size={12} />
              <span className="truncate">{mount.target || mount.Target || 'volume'}</span>
            </div>
          ))}
          {data.mounts.length > 2 && (
            <div className="text-text-muted text-xs">
              +{data.mounts.length - 2} more volumes
            </div>
          )}
        </div>
      )}

      {/* Ports & Open Button */}
      {data.ports && data.ports.length > 0 && (
        <div className="flex items-center gap-2 mt-2">
          <div className="flex flex-wrap gap-1 flex-1">
            {data.ports.slice(0, 2).map((port, idx) => (
              <span
                key={idx}
                className="px-1.5 py-0.5 bg-bg-tertiary rounded text-text-muted text-xs font-mono"
              >
                :{port.PublishedPort || port.published_port}
              </span>
            ))}
          </div>
          {isRunning && data.ports[0] && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                const port = data.ports[0].PublishedPort || data.ports[0].published_port;
                const nodeIp = data.nodeIp || window.location.hostname;
                window.open(`http://${nodeIp}:${port}`, '_blank');
              }}
              className="px-2 py-1 bg-text-accent/20 hover:bg-text-accent/30 text-text-accent rounded text-xs flex items-center gap-1"
            >
              <ExternalLink size={10} />
              Open
            </button>
          )}
        </div>
      )}

      {/* Node placement */}
      {(data.node || data.nodeIp) && (
        <div className="mt-2 pt-2 border-t border-border-subtle">
          <div className="flex items-center gap-1 text-text-muted text-xs">
            <Server size={10} />
            <span>{data.node || 'node'}</span>
            {data.nodeIp && (
              <span className="font-mono text-text-secondary ml-auto">{data.nodeIp}</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default memo(ServiceNode);

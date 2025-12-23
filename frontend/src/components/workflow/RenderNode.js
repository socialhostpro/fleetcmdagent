import React, { memo } from 'react';
import { Handle, Position } from 'reactflow';
import { Sparkles, Cpu, Gauge } from 'lucide-react';

const qualityColors = {
  preview: 'text-green-300',
  medium: 'text-yellow-300',
  high: 'text-orange-300',
  final: 'text-red-300',
};

const RenderNode = ({ data, selected }) => {
  return (
    <div className={`
      bg-gradient-to-br from-green-900/50 to-green-800/30
      border-2 ${selected ? 'border-green-400' : 'border-green-600/50'}
      rounded-lg w-48 shadow-lg
      ${selected ? 'ring-2 ring-green-400/50' : ''}
    `}>
      <Handle
        type="target"
        position={Position.Left}
        className="!bg-green-400 !border-green-600 !w-3 !h-3"
      />

      <div className="px-3 py-2 border-b border-green-600/30">
        <div className="flex items-center gap-2">
          <Sparkles size={16} className="text-green-400" />
          <span className="text-sm font-semibold text-white">{data.label || 'Render'}</span>
        </div>
      </div>

      <div className="px-3 py-2 space-y-1.5">
        <div className="flex items-center justify-between text-xs">
          <span className="text-green-300 flex items-center gap-1">
            <Cpu size={10} />
            Model
          </span>
          <span className="text-green-200 font-mono uppercase">{data.model || 'Flux'}</span>
        </div>
        <div className="flex items-center justify-between text-xs">
          <span className="text-green-300 flex items-center gap-1">
            <Gauge size={10} />
            Quality
          </span>
          <span className={`font-medium capitalize ${qualityColors[data.quality] || 'text-green-200'}`}>
            {data.quality || 'Preview'}
          </span>
        </div>
        {data.steps && (
          <div className="flex items-center justify-between text-xs">
            <span className="text-green-300">Steps</span>
            <span className="text-green-200 font-mono">{data.steps}</span>
          </div>
        )}
      </div>

      <Handle
        type="source"
        position={Position.Right}
        className="!bg-green-400 !border-green-600 !w-3 !h-3"
      />
    </div>
  );
};

export default memo(RenderNode);

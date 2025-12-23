import React, { memo } from 'react';
import { Handle, Position } from 'reactflow';
import { Move, Maximize } from 'lucide-react';

const WarpNode = ({ data, selected }) => {
  return (
    <div className={`
      bg-gradient-to-br from-cyan-900/50 to-cyan-800/30
      border-2 ${selected ? 'border-cyan-400' : 'border-cyan-600/50'}
      rounded-lg w-44 shadow-lg
      ${selected ? 'ring-2 ring-cyan-400/50' : ''}
    `}>
      <Handle
        type="target"
        position={Position.Left}
        className="!bg-cyan-400 !border-cyan-600 !w-3 !h-3"
      />

      <div className="px-3 py-2 border-b border-cyan-600/30">
        <div className="flex items-center gap-2">
          <Move size={16} className="text-cyan-400" />
          <span className="text-sm font-semibold text-white">{data.label || 'Warp'}</span>
        </div>
      </div>

      <div className="px-3 py-2 space-y-1">
        <div className="flex items-center gap-1 text-xs text-cyan-300">
          <Maximize size={10} />
          <span>Real-time preview</span>
        </div>
        <div className="text-xs text-cyan-400">
          GPU mesh warp
        </div>
      </div>

      <Handle
        type="source"
        position={Position.Right}
        className="!bg-cyan-400 !border-cyan-600 !w-3 !h-3"
      />
    </div>
  );
};

export default memo(WarpNode);

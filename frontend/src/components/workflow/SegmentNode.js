import React, { memo } from 'react';
import { Handle, Position } from 'reactflow';
import { Scissors, Scan } from 'lucide-react';

const SegmentNode = ({ data, selected }) => {
  return (
    <div className={`
      bg-gradient-to-br from-purple-900/50 to-purple-800/30
      border-2 ${selected ? 'border-purple-400' : 'border-purple-600/50'}
      rounded-lg w-44 shadow-lg
      ${selected ? 'ring-2 ring-purple-400/50' : ''}
    `}>
      <Handle
        type="target"
        position={Position.Left}
        className="!bg-purple-400 !border-purple-600 !w-3 !h-3"
      />

      <div className="px-3 py-2 border-b border-purple-600/30">
        <div className="flex items-center gap-2">
          <Scissors size={16} className="text-purple-400" />
          <span className="text-sm font-semibold text-white">{data.label || 'Segment'}</span>
        </div>
      </div>

      <div className="px-3 py-2 space-y-1">
        <div className="flex items-center justify-between text-xs">
          <span className="text-purple-300">Model</span>
          <span className="text-purple-200 font-mono">{data.model || 'SAM'}</span>
        </div>
        {data.trackMotion && (
          <div className="flex items-center gap-1 text-xs text-purple-300">
            <Scan size={10} />
            <span>Motion tracking</span>
          </div>
        )}
      </div>

      <Handle
        type="source"
        position={Position.Right}
        className="!bg-purple-400 !border-purple-600 !w-3 !h-3"
      />
    </div>
  );
};

export default memo(SegmentNode);

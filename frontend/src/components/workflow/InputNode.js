import React, { memo } from 'react';
import { Handle, Position } from 'reactflow';
import { Upload, Film, Image } from 'lucide-react';

const InputNode = ({ data, selected }) => {
  return (
    <div className={`
      bg-gradient-to-br from-blue-900/50 to-blue-800/30
      border-2 ${selected ? 'border-blue-400' : 'border-blue-600/50'}
      rounded-lg w-44 shadow-lg
      ${selected ? 'ring-2 ring-blue-400/50' : ''}
    `}>
      <div className="px-3 py-2 border-b border-blue-600/30">
        <div className="flex items-center gap-2">
          <Upload size={16} className="text-blue-400" />
          <span className="text-sm font-semibold text-white">{data.label || 'Input'}</span>
        </div>
      </div>

      <div className="px-3 py-2 space-y-2">
        <div className="flex items-center gap-2 text-xs text-blue-200">
          <Film size={12} />
          <span>Source Media</span>
        </div>
        {data.source && (
          <div className="text-xs text-blue-300 truncate">
            {data.source}
          </div>
        )}
      </div>

      <Handle
        type="source"
        position={Position.Right}
        className="!bg-blue-400 !border-blue-600 !w-3 !h-3"
      />
    </div>
  );
};

export default memo(InputNode);

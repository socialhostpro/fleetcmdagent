import React, { memo } from 'react';
import { Handle, Position } from 'reactflow';
import { Film, Download, Check } from 'lucide-react';

const OutputNode = ({ data, selected }) => {
  return (
    <div className={`
      bg-gradient-to-br from-red-900/50 to-red-800/30
      border-2 ${selected ? 'border-red-400' : 'border-red-600/50'}
      rounded-lg w-44 shadow-lg
      ${selected ? 'ring-2 ring-red-400/50' : ''}
    `}>
      <Handle
        type="target"
        position={Position.Left}
        className="!bg-red-400 !border-red-600 !w-3 !h-3"
      />

      <div className="px-3 py-2 border-b border-red-600/30">
        <div className="flex items-center gap-2">
          <Film size={16} className="text-red-400" />
          <span className="text-sm font-semibold text-white">{data.label || 'Output'}</span>
        </div>
      </div>

      <div className="px-3 py-2 space-y-2">
        <div className="flex items-center gap-2 text-xs text-red-200">
          <Download size={12} />
          <span>S3 Delivery</span>
        </div>
        <div className="flex flex-wrap gap-1">
          {['mp4', 'webm', 'png'].map((format) => (
            <span
              key={format}
              className="px-1.5 py-0.5 bg-red-800/50 rounded text-[10px] text-red-300 uppercase"
            >
              {format}
            </span>
          ))}
        </div>
        {data.completed && (
          <div className="flex items-center gap-1 text-xs text-green-400">
            <Check size={12} />
            <span>Delivered</span>
          </div>
        )}
      </div>
    </div>
  );
};

export default memo(OutputNode);

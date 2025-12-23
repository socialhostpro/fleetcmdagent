import React, { memo } from 'react';
import { Handle, Position } from 'reactflow';
import { CheckCircle, AlertTriangle, BarChart3 } from 'lucide-react';

const QCNode = ({ data, selected }) => {
  const stability = data.thresholds?.stability || 0.8;
  const sharpness = data.thresholds?.sharpness || 0.7;

  return (
    <div className={`
      bg-gradient-to-br from-yellow-900/50 to-yellow-800/30
      border-2 ${selected ? 'border-yellow-400' : 'border-yellow-600/50'}
      rounded-lg w-48 shadow-lg
      ${selected ? 'ring-2 ring-yellow-400/50' : ''}
    `}>
      <Handle
        type="target"
        position={Position.Left}
        className="!bg-yellow-400 !border-yellow-600 !w-3 !h-3"
      />

      <div className="px-3 py-2 border-b border-yellow-600/30">
        <div className="flex items-center gap-2">
          <CheckCircle size={16} className="text-yellow-400" />
          <span className="text-sm font-semibold text-white">{data.label || 'QC Check'}</span>
        </div>
      </div>

      <div className="px-3 py-2 space-y-2">
        <div className="space-y-1">
          <div className="flex items-center justify-between text-xs">
            <span className="text-yellow-300">Stability</span>
            <span className="text-yellow-200 font-mono">{(stability * 100).toFixed(0)}%</span>
          </div>
          <div className="h-1 bg-yellow-900 rounded-full overflow-hidden">
            <div
              className="h-full bg-yellow-400 rounded-full"
              style={{ width: `${stability * 100}%` }}
            />
          </div>
        </div>

        <div className="space-y-1">
          <div className="flex items-center justify-between text-xs">
            <span className="text-yellow-300">Sharpness</span>
            <span className="text-yellow-200 font-mono">{(sharpness * 100).toFixed(0)}%</span>
          </div>
          <div className="h-1 bg-yellow-900 rounded-full overflow-hidden">
            <div
              className="h-full bg-yellow-400 rounded-full"
              style={{ width: `${sharpness * 100}%` }}
            />
          </div>
        </div>

        <div className="flex items-center gap-1 text-xs text-yellow-400 pt-1">
          <BarChart3 size={10} />
          <span>Max retries: {data.maxRetries || 3}</span>
        </div>
      </div>

      {/* Pass output */}
      <Handle
        type="source"
        position={Position.Right}
        id="pass"
        style={{ top: '30%' }}
        className="!bg-green-400 !border-green-600 !w-3 !h-3"
      />

      {/* Fail output (to Fix node) */}
      <Handle
        type="source"
        position={Position.Bottom}
        id="fail"
        className="!bg-orange-400 !border-orange-600 !w-3 !h-3"
      />

      <div className="absolute -right-8 top-[25%] text-[10px] text-green-400">pass</div>
      <div className="absolute bottom-[-18px] left-1/2 -translate-x-1/2 text-[10px] text-orange-400">fail</div>
    </div>
  );
};

export default memo(QCNode);

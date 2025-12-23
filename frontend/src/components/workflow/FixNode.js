import React, { memo } from 'react';
import { Handle, Position } from 'reactflow';
import { Wand2, Brush, ZoomIn, User, Hand, Film } from 'lucide-react';

const actionIcons = {
  denoise: Brush,
  upscale: ZoomIn,
  face_restore: User,
  hand_fix: Hand,
  interpolate: Film,
};

const FixNode = ({ data, selected }) => {
  const actions = data.actions || [];

  return (
    <div className={`
      bg-gradient-to-br from-orange-900/50 to-orange-800/30
      border-2 ${selected ? 'border-orange-400' : 'border-orange-600/50'}
      rounded-lg w-44 shadow-lg
      ${selected ? 'ring-2 ring-orange-400/50' : ''}
    `}>
      <Handle
        type="target"
        position={Position.Top}
        className="!bg-orange-400 !border-orange-600 !w-3 !h-3"
      />

      <div className="px-3 py-2 border-b border-orange-600/30">
        <div className="flex items-center gap-2">
          <Wand2 size={16} className="text-orange-400" />
          <span className="text-sm font-semibold text-white">{data.label || 'Auto-Fix'}</span>
        </div>
      </div>

      <div className="px-3 py-2">
        {actions.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {actions.map((action) => {
              const Icon = actionIcons[action] || Wand2;
              return (
                <div
                  key={action}
                  className="flex items-center gap-1 px-1.5 py-0.5 bg-orange-800/50 rounded text-xs text-orange-200"
                  title={action.replace('_', ' ')}
                >
                  <Icon size={10} />
                  <span className="capitalize">{action.split('_')[0]}</span>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="text-xs text-orange-300 italic">No fixes selected</div>
        )}
      </div>

      <Handle
        type="source"
        position={Position.Right}
        className="!bg-orange-400 !border-orange-600 !w-3 !h-3"
      />
    </div>
  );
};

export default memo(FixNode);

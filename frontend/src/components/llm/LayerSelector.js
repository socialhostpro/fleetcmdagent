import React from 'react';
import clsx from 'clsx';
import { Layers, GitBranch } from 'lucide-react';

/**
 * LayerSelector - Select which transformer layer and attention head to visualize
 */
const LayerSelector = ({
  numLayers = 12,
  numHeads = 12,
  selectedLayer = 0,
  selectedHead = 0,
  onLayerChange,
  onHeadChange,
  className
}) => {
  return (
    <div className={clsx('flex flex-col gap-4', className)}>
      {/* Layer Selection */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <Layers size={14} className="text-text-muted" />
          <span className="text-xs font-semibold text-text-muted uppercase tracking-wider">
            Layer {selectedLayer + 1} / {numLayers}
          </span>
        </div>
        <div className="flex flex-wrap gap-1">
          {Array.from({ length: numLayers }, (_, i) => (
            <button
              key={`layer-${i}`}
              onClick={() => onLayerChange?.(i)}
              className={clsx(
                'w-8 h-8 rounded text-xs font-mono transition-all',
                selectedLayer === i
                  ? 'bg-text-accent text-bg-primary font-bold'
                  : 'bg-bg-tertiary text-text-muted hover:bg-bg-hover hover:text-text-primary border border-border-subtle'
              )}
            >
              {i + 1}
            </button>
          ))}
        </div>
      </div>

      {/* Head Selection */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <GitBranch size={14} className="text-text-muted" />
          <span className="text-xs font-semibold text-text-muted uppercase tracking-wider">
            Head {selectedHead + 1} / {numHeads}
          </span>
        </div>
        <div className="flex flex-wrap gap-1">
          {Array.from({ length: numHeads }, (_, i) => (
            <button
              key={`head-${i}`}
              onClick={() => onHeadChange?.(i)}
              className={clsx(
                'w-8 h-8 rounded text-xs font-mono transition-all',
                selectedHead === i
                  ? 'bg-cluster-spark text-white font-bold'
                  : 'bg-bg-tertiary text-text-muted hover:bg-bg-hover hover:text-text-primary border border-border-subtle'
              )}
            >
              {i + 1}
            </button>
          ))}
        </div>
      </div>

      {/* Quick presets */}
      <div>
        <span className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-2 block">
          Quick View
        </span>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => { onLayerChange?.(0); onHeadChange?.(0); }}
            className="px-2 py-1 text-xs bg-bg-tertiary rounded hover:bg-bg-hover border border-border-subtle"
          >
            First Layer
          </button>
          <button
            onClick={() => { onLayerChange?.(Math.floor(numLayers / 2)); onHeadChange?.(0); }}
            className="px-2 py-1 text-xs bg-bg-tertiary rounded hover:bg-bg-hover border border-border-subtle"
          >
            Middle Layer
          </button>
          <button
            onClick={() => { onLayerChange?.(numLayers - 1); onHeadChange?.(0); }}
            className="px-2 py-1 text-xs bg-bg-tertiary rounded hover:bg-bg-hover border border-border-subtle"
          >
            Last Layer
          </button>
        </div>
      </div>
    </div>
  );
};

export default LayerSelector;

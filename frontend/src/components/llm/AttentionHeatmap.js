import React, { useRef, useEffect, useMemo } from 'react';
import clsx from 'clsx';

/**
 * AttentionHeatmap - Visualizes transformer attention weights as a heatmap
 *
 * Uses canvas for performance with large attention matrices.
 * Supports layer/head selection and hover interactions.
 */
const AttentionHeatmap = ({
  attentionHeads = [],
  tokens = [],
  selectedLayer = 0,
  selectedHead = 0,
  onCellHover,
  className
}) => {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);

  // Get the attention weights for selected layer/head
  const selectedAttention = useMemo(() => {
    const head = attentionHeads.find(
      h => h.layer === selectedLayer && h.head === selectedHead
    );
    if (!head || !head.weights) return null;

    // Decompress sparse format to full matrix
    const seqLen = tokens.length;
    const matrix = Array(seqLen).fill(null).map(() => Array(seqLen).fill(0));

    head.weights.forEach((sparseRow, i) => {
      for (let j = 0; j < sparseRow.length; j += 2) {
        const value = sparseRow[j];
        const colIdx = Math.floor(sparseRow[j + 1]);
        if (colIdx < seqLen) {
          matrix[i][colIdx] = value;
        }
      }
    });

    return matrix;
  }, [attentionHeads, selectedLayer, selectedHead, tokens.length]);

  // Draw the heatmap
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container || !selectedAttention || tokens.length === 0) return;

    const ctx = canvas.getContext('2d');
    const seqLen = tokens.length;

    // Calculate cell size
    const padding = 60; // Space for labels
    const availableWidth = container.clientWidth - padding;
    const availableHeight = container.clientHeight - padding;
    const cellSize = Math.min(
      Math.floor(availableWidth / seqLen),
      Math.floor(availableHeight / seqLen),
      30 // Max cell size
    );

    const width = cellSize * seqLen + padding;
    const height = cellSize * seqLen + padding;

    canvas.width = width;
    canvas.height = height;

    // Clear
    ctx.fillStyle = '#0a0f1a';
    ctx.fillRect(0, 0, width, height);

    // Draw heatmap cells
    for (let i = 0; i < seqLen; i++) {
      for (let j = 0; j < seqLen; j++) {
        const value = selectedAttention[i][j];
        const intensity = Math.min(value, 1);

        // Color gradient: dark blue -> cyan -> yellow
        let r, g, b;
        if (intensity < 0.5) {
          const t = intensity * 2;
          r = Math.floor(10 + t * 50);
          g = Math.floor(20 + t * 180);
          b = Math.floor(100 + t * 155);
        } else {
          const t = (intensity - 0.5) * 2;
          r = Math.floor(60 + t * 195);
          g = Math.floor(200 + t * 55);
          b = Math.floor(255 - t * 155);
        }

        ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
        ctx.fillRect(
          padding + j * cellSize,
          padding + i * cellSize,
          cellSize - 1,
          cellSize - 1
        );
      }
    }

    // Draw token labels
    ctx.fillStyle = '#a0aec0';
    ctx.font = '10px monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    tokens.forEach((token, i) => {
      const label = token.token.slice(0, 6);
      // Row labels (source tokens)
      ctx.fillText(label, padding - 5, padding + i * cellSize + cellSize / 2);
    });

    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    tokens.forEach((token, j) => {
      ctx.save();
      ctx.translate(padding + j * cellSize + cellSize / 2, padding - 5);
      ctx.rotate(-Math.PI / 4);
      const label = token.token.slice(0, 6);
      ctx.fillText(label, 0, 0);
      ctx.restore();
    });

  }, [selectedAttention, tokens]);

  // Handle mouse hover
  const handleMouseMove = (e) => {
    if (!onCellHover || !selectedAttention) return;

    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left - 60;
    const y = e.clientY - rect.top - 60;

    const seqLen = tokens.length;
    const cellSize = Math.min(
      Math.floor((canvas.width - 60) / seqLen),
      30
    );

    const col = Math.floor(x / cellSize);
    const row = Math.floor(y / cellSize);

    if (row >= 0 && row < seqLen && col >= 0 && col < seqLen) {
      onCellHover({
        sourceToken: tokens[row],
        targetToken: tokens[col],
        attention: selectedAttention[row][col],
        row,
        col
      });
    }
  };

  if (!selectedAttention || tokens.length === 0) {
    return (
      <div className={clsx('flex items-center justify-center h-full text-text-muted', className)}>
        <div className="text-center">
          <p className="text-sm">No attention data available</p>
          <p className="text-xs mt-1">Start a monitoring session to see attention patterns</p>
        </div>
      </div>
    );
  }

  return (
    <div ref={containerRef} className={clsx('relative h-full w-full overflow-auto', className)}>
      <canvas
        ref={canvasRef}
        onMouseMove={handleMouseMove}
        className="cursor-crosshair"
      />
    </div>
  );
};

export default AttentionHeatmap;

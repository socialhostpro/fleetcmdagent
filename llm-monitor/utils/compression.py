"""
Attention matrix compression utilities

Attention matrices can be large (seq_len x seq_len) and mostly sparse.
This module provides compression for efficient WebSocket transmission.
"""

import numpy as np
from typing import List, Tuple


def compress_attention(
    attention: np.ndarray,
    threshold: float = 0.01,
    top_k: int = 50
) -> List[List[float]]:
    """
    Compress attention matrix by keeping only significant values.

    Args:
        attention: [seq_len, seq_len] attention weight matrix
        threshold: Minimum attention weight to keep
        top_k: Maximum number of values to keep per row

    Returns:
        Compressed representation as list of lists
    """
    seq_len = attention.shape[0]
    compressed = []

    for i in range(seq_len):
        row = attention[i]
        # Get indices of top-k values above threshold
        significant = np.where(row > threshold)[0]

        if len(significant) > top_k:
            # Keep only top-k
            top_indices = np.argsort(row[significant])[-top_k:]
            significant = significant[top_indices]

        # Store as sparse format: [value, index, value, index, ...]
        sparse_row = []
        for idx in significant:
            sparse_row.extend([float(row[idx]), int(idx)])

        compressed.append(sparse_row)

    return compressed


def decompress_attention(
    compressed: List[List[float]],
    seq_len: int
) -> np.ndarray:
    """
    Decompress attention matrix from sparse format.

    Args:
        compressed: Sparse attention representation
        seq_len: Original sequence length

    Returns:
        Full [seq_len, seq_len] attention matrix
    """
    attention = np.zeros((seq_len, seq_len), dtype=np.float32)

    for i, sparse_row in enumerate(compressed):
        # Parse [value, index, value, index, ...] format
        for j in range(0, len(sparse_row), 2):
            if j + 1 < len(sparse_row):
                value = sparse_row[j]
                idx = int(sparse_row[j + 1])
                if idx < seq_len:
                    attention[i, idx] = value

    return attention


def attention_to_edges(
    attention: np.ndarray,
    threshold: float = 0.1
) -> List[Tuple[int, int, float]]:
    """
    Convert attention matrix to edge list for graph visualization.

    Args:
        attention: [seq_len, seq_len] attention weight matrix
        threshold: Minimum weight to include edge

    Returns:
        List of (source, target, weight) tuples
    """
    edges = []
    indices = np.where(attention > threshold)

    for src, tgt in zip(indices[0], indices[1]):
        weight = float(attention[src, tgt])
        edges.append((int(src), int(tgt), weight))

    return edges

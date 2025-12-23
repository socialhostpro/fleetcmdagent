"""
Embedding dimensionality reduction utilities

High-dimensional embeddings (768+ dims) need to be projected to 2D/3D
for visualization. This module provides fast projection methods.
"""

import numpy as np
from typing import Union, Optional
from sklearn.decomposition import PCA


# Cache for fitted projectors
_projector_cache = {}


def downsample_embeddings(
    embeddings: Union[np.ndarray, list],
    dimensions: int = 2,
    method: str = "pca"
) -> np.ndarray:
    """
    Project high-dimensional embeddings to 2D or 3D for visualization.

    Args:
        embeddings: [seq_len, hidden_dim] embedding matrix
        dimensions: Target dimensions (2 or 3)
        method: Projection method ("pca" or "umap")

    Returns:
        [seq_len, dimensions] projected embeddings
    """
    embeddings = np.array(embeddings, dtype=np.float32)

    if len(embeddings.shape) == 1:
        embeddings = embeddings.reshape(1, -1)

    if embeddings.shape[0] < 2:
        # Not enough points for projection
        return np.zeros((embeddings.shape[0], dimensions))

    if method == "pca":
        return _pca_project(embeddings, dimensions)
    elif method == "umap":
        return _umap_project(embeddings, dimensions)
    else:
        raise ValueError(f"Unknown projection method: {method}")


def _pca_project(embeddings: np.ndarray, dimensions: int) -> np.ndarray:
    """Fast PCA projection"""
    n_components = min(dimensions, embeddings.shape[0], embeddings.shape[1])

    # Use cached projector if dimensions match
    cache_key = (embeddings.shape[1], dimensions)

    if cache_key not in _projector_cache:
        _projector_cache[cache_key] = PCA(n_components=n_components)

    pca = _projector_cache[cache_key]

    # Fit and transform
    try:
        projected = pca.fit_transform(embeddings)
    except Exception:
        # Fallback to just taking first N dimensions
        projected = embeddings[:, :dimensions]

    # Normalize to [-1, 1] range for visualization
    if projected.max() != projected.min():
        projected = 2 * (projected - projected.min()) / (projected.max() - projected.min()) - 1

    return projected


def _umap_project(embeddings: np.ndarray, dimensions: int) -> np.ndarray:
    """UMAP projection (slower but better for structure preservation)"""
    try:
        import umap
    except ImportError:
        print("UMAP not available, falling back to PCA")
        return _pca_project(embeddings, dimensions)

    n_neighbors = min(15, embeddings.shape[0] - 1)
    if n_neighbors < 2:
        return _pca_project(embeddings, dimensions)

    reducer = umap.UMAP(
        n_components=dimensions,
        n_neighbors=n_neighbors,
        min_dist=0.1,
        metric="cosine"
    )

    try:
        projected = reducer.fit_transform(embeddings)
    except Exception:
        return _pca_project(embeddings, dimensions)

    # Normalize to [-1, 1] range
    if projected.max() != projected.min():
        projected = 2 * (projected - projected.min()) / (projected.max() - projected.min()) - 1

    return projected


def compute_token_similarity(embeddings: np.ndarray) -> np.ndarray:
    """
    Compute cosine similarity matrix between token embeddings.

    Args:
        embeddings: [seq_len, hidden_dim] embedding matrix

    Returns:
        [seq_len, seq_len] similarity matrix
    """
    embeddings = np.array(embeddings, dtype=np.float32)

    # Normalize embeddings
    norms = np.linalg.norm(embeddings, axis=1, keepdims=True)
    norms = np.maximum(norms, 1e-8)  # Avoid division by zero
    normalized = embeddings / norms

    # Compute cosine similarity
    similarity = np.dot(normalized, normalized.T)

    return similarity

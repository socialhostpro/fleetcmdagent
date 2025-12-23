"""
Base extractor interface for LLM attention/embedding extraction
"""

from abc import ABC, abstractmethod
from typing import AsyncIterator, Dict, Any


class BaseExtractor(ABC):
    """Abstract base class for LLM extractors"""

    def __init__(self, backend_url: str):
        self.backend_url = backend_url

    @abstractmethod
    async def stream_with_attention(
        self,
        prompt: str,
        model: str,
        extract_attention: bool = True,
        extract_embeddings: bool = True
    ) -> AsyncIterator[Dict[str, Any]]:
        """
        Stream LLM generation while extracting attention patterns.

        Yields snapshots containing:
        - tokens: List of generated tokens with metadata
        - attention_heads: Attention weights per layer/head
        - embeddings: Hidden state embeddings (optional)
        - performance: Timing and throughput metrics
        """
        pass

    @abstractmethod
    async def get_models(self) -> list:
        """List available models on this backend"""
        pass

    @abstractmethod
    async def health_check(self) -> bool:
        """Check if backend is available"""
        pass

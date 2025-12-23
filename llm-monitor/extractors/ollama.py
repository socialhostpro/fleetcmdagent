"""
Ollama extractor with GPT-2 proxy for attention visualization

Since Ollama doesn't expose internal attention weights, we use GPT-2
as a proxy model to generate attention patterns that approximate
the transformer's behavior on the same input.
"""

import time
from typing import AsyncIterator, Dict, Any, List, Optional

import httpx
import numpy as np
import torch
from transformers import GPT2LMHeadModel, GPT2Tokenizer

from .base import BaseExtractor
from utils.compression import compress_attention


class OllamaExtractor(BaseExtractor):
    """
    Extracts attention patterns using GPT-2 proxy while
    streaming actual responses from Ollama.
    """

    def __init__(
        self,
        backend_url: str,
        gpt2_model: GPT2LMHeadModel,
        gpt2_tokenizer: GPT2Tokenizer
    ):
        super().__init__(backend_url)
        self.gpt2_model = gpt2_model
        self.gpt2_tokenizer = gpt2_tokenizer
        self.device = next(gpt2_model.parameters()).device

    async def health_check(self) -> bool:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                resp = await client.get(f"{self.backend_url}/api/tags")
                return resp.status_code == 200
        except Exception:
            return False

    async def get_models(self) -> list:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                resp = await client.get(f"{self.backend_url}/api/tags")
                if resp.status_code == 200:
                    return [m["name"] for m in resp.json().get("models", [])]
        except Exception:
            pass
        return []

    def _extract_gpt2_attention(self, text: str) -> Dict[str, Any]:
        """
        Run GPT-2 on text and extract attention patterns.
        Returns attention weights for all layers and heads.
        """
        # Tokenize
        inputs = self.gpt2_tokenizer(
            text,
            return_tensors="pt",
            truncation=True,
            max_length=512
        ).to(self.device)

        token_ids = inputs["input_ids"][0].tolist()
        tokens = [self.gpt2_tokenizer.decode([tid]) for tid in token_ids]

        # Forward pass with attention output
        with torch.no_grad():
            outputs = self.gpt2_model(
                **inputs,
                output_attentions=True,
                output_hidden_states=True
            )

        # Extract attention weights
        # Shape: (num_layers, batch, num_heads, seq_len, seq_len)
        attentions = outputs.attentions
        hidden_states = outputs.hidden_states

        attention_heads = []
        for layer_idx, layer_attn in enumerate(attentions):
            # layer_attn shape: (batch, num_heads, seq_len, seq_len)
            layer_attn = layer_attn[0].cpu().numpy()  # Remove batch dim

            for head_idx in range(layer_attn.shape[0]):
                head_weights = layer_attn[head_idx]
                # Compress sparse attention matrix
                compressed = compress_attention(head_weights)
                attention_heads.append({
                    "layer": layer_idx,
                    "head": head_idx,
                    "weights": compressed
                })

        # Extract embeddings from last hidden state
        embeddings = hidden_states[-1][0].cpu().numpy().tolist()

        # Build token data
        token_data = [
            {
                "token_id": tid,
                "token": tok,
                "position": i
            }
            for i, (tid, tok) in enumerate(zip(token_ids, tokens))
        ]

        return {
            "tokens": token_data,
            "attention_heads": attention_heads,
            "embeddings": embeddings,
            "num_layers": len(attentions),
            "num_heads": attentions[0].shape[1] if attentions else 0
        }

    async def stream_with_attention(
        self,
        prompt: str,
        model: str,
        extract_attention: bool = True,
        extract_embeddings: bool = True
    ) -> AsyncIterator[Dict[str, Any]]:
        """
        Stream Ollama generation while extracting GPT-2 attention.

        Yields snapshots at each token with:
        - Current generated text
        - Attention patterns from GPT-2 proxy
        - Performance metrics
        """
        start_time = time.time()
        generated_text = ""
        token_count = 0

        # Initial attention on prompt
        if extract_attention:
            prompt_attention = self._extract_gpt2_attention(prompt)
            yield {
                "type": "prompt",
                "text": prompt,
                "tokens": prompt_attention["tokens"],
                "attention_heads": prompt_attention["attention_heads"] if extract_attention else [],
                "embeddings": prompt_attention["embeddings"] if extract_embeddings else [],
                "num_layers": prompt_attention["num_layers"],
                "num_heads": prompt_attention["num_heads"],
                "timestamp": time.time()
            }

        # Stream from Ollama
        async with httpx.AsyncClient(timeout=120.0) as client:
            async with client.stream(
                "POST",
                f"{self.backend_url}/api/generate",
                json={
                    "model": model,
                    "prompt": prompt,
                    "stream": True
                }
            ) as response:
                async for line in response.aiter_lines():
                    if not line:
                        continue

                    try:
                        import json
                        data = json.loads(line)
                    except Exception:
                        continue

                    if "response" in data:
                        token = data["response"]
                        generated_text += token
                        token_count += 1

                        # Extract attention periodically (every 5 tokens to reduce overhead)
                        if extract_attention and token_count % 5 == 0:
                            full_text = prompt + generated_text
                            attention_data = self._extract_gpt2_attention(full_text)

                            elapsed = time.time() - start_time
                            yield {
                                "type": "generation",
                                "text": generated_text,
                                "tokens": attention_data["tokens"],
                                "attention_heads": attention_data["attention_heads"],
                                "embeddings": attention_data["embeddings"] if extract_embeddings else [],
                                "current_position": len(attention_data["tokens"]) - 1,
                                "total_tokens": token_count,
                                "generation_time": elapsed,
                                "tokens_per_second": token_count / max(elapsed, 0.001),
                                "timestamp": time.time()
                            }

                    if data.get("done", False):
                        break

        # Final snapshot
        elapsed = time.time() - start_time
        full_text = prompt + generated_text

        if extract_attention:
            final_attention = self._extract_gpt2_attention(full_text)
        else:
            final_attention = {"tokens": [], "attention_heads": [], "embeddings": []}

        yield {
            "type": "complete",
            "text": generated_text,
            "tokens": final_attention["tokens"],
            "attention_heads": final_attention["attention_heads"],
            "embeddings": final_attention["embeddings"] if extract_embeddings else [],
            "total_tokens": token_count,
            "generation_time": elapsed,
            "tokens_per_second": token_count / max(elapsed, 0.001),
            "status": "completed",
            "timestamp": time.time()
        }

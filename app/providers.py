"""Embedding and chat providers. Requests are sent directly; nothing is cached."""
from __future__ import annotations

import asyncio
import hashlib
import json
import re
from typing import AsyncIterator

import httpx
import numpy as np

from .config import Settings


class ProviderError(RuntimeError):
    pass


def _normalise(mat: np.ndarray) -> np.ndarray:
    mat = np.asarray(mat, dtype=np.float32)
    if mat.ndim == 1:
        mat = mat[None, :]
    norms = np.linalg.norm(mat, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return mat / norms


# ---------------------------------------------------------------- embeddings

class Embedder:
    batch_size = 32

    def __init__(self, settings: Settings, client: httpx.AsyncClient):
        self.s = settings
        self.client = client

    async def embed(self, texts: list[str]) -> np.ndarray:
        out = []
        for i in range(0, len(texts), self.batch_size):
            out.append(await self._embed_batch(texts[i:i + self.batch_size]))
        return _normalise(np.vstack(out))

    async def _embed_batch(self, texts: list[str]) -> np.ndarray:
        p = self.s.embed_provider
        if p == "hash":
            return _hash_embed(texts)
        if p == "ollama":
            r = await self._post(f"{self.s.ollama_url}/api/embed",
                                 {"model": self.s.embed_model, "input": texts})
            return np.array(r["embeddings"], dtype=np.float32)
        if p == "openai":
            r = await self._post(f"{self.s.openai_url}/embeddings",
                                 {"model": self.s.embed_model, "input": texts},
                                 headers={"Authorization": f"Bearer {self.s.openai_key}"})
            data = sorted(r["data"], key=lambda d: d["index"])
            return np.array([d["embedding"] for d in data], dtype=np.float32)
        raise ProviderError(f"Unknown EMBED_PROVIDER '{p}'.")

    async def _post(self, url: str, body: dict, headers: dict | None = None) -> dict:
        try:
            r = await self.client.post(url, json=body, headers=headers, timeout=120)
        except httpx.HTTPError as exc:
            raise ProviderError(f"Embedding service unreachable ({type(exc).__name__}).") from exc
        if r.status_code >= 400:
            raise ProviderError(f"Embedding service returned HTTP {r.status_code}.")
        return r.json()


_TOKEN = re.compile(r"[a-z0-9À-ɏ؀-ۿ]+")


def _hash_embed(texts: list[str], dim: int = 512) -> np.ndarray:
    """Offline fallback: hashed bag-of-words. Keyword matching only, no semantics."""
    mat = np.zeros((len(texts), dim), dtype=np.float32)
    for row, t in enumerate(texts):
        for tok in _TOKEN.findall(t.lower()):
            h = int.from_bytes(hashlib.blake2b(tok.encode(), digest_size=4).digest(), "little")
            mat[row, h % dim] += 1.0
    return mat


# ---------------------------------------------------------------- chat

class ChatModel:
    def __init__(self, settings: Settings, client: httpx.AsyncClient):
        self.s = settings
        self.client = client

    async def stream(self, system: str, messages: list[dict]) -> AsyncIterator[str]:
        p = self.s.llm_provider
        if p == "echo":
            async for t in self._echo(system, messages):
                yield t
        elif p == "ollama":
            async for t in self._ollama(system, messages):
                yield t
        elif p == "openai":
            async for t in self._openai(system, messages):
                yield t
        elif p == "anthropic":
            async for t in self._anthropic(system, messages):
                yield t
        else:
            raise ProviderError(f"Unknown LLM_PROVIDER '{p}'.")

    async def _lines(self, url: str, body: dict, headers: dict | None = None) -> AsyncIterator[str]:
        try:
            async with self.client.stream("POST", url, json=body, headers=headers, timeout=300) as r:
                if r.status_code >= 400:
                    await r.aread()
                    raise ProviderError(f"Model service returned HTTP {r.status_code}.")
                async for line in r.aiter_lines():
                    if line:
                        yield line
        except httpx.HTTPError as exc:
            raise ProviderError(f"Model service unreachable ({type(exc).__name__}).") from exc

    async def _ollama(self, system, messages):
        body = {"model": self.s.llm_model, "stream": True,
                "options": {"num_ctx": self.s.ollama_num_ctx},
                "messages": [{"role": "system", "content": system}, *messages]}
        async for line in self._lines(f"{self.s.ollama_url}/api/chat", body):
            data = json.loads(line)
            if data.get("error"):
                raise ProviderError("Model error: " + str(data["error"])[:200])
            piece = (data.get("message") or {}).get("content")
            if piece:
                yield piece

    async def _openai(self, system, messages):
        body = {"model": self.s.llm_model, "stream": True,
                "messages": [{"role": "system", "content": system}, *messages]}
        headers = {"Authorization": f"Bearer {self.s.openai_key}"}
        async for line in self._lines(f"{self.s.openai_url}/chat/completions", body, headers):
            if not line.startswith("data:"):
                continue
            payload = line[5:].strip()
            if payload == "[DONE]":
                break
            data = json.loads(payload)
            choices = data.get("choices") or []
            piece = choices[0].get("delta", {}).get("content") if choices else None
            if piece:
                yield piece

    async def _anthropic(self, system, messages):
        body = {"model": self.s.llm_model, "max_tokens": 4096, "stream": True,
                "system": system, "messages": messages}
        headers = {"x-api-key": self.s.anthropic_key, "anthropic-version": "2023-06-01"}
        async for line in self._lines(f"{self.s.anthropic_url}/v1/messages", body, headers):
            if not line.startswith("data:"):
                continue
            data = json.loads(line[5:].strip())
            if data.get("type") == "content_block_delta":
                piece = (data.get("delta") or {}).get("text")
                if piece:
                    yield piece
            elif data.get("type") == "error":
                raise ProviderError("Model error: " + str(data.get("error"))[:200])

    async def _echo(self, system, messages):
        """Offline stub for tests and UI demos: reports what it was given."""
        last = messages[-1]["content"] if messages else ""
        n_sources = last.count("<source id=")
        question = last.rsplit("My request: ", 1)[-1]
        for word in f"[echo] {n_sources} source(s) retrieved. Last message: {question}".split(" "):
            await asyncio.sleep(0.03)  # stream like a real model, so Stop can be tried
            yield word + " "

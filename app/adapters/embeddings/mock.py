"""Deterministic embedding mock: the same text always gives the same unit vector."""

import hashlib
import math
from dataclasses import dataclass

from app.adapters.embeddings.base import EmbeddingProvider
from app.db.models import EMBEDDING_DIM


@dataclass
class MockEmbeddingProvider(EmbeddingProvider):
    dimensions: int = EMBEDDING_DIM

    def _vector(self, text: str) -> list[float]:
        values: list[float] = []
        block = 0
        while len(values) < self.dimensions:
            digest = hashlib.sha256(f"{block}:{text}".encode()).digest()
            values.extend((b - 127.5) / 127.5 for b in digest)
            block += 1
        values = values[: self.dimensions]
        norm = math.sqrt(sum(v * v for v in values))
        return [v / norm for v in values]

    async def embed(self, texts: list[str]) -> list[list[float]]:
        return [self._vector(t) for t in texts]

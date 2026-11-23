"""Embedding provider interface (for pgvector)."""

from abc import ABC, abstractmethod


class EmbeddingProvider(ABC):
    dimensions: int

    @abstractmethod
    async def embed(self, texts: list[str]) -> list[list[float]]: ...

"""Embeddings through the OpenAI-compatible API (for example Ollama `mxbai-embed-large`).

The database columns have EMBEDDING_DIM (1024) dimensions. A model with another size
gives a clear error.
"""

import httpx

from app.adapters.embeddings.base import EmbeddingProvider
from app.db.models import EMBEDDING_DIM


class EmbeddingError(Exception):
    pass


class OpenAICompatEmbeddingProvider(EmbeddingProvider):
    def __init__(self, *, base_url: str, api_key: str, model: str, http: httpx.AsyncClient) -> None:
        self.dimensions = EMBEDDING_DIM
        self._url = f"{base_url.rstrip('/')}/embeddings"
        self._headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
        self._model = model
        self._http = http

    async def embed(self, texts: list[str]) -> list[list[float]]:
        try:
            response = await self._http.post(
                self._url, json={"model": self._model, "input": texts}, headers=self._headers
            )
        except httpx.HTTPError as exc:
            raise EmbeddingError(f"Embedding API not reachable: {exc!r}") from exc
        if response.is_error:
            raise EmbeddingError(f"Embedding API error: HTTP {response.status_code}")
        try:
            rows = sorted(response.json()["data"], key=lambda r: r["index"])
            vectors = [list(map(float, r["embedding"])) for r in rows]
        except (ValueError, KeyError, TypeError) as exc:
            raise EmbeddingError("Embedding API response is not valid") from exc
        if any(len(v) != self.dimensions for v in vectors):
            raise EmbeddingError(
                f"The model {self._model!r} gives {len(vectors[0])} dimensions; "
                f"the database needs {self.dimensions}. Use a 1024-dimension model "
                "(for example mxbai-embed-large) or EMBEDDING_PROVIDER=mock."
            )
        return vectors

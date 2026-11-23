"""LLM wrapper that records each call of one turn (web test channel only)."""

import time
from typing import Any

from app.adapters.llm.base import LLMProvider, LLMRequest, LLMResponse

TEXT_LIMIT = 4000


class TracingLLM(LLMProvider):
    def __init__(self, inner: LLMProvider, fast_model: str) -> None:
        self._inner = inner
        self._fast_model = fast_model
        self.calls: list[dict[str, Any]] = []

    async def complete(self, request: LLMRequest) -> LLMResponse:
        started = time.perf_counter()
        response = await self._inner.complete(request)
        self.calls.append(
            {
                # In a turn, only the main model gets tools. The model names can be equal
                # (one local model for both tiers), so the name alone is not enough.
                "tier": "main" if request.tools else "fast",
                "model": request.model,
                "seconds": round(time.perf_counter() - started, 2),
                "input_tokens": response.usage.input_tokens,
                "output_tokens": response.usage.output_tokens,
                "text": response.text[:TEXT_LIMIT],
                "tool_calls": [
                    {"name": c.name, "arguments": c.arguments} for c in response.tool_calls
                ],
            }
        )
        return response

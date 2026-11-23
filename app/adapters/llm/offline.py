"""Offline model for the local stack when no model is configured (LLM_PROVIDER=mock).

It does not understand text. The classifier gets neutral signals, and the reply repeats
the client message. With it you can check the flow (queue, delays, traces, operator chat)
without any model. Use LLM_PROVIDER=openai_compat (Ollama) to test real answers.
"""

import json

from app.adapters.llm.base import LLMProvider, LLMRequest, LLMResponse

NEUTRAL = {
    "language": "en",
    "topic": "products_orders",
    "asks_for_human": False,
    "harsh_sentiment": False,
    "confidence": 1.0,
    "confirmation": "none",
    "funnel_stage": None,
}


class OfflineLLMProvider(LLMProvider):
    def __init__(self, fast_model: str) -> None:
        self._fast_model = fast_model

    async def complete(self, request: LLMRequest) -> LLMResponse:
        if request.model == self._fast_model:
            if "classify" in request.system:
                return LLMResponse(text=json.dumps(NEUTRAL))
            return LLMResponse(text="[offline model] No summary.")
        last = next((m.content for m in reversed(request.messages) if m.role == "user"), "")
        return LLMResponse(text=f"[offline model] You wrote: {last}")

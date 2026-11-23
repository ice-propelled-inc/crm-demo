"""LLM provider for the OpenAI-compatible chat API.

Works with local Ollama (`http://localhost:11434/v1`), the Google Gemini OpenAI-compatible
endpoint and Groq. These are for tests without a paid API. The production model
(Claude Sonnet 5.5) gets its own provider in build step 11.
"""

import json
import re
from typing import Any

import httpx

from app.adapters.llm.base import (
    ChatMessage,
    LLMProvider,
    LLMRequest,
    LLMResponse,
    ToolCall,
    Usage,
)

_THINK = re.compile(r"<think>.*?</think>", re.DOTALL)


class LLMError(Exception):
    """The LLM API returned an error or an unexpected response."""


def _message(m: ChatMessage) -> dict[str, Any]:
    if m.role == "tool":
        return {"role": "tool", "tool_call_id": m.tool_call_id, "content": m.content}
    if m.role == "assistant" and m.tool_calls:
        return {
            "role": "assistant",
            "content": m.content or None,
            "tool_calls": [
                {
                    "id": c.id,
                    "type": "function",
                    "function": {"name": c.name, "arguments": json.dumps(c.arguments)},
                }
                for c in m.tool_calls
            ],
        }
    return {"role": m.role, "content": m.content}


def _arguments(raw: object) -> dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    try:
        parsed = json.loads(str(raw or "{}"))
    except ValueError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


class OpenAICompatProvider(LLMProvider):
    def __init__(
        self,
        *,
        base_url: str,
        api_key: str,
        http: httpx.AsyncClient,
        reasoning_effort: str = "",
    ) -> None:
        self._url = f"{base_url.rstrip('/')}/chat/completions"
        # "none" switches off the thinking of models such as qwen3 (5x faster on a CPU).
        self._reasoning_effort = reasoning_effort
        self._headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
        self._http = http

    async def complete(self, request: LLMRequest) -> LLMResponse:
        body: dict[str, Any] = {
            "model": request.model,
            "messages": [
                {"role": "system", "content": request.system},
                *(_message(m) for m in request.messages),
            ],
            "max_tokens": request.max_tokens,
        }
        if self._reasoning_effort:
            body["reasoning_effort"] = self._reasoning_effort
        if request.tools:
            body["tools"] = [
                {
                    "type": "function",
                    "function": {
                        "name": t.name,
                        "description": t.description,
                        "parameters": t.input_schema,
                    },
                }
                for t in request.tools
            ]
        try:
            response = await self._http.post(self._url, json=body, headers=self._headers)
        except httpx.HTTPError as exc:
            raise LLMError(f"LLM API not reachable: {exc!r}") from exc
        if response.is_error:
            raise LLMError(f"LLM API error: HTTP {response.status_code}: {response.text[:300]}")
        try:
            data = response.json()
            choice = data["choices"][0]
            message = choice["message"]
        except (ValueError, KeyError, IndexError) as exc:
            raise LLMError("LLM API response is not valid") from exc

        calls = tuple(
            ToolCall(
                id=str(c.get("id") or f"call_{i}"),
                name=c["function"]["name"],
                arguments=_arguments(c["function"].get("arguments")),
            )
            for i, c in enumerate(message.get("tool_calls") or [])
        )
        text = _THINK.sub("", message.get("content") or "").strip()
        usage = data.get("usage") or {}
        return LLMResponse(
            text=text,
            tool_calls=calls,
            stop_reason=str(choice.get("finish_reason") or "stop"),
            usage=Usage(
                input_tokens=int(usage.get("prompt_tokens") or 0),
                output_tokens=int(usage.get("completion_tokens") or 0),
            ),
        )

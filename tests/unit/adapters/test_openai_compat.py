"""OpenAI-compatible LLM and embedding providers (Ollama, Gemini, Groq), HTTP mocked."""

import json

import httpx
import pytest

from app.adapters.embeddings.openai_compat import EmbeddingError, OpenAICompatEmbeddingProvider
from app.adapters.llm.base import ChatMessage, LLMRequest, ToolCall, ToolSpec
from app.adapters.llm.openai_compat import LLMError, OpenAICompatProvider
from app.agent.tracing import TracingLLM
from app.runtime import build_deps
from app.settings import Settings


def client(handler: httpx.MockTransport) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=handler)


REQUEST = LLMRequest(
    model="qwen3:8b",
    system="SYS",
    messages=[
        ChatMessage("user", "pizza?"),
        ChatMessage(
            "assistant", "", tool_calls=(ToolCall("c1", "search_catalog", {"query": "pizza"}),)
        ),
        ChatMessage("tool", '{"items": []}', tool_call_id="c1"),
    ],
    tools=[ToolSpec("search_catalog", "Search", {"type": "object"})],
)


async def test_request_mapping_and_tool_calls() -> None:
    seen: list[dict[str, object]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(json.loads(request.content))
        assert request.headers.get("authorization") is None  # no key: Ollama
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "finish_reason": "tool_calls",
                        "message": {
                            "content": "<think>let me look</think>",
                            "tool_calls": [
                                {
                                    "id": "x1",
                                    "function": {
                                        "name": "create_order",
                                        "arguments": '{"lines": []}',
                                    },
                                },
                                {"function": {"name": "get_order_status", "arguments": "not json"}},
                                {
                                    "id": "x3",
                                    "function": {
                                        "name": "request_human",
                                        "arguments": {"reason": "r"},
                                    },
                                },
                            ],
                        },
                    }
                ],
                "usage": {"prompt_tokens": 12, "completion_tokens": 5},
            },
        )

    llm = OpenAICompatProvider(
        base_url="http://ollama:11434/v1/", api_key="", http=client(httpx.MockTransport(handler))
    )
    response = await llm.complete(REQUEST)
    body = seen[0]
    assert body["messages"][0] == {"role": "system", "content": "SYS"}  # type: ignore[index]
    assert body["messages"][2]["tool_calls"][0]["function"]["arguments"] == '{"query": "pizza"}'  # type: ignore[index]
    assert body["messages"][3] == {"role": "tool", "tool_call_id": "c1", "content": '{"items": []}'}  # type: ignore[index]
    assert body["tools"][0]["function"]["name"] == "search_catalog"  # type: ignore[index]
    assert response.text == ""  # the <think> block is removed
    assert [c.name for c in response.tool_calls] == [
        "create_order",
        "get_order_status",
        "request_human",
    ]
    assert response.tool_calls[1].arguments == {} and response.tool_calls[1].id == "call_1"
    assert response.tool_calls[2].arguments == {"reason": "r"}
    assert (response.usage.input_tokens, response.usage.output_tokens) == (12, 5)


async def test_api_key_and_errors() -> None:
    def ok(request: httpx.Request) -> httpx.Response:
        assert request.headers["authorization"] == "Bearer k"
        return httpx.Response(200, json={"choices": [{"message": {"content": "Hi"}}]})

    llm = OpenAICompatProvider(
        base_url="http://x", api_key="k", http=client(httpx.MockTransport(ok))
    )
    plain = await llm.complete(LLMRequest(model="m", system="s", messages=[]))
    assert (plain.text, plain.stop_reason) == ("Hi", "stop")

    bodies: list[dict[str, object]] = []

    def capture(request: httpx.Request) -> httpx.Response:
        bodies.append(json.loads(request.content))
        return httpx.Response(200, json={"choices": [{"message": {"content": "x"}}]})

    quick = OpenAICompatProvider(
        base_url="http://x",
        api_key="",
        http=client(httpx.MockTransport(capture)),
        reasoning_effort="none",
    )
    await quick.complete(LLMRequest(model="m", system="s", messages=[]))
    assert bodies[0]["reasoning_effort"] == "none"
    assert "reasoning_effort" not in json.loads(json.dumps(REQUEST.__dict__, default=str))

    for handler in (
        lambda _r: httpx.Response(429, text="rate limit"),
        lambda _r: httpx.Response(200, json={"nope": 1}),
    ):
        failing = OpenAICompatProvider(
            base_url="http://x", api_key="", http=client(httpx.MockTransport(handler))
        )
        with pytest.raises(LLMError):
            await failing.complete(LLMRequest(model="m", system="s", messages=[]))

    def down(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    with pytest.raises(LLMError, match="not reachable"):
        await OpenAICompatProvider(
            base_url="http://x", api_key="", http=client(httpx.MockTransport(down))
        ).complete(LLMRequest(model="m", system="s", messages=[]))


async def test_embeddings() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        texts = json.loads(request.content)["input"]
        size = 1024 if texts[0] != "small" else 768
        data = [{"index": i, "embedding": [0.1] * size} for i in reversed(range(len(texts)))]
        return httpx.Response(200, json={"data": data})

    embedder = OpenAICompatEmbeddingProvider(
        base_url="http://x/v1",
        api_key="",
        model="mxbai-embed-large",
        http=client(httpx.MockTransport(handler)),
    )
    vectors = await embedder.embed(["a", "b"])
    assert len(vectors) == 2 and len(vectors[0]) == 1024
    with pytest.raises(EmbeddingError, match="1024"):
        await embedder.embed(["small"])
    broken = OpenAICompatEmbeddingProvider(
        base_url="http://x",
        api_key="k",
        model="m",
        http=client(httpx.MockTransport(lambda _r: httpx.Response(500))),
    )
    with pytest.raises(EmbeddingError):
        await broken.embed(["a"])
    bad_body = OpenAICompatEmbeddingProvider(
        base_url="http://x",
        api_key="",
        model="m",
        http=client(httpx.MockTransport(lambda _r: httpx.Response(200, json={}))),
    )
    with pytest.raises(EmbeddingError):
        await bad_body.embed(["a"])


async def test_tracing_llm_records_calls() -> None:
    from app.adapters.llm.base import LLMResponse
    from app.adapters.llm.mock import MockLLMProvider

    inner = MockLLMProvider()
    inner.queue(LLMResponse(text="ok", tool_calls=(ToolCall("1", "t", {"a": 1}),)))
    tracer = TracingLLM(inner, fast_model="fast")
    await tracer.complete(LLMRequest(model="fast", system="s", messages=[]))
    [call] = tracer.calls
    assert (call["tier"], call["text"], call["tool_calls"]) == (
        "fast",
        "ok",
        [{"name": "t", "arguments": {"a": 1}}],
    )


def test_build_deps_free_providers() -> None:
    deps = build_deps(Settings(llm_provider="openai_compat", embedding_provider="openai_compat"))
    assert type(deps.llm).__name__ == "OpenAICompatProvider"
    assert type(deps.embedder).__name__ == "OpenAICompatEmbeddingProvider"


async def test_offline_model() -> None:
    from app.adapters.llm.offline import OfflineLLMProvider

    llm = OfflineLLMProvider("fast")
    signals = await llm.complete(LLMRequest(model="fast", system="You classify one", messages=[]))
    assert json.loads(signals.text)["confidence"] == 1.0
    summary = await llm.complete(LLMRequest(model="fast", system="Summarise", messages=[]))
    assert "No summary" in summary.text
    answer = await llm.complete(
        LLMRequest(model="main", system="s", messages=[ChatMessage("user", "hi")])
    )
    assert answer.text == "[offline model] You wrote: hi"
    assert type(build_deps(Settings()).llm).__name__ == "OfflineLLMProvider"

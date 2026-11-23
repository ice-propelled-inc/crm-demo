"""Scripted LLM mock. Tests queue the responses, so results are deterministic."""

from collections import deque
from dataclasses import dataclass, field

from app.adapters.llm.base import LLMProvider, LLMRequest, LLMResponse


class ScriptExhaustedError(AssertionError):
    """The test asked the mock for more responses than it scripted."""


@dataclass
class MockLLMProvider(LLMProvider):
    script: deque[LLMResponse] = field(default_factory=deque)
    requests: list[LLMRequest] = field(default_factory=list)

    def queue(self, *responses: LLMResponse) -> None:
        self.script.extend(responses)

    async def complete(self, request: LLMRequest) -> LLMResponse:
        self.requests.append(request)
        if not self.script:
            raise ScriptExhaustedError("MockLLMProvider has no scripted response left")
        return self.script.popleft()

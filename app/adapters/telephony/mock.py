"""In-process telephony mock: records calls."""

from dataclasses import dataclass, field
from itertools import count

from app.adapters.telephony.base import TelephonyClient, TelephonyError


@dataclass(frozen=True)
class PlacedCall:
    to: str
    text: str
    language: str


@dataclass
class MockTelephonyClient(TelephonyClient):
    calls: list[PlacedCall] = field(default_factory=list)
    failing_numbers: set[str] = field(default_factory=set)
    _ids: count[int] = field(default_factory=lambda: count(1))

    async def call_with_tts(self, *, to: str, text: str, language: str = "en") -> str:
        if to in self.failing_numbers:
            raise TelephonyError(f"cannot call {to}")
        self.calls.append(PlacedCall(to, text, language))
        return f"CA-mock-{next(self._ids)}"

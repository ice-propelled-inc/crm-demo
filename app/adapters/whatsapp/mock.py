"""In-process WhatsApp mock: records template messages."""

from dataclasses import dataclass, field
from itertools import count

from app.adapters.whatsapp.base import WhatsAppClient, WhatsAppError


@dataclass(frozen=True)
class SentTemplate:
    to: str
    template_name: str
    language: str
    parameters: list[str]


@dataclass
class MockWhatsAppClient(WhatsAppClient):
    sent: list[SentTemplate] = field(default_factory=list)
    failing_numbers: set[str] = field(default_factory=set)
    _ids: count[int] = field(default_factory=lambda: count(1))

    async def send_template(
        self, *, to: str, template_name: str, language: str, parameters: list[str]
    ) -> str:
        if to in self.failing_numbers:
            raise WhatsAppError(f"cannot deliver to {to}")
        self.sent.append(SentTemplate(to, template_name, language, list(parameters)))
        return f"wamid.mock-{next(self._ids)}"

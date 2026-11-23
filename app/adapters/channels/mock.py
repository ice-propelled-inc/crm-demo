"""In-process channel mock. It records sends and can simulate a closed window."""

import json
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime
from itertools import count

from app.adapters.channels.base import (
    ChannelAdapter,
    DeliveryResult,
    InboundMessage,
    InvalidChannelWebhook,
)
from app.domain.types import ChannelKind


@dataclass
class SentMessage:
    client_ref: str
    text: str
    human_agent: bool


@dataclass
class MockChannelAdapter(ChannelAdapter):
    kind: ChannelKind = ChannelKind.JIVO
    supports_typing: bool = True
    sent: list[SentMessage] = field(default_factory=list)
    typing: list[tuple[str, bool]] = field(default_factory=list)
    closed_clients: set[str] = field(default_factory=set)
    _ids: count[int] = field(default_factory=lambda: count(1))

    def parse_webhook(self, headers: Mapping[str, str], body: bytes) -> list[InboundMessage]:
        try:
            data = json.loads(body)
            return [
                InboundMessage(
                    channel=self.kind,
                    client_ref=data["client_ref"],
                    text=data["text"],
                    provider_message_id=data["message_id"],
                    received_at=datetime.fromisoformat(data["received_at"]),
                    display_name=data.get("name"),
                )
            ]
        except (ValueError, KeyError) as exc:
            raise InvalidChannelWebhook("bad mock webhook") from exc

    async def send_message(
        self, client_ref: str, text: str, *, human_agent: bool = False
    ) -> DeliveryResult:
        if client_ref in self.closed_clients:
            return DeliveryResult(delivered=False, reason="window_closed")
        self.sent.append(SentMessage(client_ref, text, human_agent))
        return DeliveryResult(delivered=True, provider_message_id=f"mock-{next(self._ids)}")

    async def set_typing(self, client_ref: str, on: bool) -> None:
        self.typing.append((client_ref, on))

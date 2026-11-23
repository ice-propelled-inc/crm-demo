"""Web test channel: the admin panel "Test chat" plays the client.

Messages stay in the module database. Nothing is sent to an outside service.
"""

import uuid
from collections.abc import Mapping

from app.adapters.channels.base import (
    ChannelAdapter,
    DeliveryResult,
    InboundMessage,
    InvalidChannelWebhook,
)
from app.domain.types import ChannelKind


class WebTestChannelAdapter(ChannelAdapter):
    kind = ChannelKind.TEST
    supports_typing = False  # the test page shows "typing..." from the queued reply

    def parse_webhook(self, headers: Mapping[str, str], body: bytes) -> list[InboundMessage]:
        raise InvalidChannelWebhook("The test channel has no webhook")

    async def send_message(
        self,
        client_ref: str,
        text: str,
        *,
        thread_ref: str | None = None,
        human_agent: bool = False,
    ) -> DeliveryResult:
        return DeliveryResult(delivered=True, provider_message_id=f"test-{uuid.uuid4().hex[:12]}")

    async def set_typing(self, client_ref: str, on: bool, *, thread_ref: str | None = None) -> None:
        return None

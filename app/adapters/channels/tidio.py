"""Tidio adapter: NOT SUPPORTED at this time.

The public Tidio API (developers.tidio.com, checked 2026-11) has no webhook for a
visitor message in live chat, and no endpoint to send a bot or operator reply into a
live-chat conversation. Only tickets have a reply endpoint. Thus a bot cannot run a
live-chat dialog through the API. This stub keeps the interface; each call fails clearly.
"""

from collections.abc import Mapping

from app.adapters.channels.base import (
    ChannelAdapter,
    ChannelNotSupportedError,
    DeliveryResult,
    InboundMessage,
)
from app.domain.types import ChannelKind

REASON = "The Tidio API has no live-chat message webhook and no live-chat reply endpoint."


class TidioAdapter(ChannelAdapter):
    kind = ChannelKind.TIDIO
    supports_typing = False

    def parse_webhook(self, headers: Mapping[str, str], body: bytes) -> list[InboundMessage]:
        raise ChannelNotSupportedError(REASON)

    async def send_message(
        self,
        client_ref: str,
        text: str,
        *,
        thread_ref: str | None = None,
        human_agent: bool = False,
    ) -> DeliveryResult:
        raise ChannelNotSupportedError(REASON)

    async def set_typing(self, client_ref: str, on: bool, *, thread_ref: str | None = None) -> None:
        raise ChannelNotSupportedError(REASON)

"""Channel adapter interface (Instagram, Jivo, Tidio)."""

from abc import ABC, abstractmethod
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime

from app.domain.types import ChannelKind


class InvalidChannelWebhook(Exception):  # noqa: N818 - domain name
    """The webhook signature or body is not valid."""


@dataclass(frozen=True)
class InboundMessage:
    channel: ChannelKind
    client_ref: str  # the client ID in the channel
    text: str
    provider_message_id: str
    received_at: datetime
    display_name: str | None = None


@dataclass(frozen=True)
class DeliveryResult:
    delivered: bool
    provider_message_id: str | None = None
    reason: str | None = None  # for example "window_closed", "visitor_offline"


class ChannelAdapter(ABC):
    kind: ChannelKind
    supports_typing: bool

    @abstractmethod
    def parse_webhook(self, headers: Mapping[str, str], body: bytes) -> list[InboundMessage]:
        """Verify and normalize an incoming webhook. Raises InvalidChannelWebhook."""

    @abstractmethod
    async def send_message(
        self, client_ref: str, text: str, *, human_agent: bool = False
    ) -> DeliveryResult:
        """Send a message. `human_agent` marks an operator reply (Instagram Human Agent tag)."""

    @abstractmethod
    async def set_typing(self, client_ref: str, on: bool) -> None: ...

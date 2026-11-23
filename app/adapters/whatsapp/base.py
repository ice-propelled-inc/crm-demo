"""WhatsApp Business Cloud API client interface. Used only for notifications."""

from abc import ABC, abstractmethod


class WhatsAppError(Exception):
    """The WhatsApp API refused the message."""


class WhatsAppClient(ABC):
    @abstractmethod
    async def send_template(
        self, *, to: str, template_name: str, language: str, parameters: list[str]
    ) -> str:
        """Send an approved template message. Returns the WhatsApp message ID."""

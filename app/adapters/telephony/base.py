"""Telephony client interface (Twilio): phone calls with text-to-speech."""

from abc import ABC, abstractmethod

URGENT_CALL_TEXT = "Hello. You have unhandled order conversations. Please check in whatsapp chat"


class TelephonyError(Exception):
    """The telephony service refused the call."""


class TelephonyClient(ABC):
    @abstractmethod
    async def call_with_tts(self, *, to: str, text: str, language: str = "en") -> str:
        """Start a phone call that reads `text`. Returns the call ID."""

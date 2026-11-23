"""Jivo Bot API adapter.

Jivo -> module: POST to our endpoint `/webhooks/jivo/{tenant_id}/{token}` with JSON events
(`CLIENT_MESSAGE`, `AGENT_JOINED`, `CHAT_CLOSED`, ...). Jivo waits 3 s and retries 2 times,
so the endpoint only queues the event and returns 200.

module -> Jivo: POST `{jivo_api_base}/webhooks/{provider_id}/{token}` with a `BOT_MESSAGE`.
The token in the URL path is the only authentication. Jivo has no typing event.

Docs: https://www.jivochat.com/docs/bot/
"""

import hmac
import json
import time
import uuid
from collections.abc import Mapping
from datetime import UTC, datetime

import httpx

from app.adapters.channels.base import (
    ChannelAdapter,
    DeliveryResult,
    InboundMessage,
    InvalidChannelWebhook,
)
from app.domain.types import ChannelKind


class JivoAdapter(ChannelAdapter):
    kind = ChannelKind.JIVO
    supports_typing = False

    def __init__(
        self, *, api_base: str, provider_id: str, token: str, http: httpx.AsyncClient
    ) -> None:
        self._url = f"{api_base.rstrip('/')}/webhooks/{provider_id}/{token}"
        self._token = token
        self._http = http

    def verify_path_token(self, token: str) -> bool:
        return hmac.compare_digest(token, self._token)

    def parse_webhook(self, headers: Mapping[str, str], body: bytes) -> list[InboundMessage]:
        try:
            event = json.loads(body)
            if event.get("event") != "CLIENT_MESSAGE":
                return []
            message = event["message"]
            if message.get("type") != "TEXT" or not message.get("text"):
                return []
            sender = event.get("sender") or {}
            timestamp = message.get("timestamp")
            received = (
                datetime.fromtimestamp(int(timestamp), UTC) if timestamp else datetime.now(UTC)
            )
            return [
                InboundMessage(
                    channel=self.kind,
                    client_ref=str(event["client_id"]),
                    text=message["text"],
                    provider_message_id=str(event["id"]),
                    received_at=received,
                    display_name=sender.get("name"),
                    thread_ref=str(event["chat_id"]),
                )
            ]
        except (ValueError, KeyError, TypeError) as exc:
            raise InvalidChannelWebhook("Jivo event is not valid") from exc

    async def send_message(
        self,
        client_ref: str,
        text: str,
        *,
        thread_ref: str | None = None,
        human_agent: bool = False,
    ) -> DeliveryResult:
        if thread_ref is None:
            return DeliveryResult(delivered=False, reason="no_chat_id")
        event_id = str(uuid.uuid4())
        response = await self._http.post(
            self._url,
            json={
                "event": "BOT_MESSAGE",
                "id": event_id,
                "client_id": client_ref,
                "chat_id": thread_ref,
                "message": {"type": "TEXT", "text": text, "timestamp": int(time.time())},
            },
        )
        if response.is_error:
            return DeliveryResult(delivered=False, reason=f"jivo_http_{response.status_code}")
        return DeliveryResult(delivered=True, provider_message_id=event_id)

    async def set_typing(self, client_ref: str, on: bool, *, thread_ref: str | None = None) -> None:
        return None

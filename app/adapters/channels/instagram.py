"""Meta Instagram API with Instagram Login.

Webhook: `{"object": "instagram", "entry": [{"id": <IG ID>, "messaging": [{"sender": {"id"},
"recipient": {"id"}, "timestamp", "message": {"mid", "text", "is_echo"?}}]}]}`, signed with
`X-Hub-Signature-256: sha256=<HMAC(app secret, body)>`.

Send: `POST {api_base}/{ig_id}/messages` with a Bearer token. Operator replies use the
Human Agent tag (7-day window). A closed window gives error code 10, subcode 2534022.
"""

import json
from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any

import httpx

from app.adapters.channels.base import (
    ChannelAdapter,
    DeliveryResult,
    InboundMessage,
    InvalidChannelWebhook,
)
from app.domain.types import ChannelKind
from app.security import verify_hmac_sha256

WINDOW_CLOSED_SUBCODE = 2534022


class InstagramAdapter(ChannelAdapter):
    kind = ChannelKind.INSTAGRAM
    supports_typing = True

    def __init__(
        self,
        *,
        api_base: str,
        ig_account_id: str,
        access_token: str,
        app_secret: str,
        http: httpx.AsyncClient,
    ) -> None:
        self._url = f"{api_base.rstrip('/')}/{ig_account_id}/messages"
        self._account_id = ig_account_id
        self._token = access_token
        self._app_secret = app_secret
        self._http = http

    def parse_webhook(self, headers: Mapping[str, str], body: bytes) -> list[InboundMessage]:
        lowered = {k.lower(): v for k, v in headers.items()}
        if not verify_hmac_sha256(self._app_secret, body, lowered.get("x-hub-signature-256")):
            raise InvalidChannelWebhook("Instagram signature is not valid")
        try:
            data = json.loads(body)
            messages: list[InboundMessage] = []
            for entry in data.get("entry", []):
                for event in entry.get("messaging", []):
                    message = event.get("message") or {}
                    if message.get("is_echo") or not message.get("text"):
                        continue
                    messages.append(
                        InboundMessage(
                            channel=self.kind,
                            client_ref=str(event["sender"]["id"]),
                            text=message["text"],
                            provider_message_id=str(message["mid"]),
                            received_at=datetime.fromtimestamp(event["timestamp"] / 1000, UTC),
                            account_ref=str(entry["id"]),
                        )
                    )
            return messages
        except (ValueError, KeyError, TypeError) as exc:
            raise InvalidChannelWebhook("Instagram event is not valid") from exc

    async def _post(self, body: dict[str, Any]) -> httpx.Response:
        return await self._http.post(
            self._url, json=body, headers={"Authorization": f"Bearer {self._token}"}
        )

    async def send_message(
        self,
        client_ref: str,
        text: str,
        *,
        thread_ref: str | None = None,
        human_agent: bool = False,
    ) -> DeliveryResult:
        body: dict[str, Any] = {"recipient": {"id": client_ref}, "message": {"text": text}}
        if human_agent:
            body |= {"messaging_type": "MESSAGE_TAG", "tag": "HUMAN_AGENT"}
        response = await self._post(body)
        if response.is_error:
            error = _error(response)
            if error.get("code") == 10 and error.get("error_subcode") == WINDOW_CLOSED_SUBCODE:
                return DeliveryResult(delivered=False, reason="window_closed")
            return DeliveryResult(delivered=False, reason=f"instagram_http_{response.status_code}")
        return DeliveryResult(delivered=True, provider_message_id=response.json().get("message_id"))

    async def set_typing(self, client_ref: str, on: bool, *, thread_ref: str | None = None) -> None:
        action = "typing_on" if on else "typing_off"
        await self._post({"recipient": {"id": client_ref}, "sender_action": action})


def _error(response: httpx.Response) -> dict[str, Any]:
    try:
        error = response.json().get("error")
    except ValueError:
        return {}
    return error if isinstance(error, dict) else {}

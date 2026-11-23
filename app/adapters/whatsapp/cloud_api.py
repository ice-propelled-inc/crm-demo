"""WhatsApp Business Cloud API client: template messages only (notifications)."""

import httpx

from app.adapters.whatsapp.base import WhatsAppClient, WhatsAppError


class CloudApiWhatsAppClient(WhatsAppClient):
    def __init__(
        self, *, api_base: str, phone_number_id: str, token: str, http: httpx.AsyncClient
    ) -> None:
        self._url = f"{api_base.rstrip('/')}/{phone_number_id}/messages"
        self._token = token
        self._http = http

    async def send_template(
        self, *, to: str, template_name: str, language: str, parameters: list[str]
    ) -> str:
        body = {
            "messaging_product": "whatsapp",
            "to": to.lstrip("+"),
            "type": "template",
            "template": {
                "name": template_name,
                "language": {"code": language},
                "components": [
                    {
                        "type": "body",
                        "parameters": [{"type": "text", "text": p} for p in parameters],
                    }
                ],
            },
        }
        response = await self._http.post(
            self._url, json=body, headers={"Authorization": f"Bearer {self._token}"}
        )
        if response.is_error:
            raise WhatsAppError(f"WhatsApp API error: HTTP {response.status_code}")
        try:
            return str(response.json()["messages"][0]["id"])
        except (ValueError, KeyError, IndexError) as exc:
            raise WhatsAppError("WhatsApp API response has no message ID") from exc

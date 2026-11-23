"""Twilio voice calls with text-to-speech (TwiML <Say>)."""

from xml.sax.saxutils import escape

import httpx

from app.adapters.telephony.base import TelephonyClient, TelephonyError

VOICE_LANGUAGES = {"en": "en-US", "fr": "fr-FR"}


class TwilioTelephonyClient(TelephonyClient):
    def __init__(
        self,
        *,
        api_base: str,
        account_sid: str,
        auth_token: str,
        from_number: str,
        http: httpx.AsyncClient,
    ) -> None:
        self._url = f"{api_base.rstrip('/')}/2010-04-01/Accounts/{account_sid}/Calls.json"
        self._auth = (account_sid, auth_token)
        self._from = from_number
        self._http = http

    async def call_with_tts(self, *, to: str, text: str, language: str = "en") -> str:
        voice_language = VOICE_LANGUAGES.get(language, "en-US")
        twiml = f'<Response><Say language="{voice_language}">{escape(text)}</Say></Response>'
        response = await self._http.post(
            self._url, data={"To": to, "From": self._from, "Twiml": twiml}, auth=self._auth
        )
        if response.is_error:
            raise TelephonyError(f"Twilio error: HTTP {response.status_code}")
        try:
            return str(response.json()["sid"])
        except (ValueError, KeyError) as exc:
            raise TelephonyError("Twilio response has no call SID") from exc

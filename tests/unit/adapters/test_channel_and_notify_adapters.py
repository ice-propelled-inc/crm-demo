"""Jivo, Instagram, Tidio, WhatsApp Cloud API and Twilio adapters (HTTP mocked)."""

import json
from collections.abc import Callable

import httpx
import pytest

from app.adapters.channels.base import ChannelNotSupportedError, InvalidChannelWebhook
from app.adapters.channels.instagram import InstagramAdapter
from app.adapters.channels.jivo import JivoAdapter
from app.adapters.channels.tidio import TidioAdapter
from app.adapters.telephony.base import TelephonyError
from app.adapters.telephony.twilio import TwilioTelephonyClient
from app.adapters.whatsapp.base import WhatsAppError
from app.adapters.whatsapp.cloud_api import CloudApiWhatsAppClient
from app.security import hmac_sha256_signature

Handler = Callable[[httpx.Request], httpx.Response]


def http(handler: Handler, seen: list[httpx.Request] | None = None) -> httpx.AsyncClient:
    def wrapped(request: httpx.Request) -> httpx.Response:
        if seen is not None:
            seen.append(request)
        return handler(request)

    return httpx.AsyncClient(transport=httpx.MockTransport(wrapped))


def ok(body: object) -> Handler:
    return lambda _r: httpx.Response(200, json=body)


class TestJivo:
    def adapter(
        self, handler: Handler = ok({}), seen: list[httpx.Request] | None = None
    ) -> JivoAdapter:
        return JivoAdapter(
            api_base="https://bot.jivo/", provider_id="p", token="t:1", http=http(handler, seen)
        )

    def test_client_message(self) -> None:
        body = {
            "id": "e1",
            "client_id": 7,
            "chat_id": 9,
            "event": "CLIENT_MESSAGE",
            "sender": {"name": "Bob"},
            "message": {"type": "TEXT", "text": "hi", "timestamp": 1700000000},
        }
        [msg] = self.adapter().parse_webhook({}, json.dumps(body).encode())
        assert (msg.client_ref, msg.thread_ref, msg.display_name) == ("7", "9", "Bob")
        assert msg.received_at.year == 2023

    def test_other_events_and_non_text_are_ignored(self) -> None:
        adapter = self.adapter()
        assert adapter.parse_webhook({}, b'{"event": "CHAT_CLOSED", "id": "x"}') == []
        photo = {"event": "CLIENT_MESSAGE", "message": {"type": "PHOTO", "file": "u"}}
        assert adapter.parse_webhook({}, json.dumps(photo).encode()) == []

    def test_no_timestamp_uses_now(self) -> None:
        body = {"id": "e", "client_id": 1, "chat_id": 2, "event": "CLIENT_MESSAGE",
                "message": {"type": "TEXT", "text": "x"}}  # fmt: skip
        [msg] = self.adapter().parse_webhook({}, json.dumps(body).encode())
        assert msg.received_at is not None

    @pytest.mark.parametrize(
        "raw",
        [b"not json", b'{"event": "CLIENT_MESSAGE", "message": {"type": "TEXT", "text": "x"}}'],
    )
    def test_invalid(self, raw: bytes) -> None:
        with pytest.raises(InvalidChannelWebhook):
            self.adapter().parse_webhook({}, raw)

    def test_path_token(self) -> None:
        adapter = self.adapter()
        assert adapter.verify_path_token("t:1")
        assert not adapter.verify_path_token("t:2")

    async def test_send(self) -> None:
        seen: list[httpx.Request] = []
        adapter = self.adapter(ok({}), seen)
        result = await adapter.send_message("7", "hello", thread_ref="9")
        assert result.delivered
        assert str(seen[0].url) == "https://bot.jivo/webhooks/p/t:1"
        sent = json.loads(seen[0].content)
        assert (sent["event"], sent["chat_id"], sent["message"]["text"]) == (
            "BOT_MESSAGE",
            "9",
            "hello",
        )
        await adapter.set_typing("7", True)
        assert len(seen) == 1  # Jivo has no typing event

    async def test_send_errors(self) -> None:
        assert (await self.adapter().send_message("7", "x")).reason == "no_chat_id"
        failing = self.adapter(lambda _r: httpx.Response(404))
        assert (await failing.send_message("7", "x", thread_ref="9")).reason == "jivo_http_404"


IG_EVENT = {
    "object": "instagram",
    "entry": [
        {
            "id": "ig-1",
            "messaging": [
                {"sender": {"id": "u1"}, "recipient": {"id": "ig-1"}, "timestamp": 1700000000000,
                 "message": {"mid": "m1", "text": "hello"}},
                {"sender": {"id": "ig-1"}, "recipient": {"id": "u1"}, "timestamp": 1700000000001,
                 "message": {"mid": "m2", "text": "echo", "is_echo": True}},
                {"sender": {"id": "u1"}, "recipient": {"id": "ig-1"}, "timestamp": 1700000000002,
                 "read": {"mid": "m1"}},
            ],
        }
    ],
}  # fmt: skip


class TestInstagram:
    def adapter(
        self,
        handler: Handler = ok({"message_id": "mid-1"}),
        seen: list[httpx.Request] | None = None,
    ) -> InstagramAdapter:
        return InstagramAdapter(
            api_base="https://graph.ig/v21.0",
            ig_account_id="ig-1",
            access_token="tok",
            app_secret="secret",
            http=http(handler, seen),
        )

    def test_parse_signed(self) -> None:
        raw = json.dumps(IG_EVENT).encode()
        [msg] = self.adapter().parse_webhook(
            {"X-Hub-Signature-256": hmac_sha256_signature("secret", raw)}, raw
        )
        assert (msg.client_ref, msg.text, msg.account_ref) == ("u1", "hello", "ig-1")

    def test_bad_signature_and_body(self) -> None:
        raw = json.dumps(IG_EVENT).encode()
        with pytest.raises(InvalidChannelWebhook):
            self.adapter().parse_webhook({"X-Hub-Signature-256": "sha256=0"}, raw)
        bad = b'{"entry": [{"id": "x", "messaging": [{"message": {"text": "t"}}]}]}'
        with pytest.raises(InvalidChannelWebhook):
            self.adapter().parse_webhook(
                {"x-hub-signature-256": hmac_sha256_signature("secret", bad)}, bad
            )

    async def test_send_and_human_agent_tag(self) -> None:
        seen: list[httpx.Request] = []
        adapter = self.adapter(seen=seen)
        result = await adapter.send_message("u1", "hi", human_agent=True)
        assert (result.delivered, result.provider_message_id) == (True, "mid-1")
        body = json.loads(seen[0].content)
        assert (body["messaging_type"], body["tag"]) == ("MESSAGE_TAG", "HUMAN_AGENT")
        assert seen[0].headers["authorization"] == "Bearer tok"
        assert str(seen[0].url) == "https://graph.ig/v21.0/ig-1/messages"
        await adapter.set_typing("u1", False)
        assert json.loads(seen[1].content)["sender_action"] == "typing_off"

    async def test_window_closed_and_other_errors(self) -> None:
        closed = self.adapter(
            lambda _r: httpx.Response(400, json={"error": {"code": 10, "error_subcode": 2534022}})
        )
        assert (await closed.send_message("u1", "x")).reason == "window_closed"
        other = self.adapter(lambda _r: httpx.Response(500, text="oops"))
        assert (await other.send_message("u1", "x")).reason == "instagram_http_500"
        odd = self.adapter(lambda _r: httpx.Response(400, json={"error": "text"}))
        assert (await odd.send_message("u1", "x")).reason == "instagram_http_400"


async def test_tidio_is_a_clear_stub() -> None:
    tidio = TidioAdapter()
    with pytest.raises(ChannelNotSupportedError):
        tidio.parse_webhook({}, b"{}")
    with pytest.raises(ChannelNotSupportedError):
        await tidio.send_message("c", "x")
    with pytest.raises(ChannelNotSupportedError):
        await tidio.set_typing("c", True)


async def test_whatsapp_cloud_api() -> None:
    seen: list[httpx.Request] = []
    client = CloudApiWhatsAppClient(
        api_base="https://graph.fb/v21.0", phone_number_id="123", token="tok",
        http=http(ok({"messages": [{"id": "wamid.1"}]}), seen),
    )  # fmt: skip
    assert (
        await client.send_template(to="+336", template_name="t", language="fr", parameters=["link"])
        == "wamid.1"
    )
    body = json.loads(seen[0].content)
    assert body["to"] == "336"
    assert body["template"]["components"][0]["parameters"] == [{"type": "text", "text": "link"}]

    for handler in (lambda _r: httpx.Response(401), ok({"nothing": True})):
        failing = CloudApiWhatsAppClient(
            api_base="https://x", phone_number_id="1", token="t", http=http(handler)
        )
        with pytest.raises(WhatsAppError):
            await failing.send_template(to="1", template_name="t", language="en", parameters=[])


async def test_twilio() -> None:
    seen: list[httpx.Request] = []
    client = TwilioTelephonyClient(
        api_base="https://api.twilio.test", account_sid="AC1", auth_token="tok",
        from_number="+1000", http=http(ok({"sid": "CA1"}), seen),
    )  # fmt: skip
    assert await client.call_with_tts(to="+33", text="A & B", language="fr") == "CA1"
    form = dict(httpx.QueryParams(seen[0].content.decode()))
    assert form["Twiml"] == '<Response><Say language="fr-FR">A &amp; B</Say></Response>'
    assert seen[0].url.path == "/2010-04-01/Accounts/AC1/Calls.json"
    assert seen[0].headers["authorization"].startswith("Basic ")

    for handler in (lambda _r: httpx.Response(400), ok({})):
        failing = TwilioTelephonyClient(
            api_base="https://x",
            account_sid="A",
            auth_token="t",
            from_number="+1",
            http=http(handler),
        )
        with pytest.raises(TelephonyError):
            await failing.call_with_tts(to="+1", text="x")

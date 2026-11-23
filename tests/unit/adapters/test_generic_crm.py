"""Generic HTTP CRM adapter against the mock CRM server (in-process, no network)."""

import json
from collections.abc import AsyncIterator
from decimal import Decimal

import httpx
import pytest

from app.adapters.crm.base import CRMError, InvalidWebhookSignature, OrderLine
from app.adapters.crm.generic_http import GenericHttpCRMAdapter
from app.domain.types import OrderStatus
from app.security import hmac_sha256_signature
from mocks import server as mock_server

WEBHOOK_SECRET = "dev-webhook-secret"


@pytest.fixture
async def crm() -> AsyncIterator[GenericHttpCRMAdapter]:
    mock_server.reset()
    transport = httpx.ASGITransport(app=mock_server.create_mock_app())
    async with httpx.AsyncClient(transport=transport) as http:
        yield GenericHttpCRMAdapter(
            base_url="http://mock/crm/",
            client_id="dev-client",
            client_secret="dev-secret",
            webhook_secret=WEBHOOK_SECRET,
            http=http,
        )


async def test_catalog(crm: GenericHttpCRMAdapter) -> None:
    items = await crm.get_catalog()
    assert [i.external_id for i in items] == ["P-1", "P-2"]
    assert items[0].price == Decimal("11.50")
    assert items[0].attributes == {"size": "30 cm"}


async def test_order_lifecycle(crm: GenericHttpCRMAdapter) -> None:
    created = await crm.create_order(client_ref="client-1", lines=[OrderLine("P-1", 2)])
    assert created.status is OrderStatus.AWAITING_PAYMENT
    assert created.payment_link == f"https://pay.example.test/{created.crm_order_id}"

    state = await crm.get_order_status(created.crm_order_id)
    assert state.status is OrderStatus.AWAITING_PAYMENT
    assert state.changed_at is not None

    cancelled = await crm.cancel_order(created.crm_order_id)
    assert cancelled.status is OrderStatus.CANCELLED


async def test_unknown_order_is_error(crm: GenericHttpCRMAdapter) -> None:
    with pytest.raises(CRMError, match="HTTP 404"):
        await crm.get_order_status("ORD-0")


async def test_invalid_lines_are_error(crm: GenericHttpCRMAdapter) -> None:
    with pytest.raises(CRMError, match="HTTP 422"):
        await crm.create_order(client_ref="c", lines=[OrderLine("NOPE", 1)])


async def test_expired_service_token_is_renewed(crm: GenericHttpCRMAdapter) -> None:
    await crm.get_catalog()
    mock_server.crm_state.service_tokens.clear()  # the CRM forgets the token
    assert len(await crm.get_catalog()) == 2


async def test_bad_client_secret() -> None:
    transport = httpx.ASGITransport(app=mock_server.create_mock_app())
    async with httpx.AsyncClient(transport=transport) as http:
        crm = GenericHttpCRMAdapter(
            base_url="http://mock/crm",
            client_id="dev-client",
            client_secret="wrong",
            webhook_secret=None,
            http=http,
        )
        with pytest.raises(CRMError, match="Token request failed"):
            await crm.get_catalog()


async def test_always_unauthorized_is_error() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/oauth/token"):
            return httpx.Response(200, json={"access_token": "t"})
        return httpx.Response(401)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        crm = GenericHttpCRMAdapter(
            base_url="http://x", client_id="a", client_secret="b", webhook_secret=None, http=http
        )
        with pytest.raises(CRMError, match="HTTP 401"):
            await crm.get_catalog()


async def test_status_map_and_unknown_status() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/oauth/token"):
            return httpx.Response(200, json={"access_token": "t"})
        if request.url.path.endswith("/A"):
            return httpx.Response(200, json={"id": "A", "status": "payée"})
        return httpx.Response(200, json={"id": "B", "status": "weird"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        crm = GenericHttpCRMAdapter(
            base_url="http://x",
            client_id="a",
            client_secret="b",
            webhook_secret=None,
            status_map={"payée": OrderStatus.PAID},
            http=http,
        )
        state = await crm.get_order_status("A")
        assert state.status is OrderStatus.PAID
        assert state.changed_at is None
        with pytest.raises(CRMError, match="Unknown CRM order status"):
            await crm.get_order_status("B")


class TestLogin:
    async def test_authorization_url(self, crm: GenericHttpCRMAdapter) -> None:
        url = crm.authorization_url(state="s1", redirect_uri="http://app/cb", code_challenge="cc")
        assert url.startswith("http://mock/crm/oauth/authorize?")
        assert "state=s1" in url
        assert "code_challenge_method=S256" in url

    async def test_bad_user_token(self, crm: GenericHttpCRMAdapter) -> None:
        with pytest.raises(CRMError, match="api/me"):
            await crm.get_current_user("nope")


def _webhook(body: dict[str, object], secret: str = WEBHOOK_SECRET) -> tuple[dict[str, str], bytes]:
    raw = json.dumps(body).encode()
    return {"X-Signature": hmac_sha256_signature(secret, raw)}, raw


EVENT = {
    "event_id": "evt-1",
    "event": "order.status_changed",
    "order_id": "ORD-1",
    "status": "paid",
    "changed_at": "2026-11-23T10:15:00+00:00",
}


class TestWebhook:
    async def test_valid(self, crm: GenericHttpCRMAdapter) -> None:
        event = crm.parse_webhook(*_webhook(EVENT))
        assert (event.event_id, event.crm_order_id, event.status) == (
            "evt-1",
            "ORD-1",
            OrderStatus.PAID,
        )

    async def test_wrong_secret(self, crm: GenericHttpCRMAdapter) -> None:
        with pytest.raises(InvalidWebhookSignature):
            crm.parse_webhook(*_webhook(EVENT, secret="other"))

    async def test_missing_signature(self, crm: GenericHttpCRMAdapter) -> None:
        with pytest.raises(InvalidWebhookSignature):
            crm.parse_webhook({}, json.dumps(EVENT).encode())

    async def test_no_secret_configured(self) -> None:
        crm = GenericHttpCRMAdapter(
            base_url="http://x", client_id="a", client_secret="b", webhook_secret=None
        )
        with pytest.raises(InvalidWebhookSignature):
            crm.parse_webhook(*_webhook(EVENT))

    async def test_invalid_body(self, crm: GenericHttpCRMAdapter) -> None:
        with pytest.raises(CRMError, match="not valid"):
            crm.parse_webhook(*_webhook({"event_id": "x"}))

    async def test_unsupported_event(self, crm: GenericHttpCRMAdapter) -> None:
        with pytest.raises(CRMError, match="Unsupported"):
            crm.parse_webhook(*_webhook({**EVENT, "event": "order.deleted"}))

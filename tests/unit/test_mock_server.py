"""Mock servers: recorders, reset and the CRM status control endpoint."""

import json
from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest

from app.security import verify_hmac_sha256
from mocks import server as mock_server


@pytest.fixture
async def client() -> AsyncIterator[httpx.AsyncClient]:
    mock_server.reset()
    transport = httpx.ASGITransport(app=mock_server.create_mock_app())
    async with httpx.AsyncClient(transport=transport, base_url="http://mock") as http:
        yield http


async def test_recorder(client: httpx.AsyncClient) -> None:
    response = await client.post("/twilio/2010-04-01/Calls.json", json={"To": "+1"})
    assert response.json()["sid"] == "twilio-1"
    await client.post("/jivo/send", content=b"not json")
    [call] = (await client.get("/_recorded/twilio")).json()
    assert (call["path"], call["body"]) == ("2010-04-01/Calls.json", {"To": "+1"})
    assert (await client.get("/_recorded/jivo")).json()[0]["body"] == "not json"
    assert (await client.post("/unknown/x")).status_code == 404
    await client.post("/_reset")
    assert (await client.get("/_recorded/twilio")).json() == []


async def _service_token(client: httpx.AsyncClient) -> str:
    response = await client.post(
        "/crm/oauth/token",
        data={
            "grant_type": "client_credentials",
            "client_id": "dev-client",
            "client_secret": "dev-secret",
        },
    )
    token: str = response.json()["access_token"]
    return token


async def test_status_control_sends_signed_webhook(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    captured: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(200)

    real_client = httpx.AsyncClient

    def fake_client(**kwargs: Any) -> httpx.AsyncClient:
        return real_client(transport=httpx.MockTransport(handler), **kwargs)

    monkeypatch.setattr(mock_server.httpx, "AsyncClient", fake_client)

    token = await _service_token(client)
    order = await client.post(
        "/crm/api/orders",
        json={"client_ref": "c1", "lines": [{"product_id": "P-1", "quantity": 1}]},
        headers={"Authorization": f"Bearer {token}"},
    )
    order_id = order.json()["id"]

    event = await client.post(
        f"/crm/_control/orders/{order_id}/status", json={"status": "paid", "tenant_id": "t1"}
    )
    assert event.json()["status"] == "paid"
    [sent] = captured
    assert sent.url.path == "/webhooks/crm/t1"
    assert verify_hmac_sha256("dev-webhook-secret", sent.content, sent.headers["X-Signature"])
    assert json.loads(sent.content)["order_id"] == order_id

    await client.post(
        f"/crm/_control/orders/{order_id}/status",
        json={"status": "shipped", "tenant_id": "t1", "send_webhook": False},
    )
    assert len(captured) == 1


async def test_crm_rejects_bad_requests(client: httpx.AsyncClient) -> None:
    assert (await client.get("/crm/api/catalog")).status_code == 401
    bad_authorize = await client.get(
        "/crm/oauth/authorize",
        params={"client_id": "x", "redirect_uri": "r", "state": "s", "code_challenge": "c"},
    )
    assert bad_authorize.status_code == 400
    unknown_user = await client.get(
        "/crm/oauth/authorize",
        params={
            "client_id": "dev-client",
            "redirect_uri": "r",
            "state": "s",
            "code_challenge": "c",
            "login_as": "ghost",
        },
    )
    assert unknown_user.status_code == 400
    base = {"client_id": "dev-client", "client_secret": "dev-secret"}
    assert (
        await client.post("/crm/oauth/token", data={**base, "grant_type": "password"})
    ).status_code == 400
    bad_code = await client.post(
        "/crm/oauth/token", data={**base, "grant_type": "authorization_code", "code": "x"}
    )
    assert bad_code.status_code == 400

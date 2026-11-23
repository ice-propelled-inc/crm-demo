"""Mock servers for local development and e2e tests.

- `/crm/...`: a CRM that implements the generic contract of
  `app/adapters/crm/generic_http.py` (OAuth, catalog, orders with payment links)
  and can send signed status webhooks.
- `/jivo`, `/tidio`, `/instagram`, `/whatsapp`, `/twilio`: recorders. They accept
  any POST, keep the body, and return an ID. Read them with `GET /_recorded/{service}`.

All state is in memory. `POST /_reset` clears it.
"""

import hashlib
import json
import os
import secrets
from base64 import urlsafe_b64encode
from dataclasses import dataclass, field
from datetime import UTC, datetime
from itertools import count
from typing import Annotated, Any
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, FastAPI, Form, Header, HTTPException, Request
from fastapi.responses import RedirectResponse
from pydantic import BaseModel

from app.security import hmac_sha256_signature

CLIENT_ID = os.environ.get("MOCK_CRM_CLIENT_ID", "dev-client")
CLIENT_SECRET = os.environ.get("MOCK_CRM_CLIENT_SECRET", "dev-secret")
WEBHOOK_SECRET = os.environ.get("MOCK_CRM_WEBHOOK_SECRET", "dev-webhook-secret")
WEBHOOK_TARGET = os.environ.get("MOCK_WEBHOOK_TARGET", "http://localhost:8000")

DEFAULT_USERS: dict[str, dict[str, Any]] = {
    "admin-1": {
        "id": "admin-1",
        "name": "Ada Admin",
        "email": "ada@example.test",
        "roles": ["admin"],
    },
    "operator-1": {
        "id": "operator-1",
        "name": "Olga Operator",
        "email": "olga@example.test",
        "roles": [],
    },
    "operator-2": {
        "id": "operator-2",
        "name": "Omar Operator",
        "email": "omar@example.test",
        "roles": [],
    },
    "manager-1": {
        "id": "manager-1",
        "name": "Max Manager",
        "email": "max@example.test",
        "roles": [],
    },
}
DEFAULT_CATALOG: list[dict[str, Any]] = [
    {
        "id": "P-1",
        "name": "Margherita pizza",
        "description": "Tomato, mozzarella, basil",
        "price": "11.50",
        "currency": "EUR",
        "attributes": {"size": "30 cm"},
    },
    {
        "id": "P-2",
        "name": "Lemonade",
        "description": "Fresh lemon, mint",
        "price": "3.90",
        "currency": "EUR",
        "attributes": {"volume": "0.5 l"},
    },
]


@dataclass
class CrmState:
    users: dict[str, dict[str, Any]] = field(default_factory=lambda: dict(DEFAULT_USERS))
    catalog: list[dict[str, Any]] = field(default_factory=lambda: list(DEFAULT_CATALOG))
    codes: dict[str, dict[str, str]] = field(default_factory=dict)
    user_tokens: dict[str, str] = field(default_factory=dict)  # token -> user id
    service_tokens: set[str] = field(default_factory=set)
    orders: dict[str, dict[str, Any]] = field(default_factory=dict)
    ids: count[int] = field(default_factory=lambda: count(1001))


@dataclass
class RecorderState:
    records: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    ids: count[int] = field(default_factory=lambda: count(1))


crm_state = CrmState()
recorder_state = RecorderState()

crm = APIRouter(prefix="/crm", tags=["mock-crm"])


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _require_service_token(authorization: str | None) -> None:
    token = (authorization or "").removeprefix("Bearer ")
    if token not in crm_state.service_tokens:
        raise HTTPException(401, "invalid service token")


@crm.get("/oauth/authorize")
async def authorize(
    client_id: str,
    redirect_uri: str,
    state: str,
    code_challenge: str,
    response_type: str = "code",
    code_challenge_method: str = "S256",
    login_as: str = "admin-1",
) -> RedirectResponse:
    """Approves at once. `login_as` selects the mock user (no login page)."""
    if client_id != CLIENT_ID or response_type != "code" or code_challenge_method != "S256":
        raise HTTPException(400, "invalid authorize request")
    if login_as not in crm_state.users:
        raise HTTPException(400, "unknown user")
    code = secrets.token_urlsafe(16)
    crm_state.codes[code] = {
        "user_id": login_as,
        "redirect_uri": redirect_uri,
        "challenge": code_challenge,
    }
    return RedirectResponse(f"{redirect_uri}?{urlencode({'code': code, 'state': state})}", 302)


@crm.post("/oauth/token")
async def token(
    grant_type: Annotated[str, Form()],
    client_id: Annotated[str, Form()],
    client_secret: Annotated[str, Form()],
    code: Annotated[str | None, Form()] = None,
    redirect_uri: Annotated[str | None, Form()] = None,
    code_verifier: Annotated[str | None, Form()] = None,
) -> dict[str, Any]:
    if client_id != CLIENT_ID or client_secret != CLIENT_SECRET:
        raise HTTPException(401, "invalid client")
    access_token = secrets.token_urlsafe(24)
    if grant_type == "client_credentials":
        crm_state.service_tokens.add(access_token)
        return {"access_token": access_token, "token_type": "Bearer", "expires_in": 3600}
    if grant_type != "authorization_code" or code is None:
        raise HTTPException(400, "unsupported grant")
    grant = crm_state.codes.pop(code, None)
    if grant is None or grant["redirect_uri"] != redirect_uri:
        raise HTTPException(400, "invalid code")
    digest = hashlib.sha256((code_verifier or "").encode()).digest()
    if urlsafe_b64encode(digest).rstrip(b"=").decode() != grant["challenge"]:
        raise HTTPException(400, "PKCE check failed")
    crm_state.user_tokens[access_token] = grant["user_id"]
    return {"access_token": access_token, "token_type": "Bearer", "expires_in": 3600}


@crm.get("/api/me")
async def me(authorization: Annotated[str | None, Header()] = None) -> dict[str, Any]:
    user_id = crm_state.user_tokens.get((authorization or "").removeprefix("Bearer "))
    if user_id is None:
        raise HTTPException(401, "invalid user token")
    return crm_state.users[user_id]


@crm.get("/api/catalog")
async def catalog(authorization: Annotated[str | None, Header()] = None) -> dict[str, Any]:
    _require_service_token(authorization)
    return {"items": crm_state.catalog}


class _OrderLine(BaseModel):
    product_id: str
    quantity: int


class _OrderIn(BaseModel):
    client_ref: str
    lines: list[_OrderLine]


@crm.post("/api/orders")
async def create_order(
    body: _OrderIn, authorization: Annotated[str | None, Header()] = None
) -> dict[str, Any]:
    _require_service_token(authorization)
    known = {item["id"] for item in crm_state.catalog}
    if not body.lines or any(ln.product_id not in known or ln.quantity < 1 for ln in body.lines):
        raise HTTPException(422, "invalid order lines")
    order_id = f"ORD-{next(crm_state.ids)}"
    order = {
        "id": order_id,
        "client_ref": body.client_ref,
        "lines": [ln.model_dump() for ln in body.lines],
        "status": "awaiting_payment",
        "changed_at": _now(),
        "payment_url": f"https://pay.example.test/{order_id}",
    }
    crm_state.orders[order_id] = order
    return {"id": order_id, "status": order["status"], "payment_url": order["payment_url"]}


def _get_order(order_id: str) -> dict[str, Any]:
    order = crm_state.orders.get(order_id)
    if order is None:
        raise HTTPException(404, "unknown order")
    return order


@crm.get("/api/orders/{order_id}")
async def get_order(
    order_id: str, authorization: Annotated[str | None, Header()] = None
) -> dict[str, Any]:
    _require_service_token(authorization)
    order = _get_order(order_id)
    return {"id": order_id, "status": order["status"], "changed_at": order["changed_at"]}


@crm.post("/api/orders/{order_id}/cancel")
async def cancel_order(
    order_id: str, authorization: Annotated[str | None, Header()] = None
) -> dict[str, Any]:
    _require_service_token(authorization)
    order = _get_order(order_id)
    order.update(status="cancelled", changed_at=_now())
    return {"id": order_id, "status": order["status"], "changed_at": order["changed_at"]}


class _StatusChange(BaseModel):
    status: str
    send_webhook: bool = True
    tenant_id: str


@crm.post("/_control/orders/{order_id}/status")
async def change_status(order_id: str, body: _StatusChange) -> dict[str, Any]:
    """Test control: change a status and (optionally) send the signed webhook."""
    order = _get_order(order_id)
    order.update(status=body.status, changed_at=_now())
    event = {
        "event_id": f"evt-{secrets.token_hex(6)}",
        "event": "order.status_changed",
        "order_id": order_id,
        "status": body.status,
        "changed_at": order["changed_at"],
    }
    if body.send_webhook:
        payload = json.dumps(event).encode()
        async with httpx.AsyncClient(timeout=10) as http:
            await http.post(
                f"{WEBHOOK_TARGET}/webhooks/crm/{body.tenant_id}",
                content=payload,
                headers={
                    "Content-Type": "application/json",
                    "X-Signature": hmac_sha256_signature(WEBHOOK_SECRET, payload),
                },
            )
    return event


recorder = APIRouter(tags=["mock-recorders"])
RECORDED_SERVICES = ("jivo", "tidio", "instagram", "whatsapp", "twilio")


@recorder.post("/{service}/{path:path}")
async def record(service: str, path: str, request: Request) -> dict[str, Any]:
    if service not in RECORDED_SERVICES:
        raise HTTPException(404, "unknown service")
    raw = await request.body()
    try:
        body: Any = json.loads(raw) if raw else None
    except ValueError:
        body = raw.decode(errors="replace")
    entry_id = f"{service}-{next(recorder_state.ids)}"
    recorder_state.records.setdefault(service, []).append(
        {"id": entry_id, "path": path, "body": body, "headers": dict(request.headers)}
    )
    return {"id": entry_id}


@recorder.get("/_recorded/{service}")
async def recorded(service: str) -> list[dict[str, Any]]:
    return recorder_state.records.get(service, [])


def reset() -> None:
    global crm_state, recorder_state
    crm_state = CrmState()
    recorder_state = RecorderState()


def create_mock_app() -> FastAPI:
    mock_app = FastAPI(title="AI-chat-helper mocks")
    mock_app.include_router(crm)

    @mock_app.post("/_reset")
    async def reset_endpoint() -> dict[str, str]:
        reset()
        return {"status": "reset"}

    mock_app.include_router(recorder)
    return mock_app


app = create_mock_app()

"""CRM adapter for the generic REST contract below.

A CRM that has a different API gets its own adapter. This adapter is also the one
that the e2e tests use against the mock CRM server (`mocks/server.py`).

Contract (paths relative to `base_url`):

    GET  /oauth/authorize    response_type=code, client_id, redirect_uri, state,
                             code_challenge, code_challenge_method=S256
    POST /oauth/token        grant_type=authorization_code | client_credentials
    GET  /api/me             -> {"id", "name", "email", "roles": [...]}
    GET  /api/catalog        -> {"items": [{"id", "name", "description", "price",
                                            "currency", "attributes"}]}
    POST /api/orders         {"client_ref", "lines": [{"product_id", "quantity"}]}
                             -> {"id", "status", "payment_url"}
    GET  /api/orders/{id}    -> {"id", "status", "changed_at"}
    POST /api/orders/{id}/cancel -> {"id", "status", "changed_at"}

Webhook (CRM -> module): JSON {"event_id", "event": "order.status_changed",
"order_id", "status", "changed_at"}, header `X-Signature: sha256=<hmac hex>`.
"""

from collections.abc import Mapping
from datetime import datetime
from decimal import Decimal
from typing import Any
from urllib.parse import urlencode

import httpx
from pydantic import BaseModel, ValidationError

from app.adapters.crm.base import (
    CatalogEntry,
    CreatedOrder,
    CRMAdapter,
    CRMError,
    CrmUser,
    InvalidWebhookSignature,
    OAuthTokens,
    OrderLine,
    OrderState,
    OrderStatusEvent,
)
from app.domain.types import OrderStatus
from app.security import verify_hmac_sha256


class _WebhookBody(BaseModel):
    event_id: str
    event: str
    order_id: str
    status: str
    changed_at: datetime


class GenericHttpCRMAdapter(CRMAdapter):
    def __init__(
        self,
        *,
        base_url: str,
        client_id: str,
        client_secret: str,
        webhook_secret: str | None,
        status_map: Mapping[str, OrderStatus] | None = None,
        http: httpx.AsyncClient | None = None,
        authorize_base_url: str | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        # The browser opens the authorize page. In local docker it has another host name.
        self._authorize_base_url = (authorize_base_url or base_url).rstrip("/")
        self._client_id = client_id
        self._client_secret = client_secret
        self._webhook_secret = webhook_secret
        self._status_map = dict(status_map or {})
        self._http = http or httpx.AsyncClient(timeout=15)
        self._service_token: str | None = None

    # --- helpers ---
    def _status(self, raw: str) -> OrderStatus:
        if raw in self._status_map:
            return self._status_map[raw]
        try:
            return OrderStatus(raw)
        except ValueError as exc:
            raise CRMError(f"Unknown CRM order status: {raw!r}") from exc

    async def _token_request(self, data: dict[str, str]) -> OAuthTokens:
        response = await self._http.post(f"{self._base_url}/oauth/token", data=data)
        if response.status_code != httpx.codes.OK:
            raise CRMError(f"Token request failed: HTTP {response.status_code}")
        body = response.json()
        return OAuthTokens(
            access_token=body["access_token"],
            refresh_token=body.get("refresh_token"),
            expires_in=body.get("expires_in"),
        )

    async def _service_auth(self) -> str:
        if self._service_token is None:
            tokens = await self._token_request(
                {
                    "grant_type": "client_credentials",
                    "client_id": self._client_id,
                    "client_secret": self._client_secret,
                }
            )
            self._service_token = tokens.access_token
        return self._service_token

    async def _send(self, method: str, path: str, json: Any) -> httpx.Response:
        token = await self._service_auth()
        return await self._http.request(
            method,
            f"{self._base_url}{path}",
            json=json,
            headers={"Authorization": f"Bearer {token}"},
        )

    async def _api(self, method: str, path: str, json: Any = None) -> Any:
        response = await self._send(method, path, json)
        if response.status_code == httpx.codes.UNAUTHORIZED:
            self._service_token = None  # token expired: get a new one, then retry once
            response = await self._send(method, path, json)
        if response.is_error:
            raise CRMError(f"{method} {path} failed: HTTP {response.status_code}")
        return response.json()

    @staticmethod
    def _parse_dt(value: str | None) -> datetime | None:
        return datetime.fromisoformat(value) if value else None

    # --- login ---
    def authorization_url(self, *, state: str, redirect_uri: str, code_challenge: str) -> str:
        query = urlencode(
            {
                "response_type": "code",
                "client_id": self._client_id,
                "redirect_uri": redirect_uri,
                "state": state,
                "code_challenge": code_challenge,
                "code_challenge_method": "S256",
            }
        )
        return f"{self._authorize_base_url}/oauth/authorize?{query}"

    async def exchange_code(
        self, *, code: str, redirect_uri: str, code_verifier: str
    ) -> OAuthTokens:
        return await self._token_request(
            {
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": redirect_uri,
                "client_id": self._client_id,
                "client_secret": self._client_secret,
                "code_verifier": code_verifier,
            }
        )

    async def get_current_user(self, user_access_token: str) -> CrmUser:
        response = await self._http.get(
            f"{self._base_url}/api/me", headers={"Authorization": f"Bearer {user_access_token}"}
        )
        if response.is_error:
            raise CRMError(f"GET /api/me failed: HTTP {response.status_code}")
        body = response.json()
        return CrmUser(
            crm_user_id=str(body["id"]),
            name=body.get("name"),
            email=body.get("email"),
            is_admin="admin" in body.get("roles", []),
        )

    # --- module API calls ---
    async def get_catalog(self) -> list[CatalogEntry]:
        body = await self._api("GET", "/api/catalog")
        return [
            CatalogEntry(
                external_id=str(item["id"]),
                name=item["name"],
                description=item.get("description"),
                price=Decimal(str(item["price"])) if item.get("price") is not None else None,
                currency=item.get("currency"),
                attributes=item.get("attributes") or {},
            )
            for item in body["items"]
        ]

    async def create_order(self, *, client_ref: str, lines: list[OrderLine]) -> CreatedOrder:
        body = await self._api(
            "POST",
            "/api/orders",
            json={
                "client_ref": client_ref,
                "lines": [{"product_id": ln.external_id, "quantity": ln.quantity} for ln in lines],
            },
        )
        return CreatedOrder(
            crm_order_id=str(body["id"]),
            status=self._status(body["status"]),
            payment_link=body.get("payment_url"),
        )

    async def get_order_status(self, crm_order_id: str) -> OrderState:
        body = await self._api("GET", f"/api/orders/{crm_order_id}")
        return OrderState(
            crm_order_id=str(body["id"]),
            status=self._status(body["status"]),
            changed_at=self._parse_dt(body.get("changed_at")),
        )

    async def cancel_order(self, crm_order_id: str) -> OrderState:
        body = await self._api("POST", f"/api/orders/{crm_order_id}/cancel")
        return OrderState(
            crm_order_id=str(body["id"]),
            status=self._status(body["status"]),
            changed_at=self._parse_dt(body.get("changed_at")),
        )

    # --- webhook ---
    def parse_webhook(self, headers: Mapping[str, str], body: bytes) -> OrderStatusEvent:
        lowered = {k.lower(): v for k, v in headers.items()}
        if not self._webhook_secret or not verify_hmac_sha256(
            self._webhook_secret, body, lowered.get("x-signature")
        ):
            raise InvalidWebhookSignature("CRM webhook signature is not valid")
        try:
            parsed = _WebhookBody.model_validate_json(body)
        except ValidationError as exc:
            raise CRMError("CRM webhook body is not valid") from exc
        if parsed.event != "order.status_changed":
            raise CRMError(f"Unsupported CRM event: {parsed.event!r}")
        return OrderStatusEvent(
            event_id=parsed.event_id,
            crm_order_id=parsed.order_id,
            status=self._status(parsed.status),
            changed_at=parsed.changed_at,
        )

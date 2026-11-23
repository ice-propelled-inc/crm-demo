"""In-process CRM mock for unit tests (no HTTP)."""

import json
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from itertools import count

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


@dataclass
class MockCRMAdapter(CRMAdapter):
    catalog: list[CatalogEntry] = field(default_factory=list)
    users: dict[str, CrmUser] = field(default_factory=dict)  # access token -> user
    orders: dict[str, OrderState] = field(default_factory=dict)
    created: list[tuple[str, list[OrderLine]]] = field(default_factory=list)
    webhook_secret: str = "mock-secret"  # noqa: S105 - test value
    _ids: count[int] = field(default_factory=lambda: count(1))

    def authorization_url(self, *, state: str, redirect_uri: str, code_challenge: str) -> str:
        return f"https://crm.mock/oauth/authorize?state={state}&redirect_uri={redirect_uri}"

    async def exchange_code(
        self, *, code: str, redirect_uri: str, code_verifier: str
    ) -> OAuthTokens:
        if code not in self.users:
            raise CRMError("unknown code")
        return OAuthTokens(access_token=code)

    async def get_current_user(self, user_access_token: str) -> CrmUser:
        try:
            return self.users[user_access_token]
        except KeyError as exc:
            raise CRMError("unknown token") from exc

    async def get_catalog(self) -> list[CatalogEntry]:
        return list(self.catalog)

    async def create_order(self, *, client_ref: str, lines: list[OrderLine]) -> CreatedOrder:
        order_id = f"MOCK-{next(self._ids)}"
        self.created.append((client_ref, lines))
        self.orders[order_id] = OrderState(
            order_id, OrderStatus.AWAITING_PAYMENT, datetime.now(UTC)
        )
        return CreatedOrder(order_id, OrderStatus.AWAITING_PAYMENT, f"https://pay.mock/{order_id}")

    async def get_order_status(self, crm_order_id: str) -> OrderState:
        try:
            return self.orders[crm_order_id]
        except KeyError as exc:
            raise CRMError("unknown order") from exc

    async def cancel_order(self, crm_order_id: str) -> OrderState:
        await self.get_order_status(crm_order_id)
        state = OrderState(crm_order_id, OrderStatus.CANCELLED, datetime.now(UTC))
        self.orders[crm_order_id] = state
        return state

    def parse_webhook(self, headers: Mapping[str, str], body: bytes) -> OrderStatusEvent:
        if headers.get("x-signature") != self.webhook_secret:
            raise InvalidWebhookSignature("bad signature")
        data = json.loads(body)
        return OrderStatusEvent(
            event_id=data["event_id"],
            crm_order_id=data["order_id"],
            status=OrderStatus(data["status"]),
            changed_at=datetime.fromisoformat(data["changed_at"]),
        )

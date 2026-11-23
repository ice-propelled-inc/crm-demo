"""CRM adapter interface. One adapter instance serves one tenant."""

from abc import ABC, abstractmethod
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal
from typing import Any

from app.domain.types import OrderStatus


class CRMError(Exception):
    """The CRM returned an error or an unexpected response."""


class InvalidWebhookSignature(CRMError):  # noqa: N818 - domain name
    """The webhook signature is missing or does not match."""


@dataclass(frozen=True)
class OAuthTokens:
    access_token: str
    refresh_token: str | None = None
    expires_in: int | None = None


@dataclass(frozen=True)
class CrmUser:
    crm_user_id: str
    name: str | None
    email: str | None
    is_admin: bool


@dataclass(frozen=True)
class CatalogEntry:
    external_id: str
    name: str
    description: str | None = None
    price: Decimal | None = None
    currency: str | None = None
    attributes: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class OrderLine:
    external_id: str
    quantity: int


@dataclass(frozen=True)
class CreatedOrder:
    crm_order_id: str
    status: OrderStatus
    payment_link: str | None


@dataclass(frozen=True)
class OrderState:
    crm_order_id: str
    status: OrderStatus
    changed_at: datetime | None


@dataclass(frozen=True)
class OrderStatusEvent:
    event_id: str
    crm_order_id: str
    status: OrderStatus
    changed_at: datetime


class CRMAdapter(ABC):
    # --- User login (OAuth authorization code with PKCE) ---
    @abstractmethod
    def authorization_url(self, *, state: str, redirect_uri: str, code_challenge: str) -> str: ...

    @abstractmethod
    async def exchange_code(
        self, *, code: str, redirect_uri: str, code_verifier: str
    ) -> OAuthTokens: ...

    @abstractmethod
    async def get_current_user(self, user_access_token: str) -> CrmUser: ...

    # --- API calls of the module (OAuth client credentials) ---
    @abstractmethod
    async def get_catalog(self) -> list[CatalogEntry]: ...

    @abstractmethod
    async def create_order(self, *, client_ref: str, lines: list[OrderLine]) -> CreatedOrder: ...

    @abstractmethod
    async def get_order_status(self, crm_order_id: str) -> OrderState: ...

    @abstractmethod
    async def cancel_order(self, crm_order_id: str) -> OrderState: ...

    # --- Incoming webhook (CRM -> module) ---
    @abstractmethod
    def parse_webhook(self, headers: Mapping[str, str], body: bytes) -> OrderStatusEvent:
        """Verify the signature and return the normalized event.

        Raises InvalidWebhookSignature or CRMError.
        """

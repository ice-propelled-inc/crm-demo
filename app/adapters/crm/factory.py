"""Build the CRM adapter of a tenant."""

from collections.abc import Callable
from functools import lru_cache

import httpx
from fastapi import Request

from app.adapters.crm.base import CRMAdapter
from app.adapters.crm.generic_http import GenericHttpCRMAdapter
from app.db.models import Tenant
from app.security import decrypt
from app.settings import get_settings

CRMAdapterFactory = Callable[[Tenant], CRMAdapter]


@lru_cache
def _shared_http() -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=15)


def build_crm_adapter(tenant: Tenant) -> CRMAdapter:
    return GenericHttpCRMAdapter(
        base_url=tenant.crm_base_url,
        client_id=tenant.crm_client_id,
        client_secret=decrypt(tenant.crm_client_secret_enc),
        webhook_secret=decrypt(tenant.crm_webhook_secret_enc)
        if tenant.crm_webhook_secret_enc
        else None,
        http=_shared_http(),
        authorize_base_url=get_settings().crm_authorize_base_override or None,
    )


def get_crm_adapter_factory(request: Request) -> CRMAdapterFactory:
    """FastAPI dependency: the factory of the runtime dependencies."""
    factory: CRMAdapterFactory = request.app.state.deps.crm_factory
    return factory

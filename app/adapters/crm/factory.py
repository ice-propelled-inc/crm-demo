"""Build the CRM adapter of a tenant. FastAPI dependency, so tests can replace it."""

from collections.abc import Callable
from functools import lru_cache

import httpx

from app.adapters.crm.base import CRMAdapter
from app.adapters.crm.generic_http import GenericHttpCRMAdapter
from app.db.models import Tenant
from app.security import decrypt

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
    )


def get_crm_adapter_factory() -> CRMAdapterFactory:
    return build_crm_adapter

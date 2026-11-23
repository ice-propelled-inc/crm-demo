"""Catalog source that reads the CRM product catalog through the CRM adapter."""

from app.adapters.catalog.base import CatalogSource
from app.adapters.crm.base import CatalogEntry, CRMAdapter


class CrmCatalogSource(CatalogSource):
    def __init__(self, crm: CRMAdapter) -> None:
        self._crm = crm

    async def fetch(self) -> list[CatalogEntry]:
        return await self._crm.get_catalog()

"""Catalog source interface: the CRM catalog or an external API."""

from abc import ABC, abstractmethod

from app.adapters.crm.base import CatalogEntry


class CatalogSource(ABC):
    @abstractmethod
    async def fetch(self) -> list[CatalogEntry]: ...

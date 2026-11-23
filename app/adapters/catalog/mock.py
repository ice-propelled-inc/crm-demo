"""In-process catalog source mock."""

from dataclasses import dataclass, field

from app.adapters.catalog.base import CatalogSource
from app.adapters.crm.base import CatalogEntry


@dataclass
class MockCatalogSource(CatalogSource):
    items: list[CatalogEntry] = field(default_factory=list)

    async def fetch(self) -> list[CatalogEntry]:
        return list(self.items)

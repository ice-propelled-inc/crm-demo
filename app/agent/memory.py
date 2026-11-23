"""pgvector retrieval: catalog search, client memory, few-shot dialog examples."""

import uuid

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import CatalogItem, DialogExample, MemoryItem
from app.domain.types import MemoryKind
from app.runtime import Deps


async def embed_one(deps: Deps, text: str) -> list[float]:
    [vector] = await deps.embedder.embed([text])
    return vector


async def search_catalog(
    session: AsyncSession, tenant_id: uuid.UUID, query: str, vector: list[float], k: int = 5
) -> list[CatalogItem]:
    """Keyword matches first, then the nearest items by embedding."""
    words = [w for w in query.split() if len(w) > 2][:5]
    keyword_hits: list[CatalogItem] = []
    if words:
        conditions = [CatalogItem.name.ilike(f"%{w}%") for w in words] + [
            CatalogItem.description.ilike(f"%{w}%") for w in words
        ]
        keyword_hits = list(
            (
                await session.scalars(
                    select(CatalogItem)
                    .where(CatalogItem.tenant_id == tenant_id, or_(*conditions))
                    .limit(k)
                )
            ).all()
        )
    nearest = (
        await session.scalars(
            select(CatalogItem)
            .where(CatalogItem.tenant_id == tenant_id, CatalogItem.embedding.is_not(None))
            .order_by(CatalogItem.embedding.cosine_distance(vector))
            .limit(k)
        )
    ).all()
    seen: set[uuid.UUID] = set()
    result: list[CatalogItem] = []
    for item in [*keyword_hits, *nearest]:
        if item.id not in seen:
            seen.add(item.id)
            result.append(item)
    return result[:k]


async def similar_memories(
    session: AsyncSession,
    tenant_id: uuid.UUID,
    client_id: uuid.UUID,
    vector: list[float],
    k: int = 3,
) -> list[str]:
    rows = await session.scalars(
        select(MemoryItem.content)
        .where(
            MemoryItem.tenant_id == tenant_id,
            MemoryItem.client_id == client_id,
            MemoryItem.embedding.is_not(None),
        )
        .order_by(MemoryItem.embedding.cosine_distance(vector))
        .limit(k)
    )
    return list(rows.all())


async def similar_examples(
    session: AsyncSession,
    tenant_id: uuid.UUID,
    language: str,
    tone_tag: str | None,
    vector: list[float],
    k: int = 3,
) -> list[str]:
    query = select(DialogExample.content).where(
        DialogExample.tenant_id == tenant_id,
        DialogExample.language == language,
        DialogExample.embedding.is_not(None),
    )
    if tone_tag:
        query = query.where(
            or_(DialogExample.tone_tag == tone_tag, DialogExample.tone_tag.is_(None))
        )
    rows = await session.scalars(
        query.order_by(DialogExample.embedding.cosine_distance(vector)).limit(k)
    )
    return list(rows.all())


async def save_memory(
    session: AsyncSession,
    deps: Deps,
    *,
    tenant_id: uuid.UUID,
    client_id: uuid.UUID,
    conversation_id: uuid.UUID | None,
    kind: MemoryKind,
    content: str,
) -> MemoryItem:
    item = MemoryItem(
        tenant_id=tenant_id,
        client_id=client_id,
        conversation_id=conversation_id,
        kind=kind.value,
        content=content,
        embedding=await embed_one(deps, content),
    )
    session.add(item)
    return item

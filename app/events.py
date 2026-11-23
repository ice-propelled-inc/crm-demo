"""Event bus for the operator chat (WebSocket). Events are small JSON objects.

- InMemoryEventBus: one process (tests, local runs).
- PostgresEventBus: more than one backend container. It uses Postgres LISTEN/NOTIFY.
"""

import asyncio
import contextlib
import json
import logging
import uuid
from abc import ABC, abstractmethod
from collections.abc import AsyncIterator
from typing import Any

import asyncpg

logger = logging.getLogger(__name__)

CHANNEL = "aich_events"
QUEUE_SIZE = 100


class EventBus(ABC):
    def __init__(self) -> None:
        self._subscribers: dict[uuid.UUID, set[asyncio.Queue[dict[str, Any]]]] = {}

    @abstractmethod
    async def publish(self, tenant_id: uuid.UUID, event: dict[str, Any]) -> None: ...

    def _dispatch(self, tenant_id: uuid.UUID, event: dict[str, Any]) -> None:
        for queue in self._subscribers.get(tenant_id, set()):
            with contextlib.suppress(asyncio.QueueFull):
                queue.put_nowait(event)  # a slow client loses events; it reloads the list

    @contextlib.asynccontextmanager
    async def subscribe(self, tenant_id: uuid.UUID) -> AsyncIterator[asyncio.Queue[dict[str, Any]]]:
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(QUEUE_SIZE)
        self._subscribers.setdefault(tenant_id, set()).add(queue)
        try:
            yield queue
        finally:
            self._subscribers[tenant_id].discard(queue)

    async def start(self) -> None:
        return None

    async def stop(self) -> None:
        return None


class InMemoryEventBus(EventBus):
    async def publish(self, tenant_id: uuid.UUID, event: dict[str, Any]) -> None:
        self._dispatch(tenant_id, event)


class PostgresEventBus(EventBus):
    def __init__(self, dsn: str) -> None:
        super().__init__()
        self._dsn = dsn.replace("postgresql+asyncpg://", "postgresql://")
        self._conn: asyncpg.Connection | None = None

    def _on_notify(self, _conn: object, _pid: int, _channel: str, payload: str) -> None:
        try:
            message = json.loads(payload)
            self._dispatch(uuid.UUID(message["tenant_id"]), message["event"])
        except (ValueError, KeyError):
            logger.warning("Bad event payload on %s", CHANNEL)

    async def start(self) -> None:
        self._conn = await asyncpg.connect(self._dsn)
        await self._conn.add_listener(CHANNEL, self._on_notify)

    async def stop(self) -> None:
        if self._conn is not None:
            await self._conn.close()
            self._conn = None

    async def publish(self, tenant_id: uuid.UUID, event: dict[str, Any]) -> None:
        payload = json.dumps({"tenant_id": str(tenant_id), "event": event}, default=str)
        if self._conn is None:
            conn = await asyncpg.connect(self._dsn)  # worker process: no listener
            try:
                await conn.execute("SELECT pg_notify($1, $2)", CHANNEL, payload)
            finally:
                await conn.close()
            return
        await self._conn.execute("SELECT pg_notify($1, $2)", CHANNEL, payload)

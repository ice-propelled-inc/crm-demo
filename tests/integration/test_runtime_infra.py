"""Postgres event bus, job retries, WebSocket and the CLI seed, with the real database."""

import asyncio
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.testclient import TestClient

from app.cli import seed_dev
from app.db.models import Channel, Job, Tenant
from app.db.session import get_sessionmaker
from app.events import PostgresEventBus
from app.main import create_app
from app.runtime import build_test_deps
from app.settings import Settings
from app.workers import jobs
from app.workers.jobs import JobKind, enqueue, run_due_jobs
from tests.conftest import TEST_DATABASE_URL

pytestmark = pytest.mark.integration


async def test_postgres_event_bus() -> None:
    listener, publisher = PostgresEventBus(TEST_DATABASE_URL), PostgresEventBus(TEST_DATABASE_URL)
    await listener.start()
    tenant = uuid.uuid4()
    try:
        async with listener.subscribe(tenant) as queue:
            await publisher.publish(tenant, {"type": "hello"})  # no listener: one-shot connection
            await listener.publish(uuid.uuid4(), {"type": "other tenant"})
            assert await asyncio.wait_for(queue.get(), 5) == {"type": "hello"}
            assert queue.empty()
            listener._on_notify(None, 0, "aich_events", "not json")
    finally:
        await listener.stop()
        await listener.stop()


async def test_failed_job_is_retried_then_marked_failed(
    db: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    tenant = Tenant(name="t", crm_base_url="http://x", crm_client_id="c", crm_client_secret_enc="x")
    db.add(tenant)
    await db.flush()
    now = datetime.now(UTC)
    enqueue(db, tenant_id=tenant.id, kind=JobKind.SEND_REPLY, payload={}, run_at=now)
    await db.commit()

    async def boom(*_args: object) -> None:
        raise ValueError("boom")

    import app.workers.handlers  # noqa: F401 - registers the real handlers first

    monkeypatch.setitem(jobs.HANDLERS, JobKind.SEND_REPLY, boom)
    deps = build_test_deps(Settings())
    clock = [now]
    deps.now = lambda: clock[0]
    for attempt in range(1, jobs.MAX_ATTEMPTS + 1):
        assert await run_due_jobs(get_sessionmaker(), deps) == 1
        async with get_sessionmaker()() as session:
            job = await session.scalar(select(Job).where(Job.tenant_id == tenant.id))
            assert job is not None and job.attempts == attempt
            assert "boom" in (job.last_error or "")
        clock[0] += timedelta(minutes=10)
    assert job.failed and job.done_at is not None
    assert await run_due_jobs(get_sessionmaker(), deps) == 0


async def test_cli_seed_dev_is_idempotent(db: AsyncSession) -> None:
    first = await seed_dev("http://mocks:8090")
    second = await seed_dev("http://mocks:8090")
    assert first == second
    channels = (
        await db.scalars(select(Channel).where(Channel.tenant_id == uuid.UUID(first["tenant_id"])))
    ).all()
    assert [c.kind for c in channels] == ["jivo"]


def test_websocket_pushes_tenant_events() -> None:
    import base64
    import json

    from itsdangerous import TimestampSigner

    deps = build_test_deps(Settings())
    app = create_app(deps)
    tenant = uuid.uuid4()

    def cookie(roles: list[str]) -> str:
        data = {"user": {"id": str(uuid.uuid4()), "tenant_id": str(tenant), "roles": roles}}
        raw = base64.b64encode(json.dumps(data).encode())
        return TimestampSigner(Settings().session_secret_key).sign(raw).decode()

    with TestClient(app) as client:
        client.cookies.set("aich_session", cookie(["operator"]))
        with client.websocket_connect("/operator/ws") as ws:
            client.portal.call(deps.events.publish, uuid.uuid4(), {"type": "other"})  # type: ignore[union-attr]
            client.portal.call(deps.events.publish, tenant, {"type": "message", "body": "hi"})  # type: ignore[union-attr]
            assert ws.receive_json() == {"type": "message", "body": "hi"}

        client.cookies.set("aich_session", cookie(["admin"]))
        with pytest.raises(Exception):  # noqa: B017 - closed with code 4401
            with client.websocket_connect("/operator/ws") as ws:
                ws.receive_json()

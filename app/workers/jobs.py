"""Postgres job queue. Webhooks enqueue; the worker runs due jobs.

A job runs in its own transaction. On error it is retried with a delay; after
MAX_ATTEMPTS it is marked failed.
"""

import logging
import traceback
import uuid
from collections.abc import Awaitable, Callable
from datetime import datetime, timedelta
from enum import StrEnum
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.db.models import Job
from app.runtime import Deps

logger = logging.getLogger(__name__)

MAX_ATTEMPTS = 5
RETRY_STEP = timedelta(seconds=30)


class JobKind(StrEnum):
    INBOUND_MESSAGE = "inbound_message"
    SEND_REPLY = "send_reply"
    CRM_STATUS = "crm_status"
    HANDOFF_TIMEOUT = "handoff_timeout"
    STATUS_POLL = "status_poll"


Handler = Callable[[AsyncSession, Deps, Job], Awaitable[None]]
HANDLERS: dict[JobKind, Handler] = {}


def handler(kind: JobKind) -> Callable[[Handler], Handler]:
    def register(func: Handler) -> Handler:
        HANDLERS[kind] = func
        return func

    return register


def enqueue(
    session: AsyncSession,
    *,
    tenant_id: uuid.UUID,
    kind: JobKind,
    payload: dict[str, Any],
    run_at: datetime,
) -> Job:
    job = Job(tenant_id=tenant_id, kind=kind.value, payload=payload, run_at=run_at)
    session.add(job)
    return job


async def run_due_jobs(
    sessionmaker: async_sessionmaker[AsyncSession], deps: Deps, *, limit: int = 20
) -> int:
    """Run the jobs that are due now. Returns the number of jobs that ran."""
    import app.workers.handlers  # noqa: F401 - registers the handlers

    ran = 0
    for _ in range(limit):
        async with sessionmaker() as session:
            job = await session.scalar(
                select(Job)
                .where(Job.done_at.is_(None), Job.run_at <= deps.now())
                .order_by(Job.run_at)
                .limit(1)
                .with_for_update(skip_locked=True)
            )
            if job is None:
                break
            ran += 1
            job_id = job.id
            try:
                await HANDLERS[JobKind(job.kind)](session, deps, job)
                job.done_at = deps.now()
                await session.commit()
            except Exception:
                await session.rollback()
                await _record_failure(sessionmaker, deps, job_id, traceback.format_exc())
    return ran


async def _record_failure(
    sessionmaker: async_sessionmaker[AsyncSession], deps: Deps, job_id: uuid.UUID, error: str
) -> None:
    async with sessionmaker() as session:
        job = await session.get(Job, job_id)
        if job is None:  # pragma: no cover - deleted by a parallel change
            return
        job.attempts += 1
        job.last_error = error[-4000:]
        if job.attempts >= MAX_ATTEMPTS:
            job.done_at = deps.now()
            job.failed = True
            logger.error("Job %s (%s) failed: %s", job.id, job.kind, error.splitlines()[-1])
        else:
            job.run_at = deps.now() + RETRY_STEP * job.attempts
            logger.warning("Job %s (%s) error, retry %d", job.id, job.kind, job.attempts)
        await session.commit()

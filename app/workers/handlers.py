"""Job handlers. Imported by `run_due_jobs`, which registers them."""

import logging
import uuid
from dataclasses import asdict
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.adapters.channels.base import InboundMessage
from app.agent.turn import handle_inbound
from app.db.models import Channel, Client, Conversation, Job, Order, Tenant
from app.domain.state_machine import ai_may_reply
from app.domain.types import ChannelKind, ConversationState, OrderStatus
from app.runtime import Deps
from app.services.conversations import send_to_client
from app.services.handoff import on_accept_timeout
from app.services.orders import apply_status_change, poll_unfinished_orders
from app.tenant_settings import load_tenant_settings
from app.workers.jobs import JobKind, enqueue, handler

logger = logging.getLogger(__name__)


def inbound_to_payload(channel_id: uuid.UUID, message: InboundMessage) -> dict[str, Any]:
    data = asdict(message)
    data["channel"] = message.channel.value
    data["received_at"] = message.received_at.isoformat()
    return {"channel_id": str(channel_id), "message": data}


def inbound_from_payload(data: dict[str, Any]) -> InboundMessage:
    return InboundMessage(
        **{
            **data,
            "channel": ChannelKind(data["channel"]),
            "received_at": datetime.fromisoformat(data["received_at"]),
        }
    )


@handler(JobKind.INBOUND_MESSAGE)
async def _inbound(session: AsyncSession, deps: Deps, job: Job) -> None:
    channel = await session.get_one(Channel, uuid.UUID(job.payload["channel_id"]))
    await handle_inbound(session, deps, channel, inbound_from_payload(job.payload["message"]))


@handler(JobKind.SEND_REPLY)
async def _send_reply(session: AsyncSession, deps: Deps, job: Job) -> None:
    conversation = await session.get(Conversation, uuid.UUID(job.payload["conversation_id"]))
    if conversation is None:
        return
    channel = await session.get_one(Channel, conversation.channel_id)
    client = await session.get_one(Client, conversation.client_id)
    adapter = deps.channel_factory(channel)
    if adapter.supports_typing:
        await adapter.set_typing(
            client.channel_user_id, False, thread_ref=conversation.channel_thread_ref
        )
    if not ai_may_reply(ConversationState(conversation.state)):
        logger.info("Reply for %s dropped: a handoff started", conversation.id)
        return
    await send_to_client(session, deps, conversation, job.payload["text"])


@handler(JobKind.CRM_STATUS)
async def _crm_status(session: AsyncSession, deps: Deps, job: Job) -> None:
    order = await session.scalar(
        select(Order).where(
            Order.tenant_id == job.tenant_id, Order.crm_order_id == job.payload["crm_order_id"]
        )
    )
    if order is None:
        logger.info("Status event for an unknown order %s", job.payload["crm_order_id"])
        return
    await apply_status_change(
        session,
        deps,
        order,
        OrderStatus(job.payload["status"]),
        datetime.fromisoformat(job.payload["changed_at"]),
    )


@handler(JobKind.HANDOFF_TIMEOUT)
async def _handoff_timeout(session: AsyncSession, deps: Deps, job: Job) -> None:
    await on_accept_timeout(
        session,
        deps,
        uuid.UUID(job.payload["handoff_id"]),
        uuid.UUID(job.payload["operator_id"]),
    )


@handler(JobKind.STATUS_POLL)
async def _status_poll(session: AsyncSession, deps: Deps, job: Job) -> None:
    tenant = await session.get(Tenant, job.tenant_id)
    if tenant is None:
        return
    changed = await poll_unfinished_orders(session, deps, tenant)
    if changed:
        logger.info("Status check: %d orders changed for tenant %s", changed, tenant.id)
    settings = await load_tenant_settings(session, tenant.id)
    enqueue(
        session,
        tenant_id=tenant.id,
        kind=JobKind.STATUS_POLL,
        payload={},
        run_at=deps.now() + timedelta(minutes=settings.status_check_interval_minutes),
    )


async def ensure_status_polls(session: AsyncSession, deps: Deps) -> int:
    """Each tenant has one waiting status check job. Returns the number of new jobs."""
    tenants = (await session.scalars(select(Tenant.id))).all()
    waiting = set(
        (
            await session.scalars(
                select(Job.tenant_id).where(
                    Job.kind == JobKind.STATUS_POLL.value, Job.done_at.is_(None)
                )
            )
        ).all()
    )
    created = 0
    for tenant_id in tenants:
        if tenant_id not in waiting:
            enqueue(
                session,
                tenant_id=tenant_id,
                kind=JobKind.STATUS_POLL,
                payload={},
                run_at=deps.now(),
            )
            created += 1
    await session.commit()
    return created

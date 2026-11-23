"""Admin "Test chat": the admin plays a client on the web test channel.

The messages go through the same job queue and agent turn as a real channel. Each turn
keeps a trace of what the rules decided. The worker must run (docker compose `worker`).
"""

import uuid
from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.adapters.channels.base import InboundMessage
from app.auth.deps import CurrentUser, require_roles
from app.db.models import (
    Channel,
    Client,
    Conversation,
    Handoff,
    Job,
    Message,
    Operator,
    Order,
    TurnTrace,
    User,
)
from app.db.session import get_session
from app.domain.types import ChannelKind, Role
from app.runtime import Deps, get_deps
from app.workers.handlers import inbound_to_payload
from app.workers.jobs import JobKind, enqueue

router = APIRouter(prefix="/admin/api/test-chat", tags=["admin test chat"])

Session = Annotated[AsyncSession, Depends(get_session)]
DepsDep = Annotated[Deps, Depends(get_deps)]
Admin = Annotated[CurrentUser, Depends(require_roles(Role.ADMIN))]

TEST_CHANNEL_ID = "admin-test"


class TestSession(BaseModel):
    client_ref: str


class TestMessageIn(BaseModel):
    client_ref: str
    text: str = Field(min_length=1, max_length=4000)


class TestMessage(BaseModel):
    id: uuid.UUID
    sender: str
    body: str
    created_at: datetime


class TestTrace(BaseModel):
    id: uuid.UUID
    message_id: uuid.UUID | None
    created_at: datetime
    data: dict[str, Any]


class TestHandoff(BaseModel):
    id: uuid.UUID
    status: str
    trigger: str
    operator_name: str | None
    summary: str | None
    alerts: list[dict[str, Any]]


class TestOrder(BaseModel):
    crm_order_id: str
    status: str
    payment_link: str | None


class TestChatState(BaseModel):
    client_ref: str
    conversation_id: uuid.UUID | None
    state: str | None
    language: str | None
    funnel_stage: str | None
    human_request_count: int
    off_topic_count: int
    pending_confirmation: dict[str, Any] | None
    messages: list[TestMessage]
    traces: list[TestTrace]
    handoff: TestHandoff | None
    orders: list[TestOrder]
    queued_turns: int
    thinking_since: datetime | None
    typing_until: datetime | None
    oldest_waiting_job_seconds: float | None


async def _test_channel(session: AsyncSession, tenant_id: uuid.UUID) -> Channel:
    channel = await session.scalar(
        select(Channel).where(
            Channel.tenant_id == tenant_id,
            Channel.kind == ChannelKind.TEST.value,
            Channel.external_id == TEST_CHANNEL_ID,
        )
    )
    if channel is None:
        channel = Channel(
            tenant_id=tenant_id, kind=ChannelKind.TEST.value, external_id=TEST_CHANNEL_ID
        )
        session.add(channel)
        await session.flush()
    return channel


async def _client(
    session: AsyncSession, user: CurrentUser, client_ref: str
) -> tuple[Channel, Client]:
    channel = await _test_channel(session, user.tenant_id)
    client = await session.scalar(
        select(Client).where(Client.channel_id == channel.id, Client.channel_user_id == client_ref)
    )
    if client is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Unknown test client")
    return channel, client


@router.post("/sessions", status_code=status.HTTP_201_CREATED)
async def new_session(user: Admin, session: Session) -> TestSession:
    """A new test client, so each test conversation starts from zero."""
    channel = await _test_channel(session, user.tenant_id)
    suffix = uuid.uuid4().hex[:8]
    session.add(
        Client(
            tenant_id=user.tenant_id,
            channel_id=channel.id,
            channel_user_id=f"tester-{suffix}",
            display_name=f"Test client {suffix[:4]}",
        )
    )
    await session.commit()
    return TestSession(client_ref=f"tester-{suffix}")


@router.post("/messages", status_code=status.HTTP_202_ACCEPTED)
async def send_test_message(
    body: TestMessageIn, user: Admin, session: Session, deps: DepsDep
) -> dict[str, bool]:
    channel, client = await _client(session, user, body.client_ref)
    message = InboundMessage(
        channel=ChannelKind.TEST,
        client_ref=client.channel_user_id,
        text=body.text,
        provider_message_id=f"test-{uuid.uuid4().hex}",
        received_at=deps.now(),
        display_name=client.display_name,
    )
    enqueue(
        session,
        tenant_id=user.tenant_id,
        kind=JobKind.INBOUND_MESSAGE,
        payload=inbound_to_payload(channel.id, message),
        run_at=deps.now(),
    )
    await session.commit()
    return {"queued": True}


@router.get("/conversation")
async def test_conversation(
    client_ref: str, user: Admin, session: Session, deps: DepsDep
) -> TestChatState:
    _channel, client = await _client(session, user, client_ref)
    now = deps.now()
    queued_row = (
        await session.execute(
            select(func.count(), func.min(Job.created_at)).where(
                Job.tenant_id == user.tenant_id,
                Job.done_at.is_(None),
                Job.kind == JobKind.INBOUND_MESSAGE.value,
                Job.payload["message"]["client_ref"].astext == client_ref,
            )
        )
    ).one()
    queued, thinking_since = queued_row
    oldest = await session.scalar(
        select(func.min(Job.run_at)).where(
            Job.tenant_id == user.tenant_id, Job.done_at.is_(None), Job.run_at <= now
        )
    )
    state = TestChatState(
        client_ref=client_ref,
        conversation_id=None,
        state=None,
        language=None,
        funnel_stage=None,
        human_request_count=0,
        off_topic_count=0,
        pending_confirmation=None,
        messages=[],
        traces=[],
        handoff=None,
        orders=[],
        queued_turns=int(queued or 0),
        thinking_since=thinking_since,
        typing_until=None,
        oldest_waiting_job_seconds=(now - oldest).total_seconds() if oldest else None,
    )
    conversation = await session.scalar(
        select(Conversation).where(Conversation.client_id == client.id).limit(1)
    )
    if conversation is None:
        return state

    messages = (
        await session.scalars(
            select(Message)
            .where(Message.conversation_id == conversation.id)
            .order_by(Message.created_at, Message.id)
        )
    ).all()
    traces = (
        await session.scalars(
            select(TurnTrace)
            .where(TurnTrace.conversation_id == conversation.id)
            .order_by(TurnTrace.created_at)
        )
    ).all()
    typing_until = await session.scalar(
        select(func.max(Job.run_at)).where(
            Job.tenant_id == user.tenant_id,
            Job.done_at.is_(None),
            Job.kind == JobKind.SEND_REPLY.value,
            Job.payload["conversation_id"].astext == str(conversation.id),
        )
    )
    handoff_row = await session.scalar(
        select(Handoff)
        .where(Handoff.conversation_id == conversation.id)
        .order_by(Handoff.requested_at.desc())
        .limit(1)
    )
    handoff = None
    if handoff_row is not None:
        operator_name = None
        if handoff_row.operator_id:
            operator_name = await session.scalar(
                select(User.name)
                .join(Operator, Operator.user_id == User.id)
                .where(Operator.id == handoff_row.operator_id)
            )
        handoff = TestHandoff(
            id=handoff_row.id,
            status=handoff_row.status,
            trigger=handoff_row.trigger,
            operator_name=operator_name,
            summary=handoff_row.summary,
            alerts=handoff_row.alerts,
        )
    orders = (
        await session.scalars(select(Order).where(Order.conversation_id == conversation.id))
    ).all()
    return state.model_copy(
        update={
            "conversation_id": conversation.id,
            "state": conversation.state,
            "language": conversation.language,
            "funnel_stage": conversation.funnel_stage,
            "human_request_count": conversation.human_request_count,
            "off_topic_count": conversation.off_topic_count,
            "pending_confirmation": conversation.pending_confirmation,
            "messages": [
                TestMessage(id=m.id, sender=m.sender, body=m.body, created_at=m.created_at)
                for m in messages
            ],
            "traces": [
                TestTrace(id=t.id, message_id=t.message_id, created_at=t.created_at, data=t.data)
                for t in traces
            ],
            "handoff": handoff,
            "orders": [
                TestOrder(crm_order_id=o.crm_order_id, status=o.status, payment_link=o.payment_link)
                for o in orders
            ],
            "typing_until": typing_until,
        }
    )

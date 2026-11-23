"""Operator chat API and WebSocket. Each query is limited to the tenant of the user."""

import asyncio
import contextlib
import uuid
from datetime import datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import SESSION_USER_KEY, CurrentUser, require_roles
from app.db.models import Channel, Client, Conversation, Handoff, Message, Operator, Order, User
from app.db.session import get_session
from app.domain.state_machine import is_out_to_ai_command
from app.domain.types import ConversationState, HandoffStatus, Role
from app.runtime import Deps, get_deps
from app.services import handoff as handoff_service

router = APIRouter(prefix="/operator/api", tags=["operator"])
ws_router = APIRouter(tags=["operator"])

Session = Annotated[AsyncSession, Depends(get_session)]
DepsDep = Annotated[Deps, Depends(get_deps)]
OperatorUser = Annotated[CurrentUser, Depends(require_roles(Role.OPERATOR, Role.URGENT_MANAGER))]

ACTIVE_HANDOFF = (HandoffStatus.PENDING.value, HandoffStatus.ACTIVE.value)


class HandoffOut(BaseModel):
    id: uuid.UUID
    conversation_id: uuid.UUID
    trigger: str
    status: str
    operator_id: uuid.UUID | None
    operator_name: str | None = None
    mine: bool = False
    summary: str | None
    alerts: list[dict[str, Any]]
    requested_at: datetime
    accepted_at: datetime | None
    closed_at: datetime | None


class ConversationItem(BaseModel):
    id: uuid.UUID
    client_name: str | None
    channel: str
    state: str
    language: str | None
    last_message: str | None
    last_message_at: datetime | None
    handoff: HandoffOut | None


class MessageOut(BaseModel):
    id: uuid.UUID
    sender: str
    body: str
    created_at: datetime


class OrderOut(BaseModel):
    crm_order_id: str
    status: str
    payment_link: str | None
    created_at: datetime


class ConversationDetail(ConversationItem):
    messages: list[MessageOut]
    orders: list[OrderOut]
    handoffs: list[HandoffOut]


class OperatorMe(BaseModel):
    user_id: uuid.UUID
    roles: list[str]
    operator_id: uuid.UUID | None
    is_available: bool | None


class AvailabilityIn(BaseModel):
    is_available: bool


class MessageIn(BaseModel):
    text: str = Field(min_length=1, max_length=4000)


class MessageResult(BaseModel):
    status: Literal["sent", "not_delivered", "returned_to_ai"]


async def _operator(session: AsyncSession, user: CurrentUser) -> Operator | None:
    result: Operator | None = await session.scalar(
        select(Operator).where(Operator.tenant_id == user.tenant_id, Operator.user_id == user.id)
    )
    return result


async def _conversation(session: AsyncSession, user: CurrentUser, cid: uuid.UUID) -> Conversation:
    conversation = await session.get(Conversation, cid)
    if conversation is None or conversation.tenant_id != user.tenant_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Unknown conversation")
    return conversation


async def _handoff_out(
    session: AsyncSession, handoff: Handoff, operator: Operator | None
) -> HandoffOut:
    name = None
    if handoff.operator_id:
        name = await session.scalar(
            select(User.name)
            .join(Operator, Operator.user_id == User.id)
            .where(Operator.id == handoff.operator_id)
        )
    return HandoffOut(
        id=handoff.id,
        conversation_id=handoff.conversation_id,
        trigger=handoff.trigger,
        status=handoff.status,
        operator_id=handoff.operator_id,
        operator_name=name,
        mine=operator is not None and handoff.operator_id == operator.id,
        summary=handoff.summary,
        alerts=handoff.alerts,
        requested_at=handoff.requested_at,
        accepted_at=handoff.accepted_at,
        closed_at=handoff.closed_at,
    )


async def _item(
    session: AsyncSession, conversation: Conversation, operator: Operator | None
) -> ConversationItem:
    client = await session.get_one(Client, conversation.client_id)
    channel = await session.get_one(Channel, conversation.channel_id)
    last = await session.scalar(
        select(Message)
        .where(Message.conversation_id == conversation.id)
        .order_by(Message.created_at.desc())
        .limit(1)
    )
    handoff = await handoff_service.active_handoff(session, conversation.id)
    return ConversationItem(
        id=conversation.id,
        client_name=client.display_name or client.channel_user_id,
        channel=channel.kind,
        state=conversation.state,
        language=conversation.language,
        last_message=last.body[:200] if last else None,
        last_message_at=last.created_at if last else None,
        handoff=await _handoff_out(session, handoff, operator) if handoff else None,
    )


@router.get("/me")
async def me(user: OperatorUser, session: Session) -> OperatorMe:
    operator = await _operator(session, user)
    return OperatorMe(
        user_id=user.id,
        roles=sorted(r.value for r in user.roles),
        operator_id=operator.id if operator else None,
        is_available=operator.is_available if operator else None,
    )


@router.put("/me/availability")
async def set_availability(
    body: AvailabilityIn, user: OperatorUser, session: Session
) -> OperatorMe:
    operator = await _operator(session, user)
    if operator is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "You are not an operator")
    operator.is_available = body.is_available
    await session.commit()
    return await me(user, session)


@router.get("/conversations")
async def list_conversations(
    user: OperatorUser,
    session: Session,
    scope: Literal["active", "all"] = "active",
    limit: int = 50,
) -> list[ConversationItem]:
    query = select(Conversation).where(Conversation.tenant_id == user.tenant_id)
    if scope == "active":
        query = query.where(Conversation.state != ConversationState.AI_ACTIVE.value)
    rows = (
        await session.scalars(query.order_by(Conversation.updated_at.desc()).limit(min(limit, 200)))
    ).all()
    operator = await _operator(session, user)
    return [await _item(session, c, operator) for c in rows]


@router.get("/conversations/{conversation_id}")
async def get_conversation(
    conversation_id: uuid.UUID, user: OperatorUser, session: Session
) -> ConversationDetail:
    conversation = await _conversation(session, user, conversation_id)
    operator = await _operator(session, user)
    item = await _item(session, conversation, operator)
    messages = (
        await session.scalars(
            select(Message)
            .where(Message.conversation_id == conversation.id)
            .order_by(Message.created_at, Message.id)
        )
    ).all()
    orders = (
        await session.scalars(
            select(Order)
            .where(Order.conversation_id == conversation.id)
            .order_by(Order.created_at.desc())
        )
    ).all()
    handoffs = (
        await session.scalars(
            select(Handoff)
            .where(Handoff.conversation_id == conversation.id)
            .order_by(Handoff.requested_at.desc())
        )
    ).all()
    return ConversationDetail(
        **item.model_dump(),
        messages=[
            MessageOut(id=m.id, sender=m.sender, body=m.body, created_at=m.created_at)
            for m in messages
        ],
        orders=[
            OrderOut(
                crm_order_id=o.crm_order_id,
                status=o.status,
                payment_link=o.payment_link,
                created_at=o.created_at,
            )
            for o in orders
        ],
        handoffs=[await _handoff_out(session, h, operator) for h in handoffs],
    )


@router.post("/handoffs/{handoff_id}/accept")
async def accept_handoff(
    handoff_id: uuid.UUID, user: OperatorUser, session: Session, deps: DepsDep
) -> HandoffOut:
    handoff = await session.get(Handoff, handoff_id)
    if handoff is None or handoff.tenant_id != user.tenant_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Unknown handoff")
    operator = await _operator(session, user)
    if operator is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "You are not an operator")
    try:
        await handoff_service.accept(session, deps, handoff, operator)
    except handoff_service.HandoffError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    await session.commit()
    return await _handoff_out(session, handoff, operator)


@router.post("/conversations/{conversation_id}/messages")
async def send_message(
    conversation_id: uuid.UUID, body: MessageIn, user: OperatorUser, session: Session, deps: DepsDep
) -> MessageResult:
    conversation = await _conversation(session, user, conversation_id)
    operator = await _operator(session, user)
    handoff = await handoff_service.active_handoff(session, conversation.id)
    if (
        operator is None
        or handoff is None
        or handoff.status != HandoffStatus.ACTIVE.value
        or handoff.operator_id != operator.id
    ):
        raise HTTPException(status.HTTP_409_CONFLICT, "You do not handle this conversation")
    if is_out_to_ai_command(body.text):
        await handoff_service.out_to_ai(session, deps, handoff)
        await session.commit()
        return MessageResult(status="returned_to_ai")
    delivered = await handoff_service.operator_reply(session, deps, conversation, body.text)
    await session.commit()
    return MessageResult(status="sent" if delivered else "not_delivered")


@router.get("/handoffs")
async def handoff_log(user: OperatorUser, session: Session, limit: int = 100) -> list[HandoffOut]:
    rows = (
        await session.scalars(
            select(Handoff)
            .where(Handoff.tenant_id == user.tenant_id)
            .order_by(Handoff.requested_at.desc())
            .limit(min(limit, 500))
        )
    ).all()
    operator = await _operator(session, user)
    return [await _handoff_out(session, h, operator) for h in rows]


@router.get("/stats")
async def stats(user: OperatorUser, session: Session) -> dict[str, int]:
    waiting = await session.scalar(
        select(func.count())
        .select_from(Handoff)
        .where(Handoff.tenant_id == user.tenant_id, Handoff.status.in_(ACTIVE_HANDOFF))
    )
    return {"active_handoffs": int(waiting or 0)}


@ws_router.websocket("/operator/ws")
async def operator_ws(websocket: WebSocket) -> None:
    """Pushes the tenant events (new messages, handoffs, order status) to the operator chat."""
    data = websocket.scope.get("session", {}).get(SESSION_USER_KEY)
    roles = set(data.get("roles", [])) if isinstance(data, dict) else set()
    if not roles & {Role.OPERATOR.value, Role.URGENT_MANAGER.value}:
        await websocket.close(code=4401)
        return
    assert isinstance(data, dict)
    tenant_id = uuid.UUID(data["tenant_id"])
    deps: Deps = websocket.app.state.deps
    await websocket.accept()
    async with deps.events.subscribe(tenant_id) as queue:
        receiver = asyncio.create_task(_drain(websocket))
        try:
            while not receiver.done():
                getter = asyncio.create_task(queue.get())
                done, _ = await asyncio.wait(
                    {getter, receiver}, return_when=asyncio.FIRST_COMPLETED
                )
                if getter in done:
                    await websocket.send_json(getter.result())
                else:
                    getter.cancel()
        finally:
            receiver.cancel()
            with contextlib.suppress(asyncio.CancelledError, WebSocketDisconnect):
                await receiver


async def _drain(websocket: WebSocket) -> None:
    """Read (and ignore) client frames until the client disconnects."""
    with contextlib.suppress(WebSocketDisconnect):
        while True:
            await websocket.receive_text()

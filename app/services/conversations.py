"""Conversations, messages and delivery to the client channel."""

import logging
import uuid
from datetime import timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.adapters.channels.base import DeliveryResult, InboundMessage
from app.adapters.llm.base import ChatMessage
from app.db.models import Channel, Client, Conversation, Message, PendingMessage
from app.domain.delays import DelayConfig, reply_delay
from app.domain.orders import PENDING_MESSAGE_MIN_RETENTION
from app.domain.types import MessageSender
from app.runtime import Deps
from app.workers.jobs import JobKind, enqueue

logger = logging.getLogger(__name__)

HISTORY_LIMIT = 20


async def publish(deps: Deps, tenant_id: uuid.UUID, event_type: str, **data: Any) -> None:
    await deps.events.publish(tenant_id, {"type": event_type, **data})


async def get_or_create_conversation(
    session: AsyncSession, channel: Channel, inbound: InboundMessage
) -> tuple[Client, Conversation]:
    client = await session.scalar(
        select(Client).where(
            Client.tenant_id == channel.tenant_id,
            Client.channel_id == channel.id,
            Client.channel_user_id == inbound.client_ref,
        )
    )
    if client is None:
        client = Client(
            tenant_id=channel.tenant_id,
            channel_id=channel.id,
            channel_user_id=inbound.client_ref,
            display_name=inbound.display_name,
        )
        session.add(client)
        await session.flush()
    conversation = await session.scalar(
        select(Conversation)
        .where(Conversation.client_id == client.id)
        .order_by(Conversation.created_at.desc())
        .limit(1)
    )
    if conversation is None:
        conversation = Conversation(
            tenant_id=channel.tenant_id,
            channel_id=channel.id,
            client_id=client.id,
            human_request_count=0,
            off_topic_count=0,
        )
        session.add(conversation)
    if inbound.thread_ref:
        conversation.channel_thread_ref = inbound.thread_ref
    await session.flush()
    return client, conversation


def add_message(
    session: AsyncSession,
    conversation: Conversation,
    sender: MessageSender,
    body: str,
    provider_message_id: str | None = None,
) -> Message:
    message = Message(
        tenant_id=conversation.tenant_id,
        conversation_id=conversation.id,
        sender=sender.value,
        body=body,
        provider_message_id=provider_message_id,
    )
    session.add(message)
    return message


async def chat_history(
    session: AsyncSession, conversation_id: uuid.UUID, limit: int = HISTORY_LIMIT
) -> list[ChatMessage]:
    rows = (
        await session.scalars(
            select(Message)
            .where(Message.conversation_id == conversation_id)
            .order_by(Message.created_at.desc(), Message.id.desc())
            .limit(limit)
        )
    ).all()
    history: list[ChatMessage] = []
    for row in reversed(rows):
        if row.sender == MessageSender.CLIENT:
            history.append(ChatMessage("user", row.body))
        elif row.sender in (MessageSender.AI, MessageSender.OPERATOR):
            history.append(ChatMessage("assistant", row.body))
    return history


async def send_to_client(
    session: AsyncSession,
    deps: Deps,
    conversation: Conversation,
    text: str,
    *,
    sender: MessageSender = MessageSender.AI,
    keep_if_undelivered: bool = True,
) -> DeliveryResult:
    """Send now. A delivered message is saved; an undelivered one waits in pending_messages."""
    channel = await session.get_one(Channel, conversation.channel_id)
    client = await session.get_one(Client, conversation.client_id)
    adapter = deps.channel_factory(channel)
    result = await adapter.send_message(
        client.channel_user_id,
        text,
        thread_ref=conversation.channel_thread_ref,
        human_agent=sender is MessageSender.OPERATOR,
    )
    if result.delivered:
        message = add_message(session, conversation, sender, text, result.provider_message_id)
        await session.flush()
        await publish(
            deps,
            conversation.tenant_id,
            "message",
            conversation_id=str(conversation.id),
            message_id=str(message.id),
            sender=sender.value,
            body=text,
        )
    elif keep_if_undelivered:
        keep_pending(session, deps, conversation, text, result.reason or "undelivered")
        logger.info("Message to %s kept as pending: %s", conversation.id, result.reason)
    return result


def keep_pending(
    session: AsyncSession, deps: Deps, conversation: Conversation, text: str, reason: str
) -> PendingMessage:
    pending = PendingMessage(
        tenant_id=conversation.tenant_id,
        conversation_id=conversation.id,
        body=text,
        reason=reason,
        keep_until=deps.now() + PENDING_MESSAGE_MIN_RETENTION,
    )
    session.add(pending)
    return pending


async def deliver_pending(session: AsyncSession, deps: Deps, conversation: Conversation) -> int:
    """The client wrote again: send the kept messages first, oldest first."""
    rows = (
        await session.scalars(
            select(PendingMessage)
            .where(
                PendingMessage.conversation_id == conversation.id,
                PendingMessage.delivered_at.is_(None),
                PendingMessage.keep_until >= deps.now(),
            )
            .order_by(PendingMessage.created_at, PendingMessage.id)
        )
    ).all()
    sent = 0
    for pending in rows:
        result = await send_to_client(
            session, deps, conversation, pending.body, keep_if_undelivered=False
        )
        if not result.delivered:
            break
        pending.delivered_at = deps.now()
        sent += 1
    return sent


async def schedule_reply(
    session: AsyncSession,
    deps: Deps,
    conversation: Conversation,
    text: str,
    delays: DelayConfig,
) -> float:
    """Show "typing..." and send the reply after a delay that looks human."""
    delay = reply_delay(delays, len(text), deps.rng)
    channel = await session.get_one(Channel, conversation.channel_id)
    client = await session.get_one(Client, conversation.client_id)
    adapter = deps.channel_factory(channel)
    if adapter.supports_typing:
        await adapter.set_typing(
            client.channel_user_id, True, thread_ref=conversation.channel_thread_ref
        )
    enqueue(
        session,
        tenant_id=conversation.tenant_id,
        kind=JobKind.SEND_REPLY,
        payload={"conversation_id": str(conversation.id), "text": text},
        run_at=deps.now() + timedelta(seconds=delay),
    )
    return delay

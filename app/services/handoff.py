"""Handoff to a human operator: selection, WhatsApp notification, timeout, urgent alerts."""

import logging
import uuid
from datetime import timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.adapters.llm.base import ChatMessage, LLMRequest
from app.adapters.telephony.base import URGENT_CALL_TEXT
from app.agent.memory import save_memory
from app.agent.prompts import resolve_prompt
from app.db.models import Conversation, Handoff, Message, Operator, UrgentManager
from app.domain.state_machine import ConversationEvent, next_state
from app.domain.types import (
    CommunicationType,
    ConversationState,
    HandoffStatus,
    HandoffTrigger,
    MemoryKind,
    MessageSender,
)
from app.runtime import Deps
from app.services.conversations import chat_history, publish, send_to_client
from app.tenant_settings import load_tenant_settings
from app.workers.jobs import JobKind, enqueue

logger = logging.getLogger(__name__)

SUMMARY_SYSTEM = (
    "Summarise this shop chat for a human operator in at most 3 short lines, in English: "
    "what the client wants, what the bot did, and why a human is needed."
)


def operator_chat_link(deps: Deps, conversation: Conversation) -> str:
    base = deps.settings.operator_chat_url.rstrip("/")
    return f"{base}/?tenant={conversation.tenant_id}#/conversations/{conversation.id}"


def _alert(handoff: Handoff, deps: Deps, kind: str, **data: Any) -> None:
    entry = {"type": kind, "at": deps.now().isoformat(), **data}
    handoff.alerts = [*handoff.alerts, entry]
    logger.warning("Handoff %s alert: %s %s", handoff.id, kind, data)


async def _summary(session: AsyncSession, deps: Deps, conversation: Conversation) -> str:
    history = await chat_history(session, conversation.id)
    transcript = "\n".join(f"{m.role}: {m.content}" for m in history) or "(no messages)"
    response = await deps.llm.complete(
        LLMRequest(
            model=deps.settings.llm_model_fast,
            system=SUMMARY_SYSTEM,
            messages=[ChatMessage("user", transcript)],
            max_tokens=200,
        )
    )
    return response.text.strip()


async def start_handoff(
    session: AsyncSession, deps: Deps, conversation: Conversation, trigger: HandoffTrigger
) -> Handoff:
    settings = await load_tenant_settings(session, conversation.tenant_id)
    conversation.state = next_state(
        ConversationState(conversation.state), ConversationEvent.HANDOFF_TRIGGERED
    ).value
    handoff = Handoff(
        tenant_id=conversation.tenant_id,
        conversation_id=conversation.id,
        trigger=trigger.value,
        status=HandoffStatus.PENDING.value,
        tried_operator_ids=[],
        alerts=[],
        summary=await _summary(session, deps, conversation),
    )
    session.add(handoff)
    await session.flush()

    language = conversation.language or settings.default_language
    escalation = await resolve_prompt(
        session, conversation.tenant_id, "escalation", language, settings.default_language
    )
    await send_to_client(session, deps, conversation, escalation.strip())
    await assign_next_operator(session, deps, conversation, handoff)
    return handoff


async def assign_next_operator(
    session: AsyncSession, deps: Deps, conversation: Conversation, handoff: Handoff
) -> Operator | None:
    """Select the next available operator (least recently assigned) and notify by WhatsApp."""
    settings = await load_tenant_settings(session, conversation.tenant_id)
    candidates = (
        await session.scalars(
            select(Operator)
            .where(
                Operator.tenant_id == conversation.tenant_id,
                Operator.is_available.is_(True),
                Operator.id.not_in(handoff.tried_operator_ids or [uuid.UUID(int=0)]),
            )
            .order_by(Operator.last_assigned_at.asc().nulls_first(), Operator.created_at)
        )
    ).all()
    link = operator_chat_link(deps, conversation)
    for operator in candidates:
        handoff.tried_operator_ids = [*handoff.tried_operator_ids, operator.id]
        try:
            await deps.whatsapp.send_template(
                to=operator.whatsapp_number,
                template_name=deps.settings.whatsapp_template_name,
                language=settings.notification_language,
                parameters=[link],
            )
        except Exception as exc:
            _alert(
                handoff, deps, "notification_failed", operator_id=str(operator.id), error=str(exc)
            )
            continue
        handoff.operator_id = operator.id
        operator.last_assigned_at = deps.now()
        enqueue(
            session,
            tenant_id=conversation.tenant_id,
            kind=JobKind.HANDOFF_TIMEOUT,
            payload={"handoff_id": str(handoff.id), "operator_id": str(operator.id)},
            run_at=deps.now() + timedelta(seconds=settings.operator_accept_timeout_seconds),
        )
        await publish(
            deps,
            conversation.tenant_id,
            "handoff_assigned",
            handoff_id=str(handoff.id),
            conversation_id=str(conversation.id),
            operator_id=str(operator.id),
        )
        return operator

    await no_operator_accepted(session, deps, conversation, handoff)
    return None


async def no_operator_accepted(
    session: AsyncSession, deps: Deps, conversation: Conversation, handoff: Handoff
) -> None:
    """Urgent alerts to the managers. At the same time the AI continues the conversation."""
    handoff.operator_id = None
    handoff.status = HandoffStatus.NO_OPERATOR.value
    handoff.closed_at = deps.now()
    conversation.state = next_state(
        ConversationState(conversation.state), ConversationEvent.NO_OPERATOR_ACCEPTED
    ).value
    managers = (
        await session.scalars(
            select(UrgentManager).where(UrgentManager.tenant_id == conversation.tenant_id)
        )
    ).all()
    settings = await load_tenant_settings(session, conversation.tenant_id)
    link = operator_chat_link(deps, conversation)
    if not managers:
        _alert(handoff, deps, "no_urgent_manager")
    for manager in managers:
        for kind in manager.communication_types:
            try:
                if kind == CommunicationType.PHONE_CALL:
                    ref = await deps.telephony.call_with_tts(
                        to=manager.phone_number, text=URGENT_CALL_TEXT
                    )
                else:
                    ref = await deps.whatsapp.send_template(
                        to=manager.phone_number,
                        template_name=deps.settings.whatsapp_urgent_template_name,
                        language=settings.notification_language,
                        parameters=[link],
                    )
                _alert(handoff, deps, f"urgent_{kind}", manager_id=str(manager.id), ref=ref)
            except Exception as exc:
                _alert(
                    handoff,
                    deps,
                    f"urgent_{kind}_failed",
                    manager_id=str(manager.id),
                    error=str(exc),
                )
    await publish(
        deps,
        conversation.tenant_id,
        "handoff_no_operator",
        handoff_id=str(handoff.id),
        conversation_id=str(conversation.id),
    )


async def on_accept_timeout(
    session: AsyncSession, deps: Deps, handoff_id: uuid.UUID, operator_id: uuid.UUID
) -> None:
    handoff = await session.get(Handoff, handoff_id)
    if (
        handoff is None
        or handoff.status != HandoffStatus.PENDING
        or handoff.operator_id != operator_id
    ):
        return  # accepted, closed, or already moved to the next operator
    _alert(handoff, deps, "accept_timeout", operator_id=str(operator_id))
    conversation = await session.get_one(Conversation, handoff.conversation_id)
    await assign_next_operator(session, deps, conversation, handoff)


class HandoffError(Exception):
    pass


async def accept(session: AsyncSession, deps: Deps, handoff: Handoff, operator: Operator) -> None:
    if handoff.status != HandoffStatus.PENDING or handoff.operator_id != operator.id:
        raise HandoffError("This handoff is not waiting for you")
    conversation = await session.get_one(Conversation, handoff.conversation_id)
    conversation.state = next_state(
        ConversationState(conversation.state), ConversationEvent.OPERATOR_ACCEPTED
    ).value
    handoff.status = HandoffStatus.ACTIVE.value
    handoff.accepted_at = deps.now()
    await publish(
        deps,
        conversation.tenant_id,
        "handoff_accepted",
        handoff_id=str(handoff.id),
        conversation_id=str(conversation.id),
        operator_id=str(operator.id),
    )


async def out_to_ai(session: AsyncSession, deps: Deps, handoff: Handoff) -> None:
    """The operator sent /out-to-AI: close the handoff and keep the transcript in memory."""
    conversation = await session.get_one(Conversation, handoff.conversation_id)
    conversation.state = next_state(
        ConversationState(conversation.state), ConversationEvent.OUT_TO_AI
    ).value
    conversation.human_request_count = 0
    handoff.status = HandoffStatus.CLOSED.value
    handoff.closed_at = deps.now()

    since = handoff.requested_at
    rows = (
        await session.scalars(
            select(Message)
            .where(Message.conversation_id == conversation.id, Message.created_at >= since)
            .order_by(Message.created_at, Message.id)
        )
    ).all()
    transcript = "\n".join(f"{m.sender}: {m.body}" for m in rows)
    content = f"Handoff on {since.date().isoformat()} ({handoff.trigger}).\n{transcript}"
    await save_memory(
        session,
        deps,
        tenant_id=conversation.tenant_id,
        client_id=conversation.client_id,
        conversation_id=conversation.id,
        kind=MemoryKind.SUMMARY,
        content=content,
    )
    await publish(
        deps,
        conversation.tenant_id,
        "handoff_closed",
        handoff_id=str(handoff.id),
        conversation_id=str(conversation.id),
    )


async def active_handoff(session: AsyncSession, conversation_id: uuid.UUID) -> Handoff | None:
    result: Handoff | None = await session.scalar(
        select(Handoff)
        .where(
            Handoff.conversation_id == conversation_id,
            Handoff.status.in_([HandoffStatus.PENDING.value, HandoffStatus.ACTIVE.value]),
        )
        .order_by(Handoff.requested_at.desc())
        .limit(1)
    )
    return result


async def operator_reply(
    session: AsyncSession, deps: Deps, conversation: Conversation, text: str
) -> bool:
    result = await send_to_client(session, deps, conversation, text, sender=MessageSender.OPERATOR)
    return result.delivered

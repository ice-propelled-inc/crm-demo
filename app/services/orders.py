"""Orders: confirmed create/cancel, status changes (webhook and status check)."""

import logging
from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.adapters.crm.base import CRMAdapter, OrderLine
from app.adapters.llm.base import ChatMessage, LLMRequest
from app.agent.prompts import SystemPromptParts, build_system_prompt, render, resolve_prompt
from app.db.models import Conversation, Order, Tenant
from app.domain.orders import (
    OrderAction,
    PendingConfirmation,
    StatusRoute,
    UndeliveredAction,
    is_finished,
    on_undelivered_status_message,
    route_status_change,
    should_apply_event,
)
from app.domain.types import FINISHED_ORDER_STATUSES, ConversationState, MessageSender, OrderStatus
from app.runtime import Deps
from app.services.conversations import add_message, keep_pending, publish, send_to_client
from app.tenant_settings import TONE_PRESETS, load_tenant_settings

logger = logging.getLogger(__name__)


def pending_from_json(data: dict[str, Any] | None) -> PendingConfirmation | None:
    if not data:
        return None
    return PendingConfirmation(OrderAction(data["action"]), data["summary"], data["payload"])


def pending_to_json(pending: PendingConfirmation) -> dict[str, Any]:
    return {"action": pending.action.value, "summary": pending.summary, "payload": pending.payload}


async def execute_confirmed(
    session: AsyncSession,
    crm: CRMAdapter,
    deps: Deps,
    conversation: Conversation,
    pending: PendingConfirmation,
) -> tuple[str, str | None]:
    """Run the action that the client confirmed. Returns (note for the model, payment link)."""
    if pending.action is OrderAction.CREATE:
        lines = [
            OrderLine(ln["product_id"], int(ln["quantity"])) for ln in pending.payload["lines"]
        ]
        created = await crm.create_order(client_ref=str(conversation.client_id), lines=lines)
        session.add(
            Order(
                tenant_id=conversation.tenant_id,
                conversation_id=conversation.id,
                client_id=conversation.client_id,
                crm_order_id=created.crm_order_id,
                payment_link=created.payment_link,
                status=created.status.value,
                status_changed_at=deps.now(),
            )
        )
        note = (
            f"The order {created.crm_order_id} is created (status: {created.status.value}). "
            f"Give the client this payment link: {created.payment_link}. "
            "Tell the client that you will confirm when the payment arrives."
        )
        return note, created.payment_link

    crm_order_id = pending.payload["order_id"]
    state = await crm.cancel_order(crm_order_id)
    order = await session.scalar(
        select(Order).where(
            Order.tenant_id == conversation.tenant_id, Order.crm_order_id == crm_order_id
        )
    )
    if order is not None:
        order.status = state.status.value
        order.status_changed_at = state.changed_at or deps.now()
    return f"The order {crm_order_id} is cancelled. Tell the client.", None


async def _status_text(
    session: AsyncSession, deps: Deps, conversation: Conversation, order: Order
) -> str:
    settings = await load_tenant_settings(session, conversation.tenant_id)
    language = conversation.language or settings.default_language
    system = await resolve_prompt(
        session, conversation.tenant_id, "system", language, settings.default_language
    )
    stage = await resolve_prompt(
        session,
        conversation.tenant_id,
        "sales_funnel.status_notifications",
        language,
        settings.default_language,
    )
    prompt = build_system_prompt(
        SystemPromptParts(
            system=render(system, business_name=settings.business_name, channel="chat"),
            tone=TONE_PRESETS[settings.tone_preset],
            restriction="",
            stage=stage,
            language=language,
        )
    )
    response = await deps.llm.complete(
        LLMRequest(
            model=deps.settings.llm_model_main,
            system=prompt,
            messages=[
                ChatMessage(
                    "user",
                    f"[system event] The order {order.crm_order_id} has the new status: "
                    f"{order.status}. Write the message to the client.",
                )
            ],
            max_tokens=300,
        )
    )
    return response.text.strip()


async def apply_status_change(
    session: AsyncSession,
    deps: Deps,
    order: Order,
    status: OrderStatus,
    changed_at: datetime,
) -> bool:
    """Apply a status change. Returns False if the event is old or brings no change."""
    if not should_apply_event(order.status_changed_at, changed_at) or order.status == status:
        return False
    order.status = status.value
    order.status_changed_at = changed_at
    if order.conversation_id is None:
        return True
    conversation = await session.get_one(Conversation, order.conversation_id)

    route = route_status_change(ConversationState(conversation.state))
    if route is StatusRoute.SHOW_TO_OPERATOR:
        note = f"Order {order.crm_order_id}: new status {status.value}"
        message = add_message(session, conversation, MessageSender.SYSTEM, note)
        await session.flush()
        await publish(
            deps,
            conversation.tenant_id,
            "order_status",
            conversation_id=str(conversation.id),
            message_id=str(message.id),
            order_id=order.crm_order_id,
            status=status.value,
        )
        return True

    text = await _status_text(session, deps, conversation, order)
    result = await send_to_client(session, deps, conversation, text, keep_if_undelivered=False)
    if not result.delivered:
        decision = on_undelivered_status_message(status, deps.now())
        if decision.action is UndeliveredAction.KEEP_PENDING:
            keep_pending(session, deps, conversation, text, result.reason or "undelivered")
        else:  # finished order: keep the message in the conversation history only
            add_message(session, conversation, MessageSender.AI, text)
    return True


async def poll_unfinished_orders(session: AsyncSession, deps: Deps, tenant: Tenant) -> int:
    """Status check for lost webhooks. Returns the number of changed orders."""
    crm = deps.crm_factory(tenant)
    orders = (
        await session.scalars(
            select(Order).where(
                Order.tenant_id == tenant.id,
                Order.status.not_in([s.value for s in FINISHED_ORDER_STATUSES]),
            )
        )
    ).all()
    changed = 0
    for order in orders:
        state = await crm.get_order_status(order.crm_order_id)
        if state.status.value != order.status and await apply_status_change(
            session, deps, order, state.status, state.changed_at or deps.now()
        ):
            changed += 1
    return changed


def is_order_finished(order: Order) -> bool:
    return is_finished(OrderStatus(order.status))

"""Order flow: confirmation -> create -> payment link -> status change -> client message."""

from dataclasses import dataclass, field
from datetime import datetime, timedelta
from enum import StrEnum
from typing import Any

from app.domain.types import FINISHED_ORDER_STATUSES, ConversationState, OrderStatus

PENDING_MESSAGE_MIN_RETENTION = timedelta(days=30)


class OrderAction(StrEnum):
    CREATE = "create_order"
    CANCEL = "cancel_order"


@dataclass(frozen=True)
class PendingConfirmation:
    """The bot showed the order_confirmation prompt and waits for a clear "yes"."""

    action: OrderAction
    summary: str
    payload: dict[str, Any] = field(default_factory=dict)


def may_execute(
    action: OrderAction, pending: PendingConfirmation | None, client_confirmed: bool
) -> bool:
    """Create and cancel run only after the client confirms that same action."""
    return pending is not None and pending.action is action and client_confirmed


def is_finished(status: OrderStatus) -> bool:
    return status in FINISHED_ORDER_STATUSES


def should_apply_event(last_changed_at: datetime | None, event_changed_at: datetime) -> bool:
    """Ignore events that are not newer than the last known status."""
    return last_changed_at is None or event_changed_at > last_changed_at


class StatusRoute(StrEnum):
    NOTIFY_CLIENT = "notify_client"
    SHOW_TO_OPERATOR = "show_to_operator"  # during a handoff: only the operator sees it


def route_status_change(state: ConversationState) -> StatusRoute:
    if state is ConversationState.AI_ACTIVE:
        return StatusRoute.NOTIFY_CLIENT
    return StatusRoute.SHOW_TO_OPERATOR


class UndeliveredAction(StrEnum):
    KEEP_PENDING = "keep_pending"  # send it first when the client writes again
    KEEP_IN_HISTORY = "keep_in_history"  # finished order: keep the conversation only


@dataclass(frozen=True)
class UndeliveredDecision:
    action: UndeliveredAction
    keep_until: datetime | None


def on_undelivered_status_message(status: OrderStatus, now: datetime) -> UndeliveredDecision:
    """The channel could not deliver a status message (window closed, visitor offline)."""
    if is_finished(status):
        return UndeliveredDecision(UndeliveredAction.KEEP_IN_HISTORY, None)
    return UndeliveredDecision(UndeliveredAction.KEEP_PENDING, now + PENDING_MESSAGE_MIN_RETENTION)

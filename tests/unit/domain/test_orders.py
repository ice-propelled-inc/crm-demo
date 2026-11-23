from datetime import UTC, datetime, timedelta

import pytest

from app.domain.orders import (
    OrderAction,
    PendingConfirmation,
    StatusRoute,
    UndeliveredAction,
    is_finished,
    may_execute,
    on_undelivered_status_message,
    route_status_change,
    should_apply_event,
)
from app.domain.types import ConversationState, OrderStatus

NOW = datetime(2026, 11, 23, 12, 0, tzinfo=UTC)


class TestConfirmationGate:
    def test_confirmed_same_action(self) -> None:
        pending = PendingConfirmation(OrderAction.CREATE, "1 x Pizza")
        assert may_execute(OrderAction.CREATE, pending, client_confirmed=True)

    def test_not_confirmed(self) -> None:
        pending = PendingConfirmation(OrderAction.CREATE, "1 x Pizza")
        assert not may_execute(OrderAction.CREATE, pending, client_confirmed=False)

    def test_no_pending_confirmation(self) -> None:
        assert not may_execute(OrderAction.CANCEL, None, client_confirmed=True)

    def test_confirmation_of_other_action(self) -> None:
        pending = PendingConfirmation(OrderAction.CREATE, "1 x Pizza")
        assert not may_execute(OrderAction.CANCEL, pending, client_confirmed=True)


@pytest.mark.parametrize(
    ("status", "finished"),
    [
        (OrderStatus.COMPLETED, True),
        (OrderStatus.CANCELLED, True),
        (OrderStatus.REFUNDED, True),
        (OrderStatus.AWAITING_PAYMENT, False),
        (OrderStatus.PAID, False),
        (OrderStatus.PAYMENT_FAILED, False),
        (OrderStatus.IN_PROGRESS, False),
        (OrderStatus.SHIPPED, False),
    ],
)
def test_is_finished(status: OrderStatus, finished: bool) -> None:
    assert is_finished(status) is finished


class TestEventOrder:
    def test_first_event(self) -> None:
        assert should_apply_event(None, NOW)

    def test_newer_event(self) -> None:
        assert should_apply_event(NOW, NOW + timedelta(seconds=1))

    def test_older_event_is_ignored(self) -> None:
        assert not should_apply_event(NOW, NOW - timedelta(minutes=5))

    def test_same_time_is_ignored(self) -> None:
        assert not should_apply_event(NOW, NOW)


@pytest.mark.parametrize(
    ("state", "route"),
    [
        (ConversationState.AI_ACTIVE, StatusRoute.NOTIFY_CLIENT),
        (ConversationState.HANDOFF_PENDING, StatusRoute.SHOW_TO_OPERATOR),
        (ConversationState.HANDOFF_ACTIVE, StatusRoute.SHOW_TO_OPERATOR),
    ],
)
def test_status_route(state: ConversationState, route: StatusRoute) -> None:
    assert route_status_change(state) is route


class TestUndelivered:
    def test_unfinished_order_keeps_message_30_days(self) -> None:
        decision = on_undelivered_status_message(OrderStatus.PAID, NOW)
        assert decision.action is UndeliveredAction.KEEP_PENDING
        assert decision.keep_until == NOW + timedelta(days=30)

    def test_finished_order_keeps_history_only(self) -> None:
        decision = on_undelivered_status_message(OrderStatus.COMPLETED, NOW)
        assert decision.action is UndeliveredAction.KEEP_IN_HISTORY
        assert decision.keep_until is None

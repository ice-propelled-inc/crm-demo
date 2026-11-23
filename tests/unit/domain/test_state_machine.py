import pytest

from app.domain.state_machine import (
    ConversationEvent,
    InvalidTransitionError,
    ai_may_reply,
    is_out_to_ai_command,
    next_state,
)
from app.domain.types import ConversationState as S

E = ConversationEvent


@pytest.mark.parametrize(
    ("state", "event", "expected"),
    [
        (S.AI_ACTIVE, E.HANDOFF_TRIGGERED, S.HANDOFF_PENDING),
        (S.HANDOFF_PENDING, E.OPERATOR_ACCEPTED, S.HANDOFF_ACTIVE),
        (S.HANDOFF_PENDING, E.NO_OPERATOR_ACCEPTED, S.AI_ACTIVE),
        (S.HANDOFF_ACTIVE, E.OUT_TO_AI, S.AI_ACTIVE),
    ],
)
def test_allowed_transitions(state: S, event: E, expected: S) -> None:
    assert next_state(state, event) is expected


@pytest.mark.parametrize(
    ("state", "event"),
    [
        (S.AI_ACTIVE, E.OPERATOR_ACCEPTED),
        (S.AI_ACTIVE, E.OUT_TO_AI),
        (S.HANDOFF_PENDING, E.HANDOFF_TRIGGERED),
        (S.HANDOFF_ACTIVE, E.HANDOFF_TRIGGERED),
        (S.HANDOFF_ACTIVE, E.NO_OPERATOR_ACCEPTED),
    ],
)
def test_invalid_transitions(state: S, event: E) -> None:
    with pytest.raises(InvalidTransitionError):
        next_state(state, event)


def test_full_cycle() -> None:
    state = S.AI_ACTIVE
    for event in (E.HANDOFF_TRIGGERED, E.OPERATOR_ACCEPTED, E.OUT_TO_AI):
        state = next_state(state, event)
    assert state is S.AI_ACTIVE


@pytest.mark.parametrize(
    ("state", "expected"),
    [(S.AI_ACTIVE, True), (S.HANDOFF_PENDING, False), (S.HANDOFF_ACTIVE, False)],
)
def test_ai_may_reply_only_when_active(state: S, expected: bool) -> None:
    assert ai_may_reply(state) is expected


@pytest.mark.parametrize(
    ("text", "expected"),
    [("/out-to-AI", True), ("  /OUT-TO-ai \n", True), ("/out-to-ai please", False), ("", False)],
)
def test_out_to_ai_command(text: str, expected: bool) -> None:
    assert is_out_to_ai_command(text) is expected

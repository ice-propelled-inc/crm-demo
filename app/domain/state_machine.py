"""Conversation state machine: AI_ACTIVE -> HANDOFF_PENDING -> HANDOFF_ACTIVE -> AI_ACTIVE."""

from enum import StrEnum

from app.domain.types import ConversationState

OUT_TO_AI_COMMAND = "/out-to-AI"


class ConversationEvent(StrEnum):
    HANDOFF_TRIGGERED = "handoff_triggered"
    OPERATOR_ACCEPTED = "operator_accepted"
    NO_OPERATOR_ACCEPTED = "no_operator_accepted"
    OUT_TO_AI = "out_to_ai"


class InvalidTransitionError(ValueError):
    """The event is not allowed in the current state."""


_TRANSITIONS: dict[tuple[ConversationState, ConversationEvent], ConversationState] = {
    (ConversationState.AI_ACTIVE, ConversationEvent.HANDOFF_TRIGGERED): (
        ConversationState.HANDOFF_PENDING
    ),
    (ConversationState.HANDOFF_PENDING, ConversationEvent.OPERATOR_ACCEPTED): (
        ConversationState.HANDOFF_ACTIVE
    ),
    # No operator accepts: urgent alert, and the AI continues at the same time.
    (ConversationState.HANDOFF_PENDING, ConversationEvent.NO_OPERATOR_ACCEPTED): (
        ConversationState.AI_ACTIVE
    ),
    (ConversationState.HANDOFF_ACTIVE, ConversationEvent.OUT_TO_AI): ConversationState.AI_ACTIVE,
}


def next_state(state: ConversationState, event: ConversationEvent) -> ConversationState:
    try:
        return _TRANSITIONS[(state, event)]
    except KeyError:
        raise InvalidTransitionError(f"{event} is not allowed in state {state}") from None


def ai_may_reply(state: ConversationState) -> bool:
    """The AI answers the client only in AI_ACTIVE."""
    return state is ConversationState.AI_ACTIVE


def is_out_to_ai_command(text: str) -> bool:
    return text.strip().casefold() == OUT_TO_AI_COMMAND.casefold()

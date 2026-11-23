"""Handoff triggers.

A handoff starts when one of these is true:
1. The client asks for a human with harsh words (keyword list or sentiment check).
2. The client asks for a human for the second time.
3. The AI confidence is less than the limit.
"""

import re
from collections.abc import Iterable
from dataclasses import dataclass

from app.domain.types import HandoffTrigger

DEFAULT_CONFIDENCE_LIMIT = 0.6
HUMAN_REQUESTS_FOR_HANDOFF = 2


@dataclass(frozen=True)
class TurnSignals:
    """What the fast-tier classifier reports for one client message."""

    asks_for_human: bool
    confidence: float
    harsh_sentiment: bool = False


@dataclass(frozen=True)
class HandoffDecision:
    trigger: HandoffTrigger | None
    human_request_count: int  # the new value to keep on the conversation

    @property
    def start_handoff(self) -> bool:
        return self.trigger is not None


def contains_harsh_words(text: str, keywords: Iterable[str]) -> bool:
    """Whole-word, case-insensitive match. Works for accented letters (French)."""
    folded = text.casefold()
    for keyword in keywords:
        word = keyword.strip().casefold()
        if word and re.search(rf"(?<!\w){re.escape(word)}(?!\w)", folded):
            return True
    return False


def _check_unit_interval(name: str, value: float) -> None:
    if not 0.0 <= value <= 1.0:
        raise ValueError(f"{name} must be between 0 and 1, got {value}")


def evaluate_handoff(
    *,
    text: str,
    signals: TurnSignals,
    previous_human_requests: int,
    harsh_keywords: Iterable[str],
    confidence_limit: float = DEFAULT_CONFIDENCE_LIMIT,
) -> HandoffDecision:
    _check_unit_interval("confidence", signals.confidence)
    _check_unit_interval("confidence_limit", confidence_limit)
    if previous_human_requests < 0:
        raise ValueError("previous_human_requests must not be negative")

    count = previous_human_requests + (1 if signals.asks_for_human else 0)
    harsh = signals.harsh_sentiment or contains_harsh_words(text, harsh_keywords)

    if signals.asks_for_human and harsh:
        trigger: HandoffTrigger | None = HandoffTrigger.HARSH_WORDS
    elif signals.asks_for_human and count >= HUMAN_REQUESTS_FOR_HANDOFF:
        trigger = HandoffTrigger.HUMAN_REQUESTED_TWICE
    elif signals.confidence < confidence_limit:
        trigger = HandoffTrigger.LOW_CONFIDENCE
    else:
        trigger = None

    # After a handoff starts, the counter starts again from zero.
    return HandoffDecision(trigger=trigger, human_request_count=0 if trigger else count)

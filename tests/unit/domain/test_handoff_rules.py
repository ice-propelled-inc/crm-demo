import pytest

from app.domain.handoff_rules import (
    HandoffDecision,
    TurnSignals,
    contains_harsh_words,
    evaluate_handoff,
)
from app.domain.types import HandoffTrigger

HARSH = ["idiot", "useless", "nul", "débile"]


def decide(
    text: str = "hello",
    *,
    asks: bool = False,
    confidence: float = 0.9,
    sentiment: bool = False,
    previous: int = 0,
    limit: float = 0.6,
) -> HandoffDecision:
    return evaluate_handoff(
        text=text,
        signals=TurnSignals(asks_for_human=asks, confidence=confidence, harsh_sentiment=sentiment),
        previous_human_requests=previous,
        harsh_keywords=HARSH,
        confidence_limit=limit,
    )


class TestHarshWords:
    @pytest.mark.parametrize(
        ("text", "expected"),
        [
            ("You are USELESS!", True),
            ("c'est débile", True),
            ("C'EST DÉBILE", True),
            ("idiotic", False),  # whole words only
            ("nulle part", False),
            ("all fine", False),
        ],
    )
    def test_keyword_match(self, text: str, expected: bool) -> None:
        assert contains_harsh_words(text, HARSH) is expected

    def test_blank_keywords_are_ignored(self) -> None:
        assert contains_harsh_words("anything", ["", "   "]) is False


class TestTriggers:
    def test_no_trigger(self) -> None:
        decision = decide()
        assert decision.trigger is None
        assert decision.start_handoff is False
        assert decision.human_request_count == 0

    def test_first_request_only_counts(self) -> None:
        decision = decide(asks=True)
        assert decision.trigger is None
        assert decision.human_request_count == 1

    def test_second_request_starts_handoff_and_resets_counter(self) -> None:
        decision = decide(asks=True, previous=1)
        assert decision.trigger is HandoffTrigger.HUMAN_REQUESTED_TWICE
        assert decision.start_handoff is True
        assert decision.human_request_count == 0

    def test_old_requests_alone_do_not_trigger(self) -> None:
        decision = decide(asks=False, previous=3)
        assert decision.trigger is None
        assert decision.human_request_count == 3

    def test_request_with_harsh_keyword_is_immediate(self) -> None:
        decision = decide("Give me a human, this bot is useless", asks=True)
        assert decision.trigger is HandoffTrigger.HARSH_WORDS

    def test_request_with_harsh_sentiment_is_immediate(self) -> None:
        decision = decide("human now", asks=True, sentiment=True)
        assert decision.trigger is HandoffTrigger.HARSH_WORDS

    def test_harsh_words_without_request_do_not_trigger(self) -> None:
        decision = decide("useless", asks=False, sentiment=True)
        assert decision.trigger is None

    def test_low_confidence(self) -> None:
        assert decide(confidence=0.59).trigger is HandoffTrigger.LOW_CONFIDENCE

    def test_confidence_at_limit_does_not_trigger(self) -> None:
        assert decide(confidence=0.6).trigger is None

    def test_harsh_has_priority_over_count(self) -> None:
        decision = decide("useless", asks=True, previous=1, confidence=0.1)
        assert decision.trigger is HandoffTrigger.HARSH_WORDS


class TestValidation:
    @pytest.mark.parametrize("confidence", [-0.1, 1.1])
    def test_confidence_range(self, confidence: float) -> None:
        with pytest.raises(ValueError, match="confidence"):
            decide(confidence=confidence)

    def test_limit_range(self) -> None:
        with pytest.raises(ValueError, match="confidence_limit"):
            decide(limit=2)

    def test_negative_previous(self) -> None:
        with pytest.raises(ValueError, match="previous_human_requests"):
            decide(previous=-1)

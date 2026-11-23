import pytest

from app.domain.restriction import (
    MEDIUM_RETURN_LIMIT,
    RestrictionAction,
    apply_restriction,
)
from app.domain.types import RestrictionLevel as L
from app.domain.types import TopicCategory as T

A = RestrictionAction


@pytest.mark.parametrize(
    ("level", "category", "expected"),
    [
        (L.MEDIUM, T.PRODUCTS_ORDERS, A.ANSWER),
        (L.MEDIUM, T.BUSINESS_RELATED, A.ANSWER),
        (L.MEDIUM, T.SMALL_TALK, A.ANSWER_AND_STEER),
        (L.MEDIUM, T.OFF_TOPIC, A.ANSWER_AND_STEER),
        (L.HIGH, T.PRODUCTS_ORDERS, A.ANSWER),
        (L.HIGH, T.BUSINESS_RELATED, A.ANSWER),
        (L.HIGH, T.SMALL_TALK, A.DECLINE),
        (L.HIGH, T.OFF_TOPIC, A.DECLINE),
        (L.STRICT, T.PRODUCTS_ORDERS, A.ANSWER),
        (L.STRICT, T.BUSINESS_RELATED, A.DECLINE),
        (L.STRICT, T.SMALL_TALK, A.DECLINE),
        (L.STRICT, T.OFF_TOPIC, A.DECLINE),
    ],
)
def test_first_message(level: L, category: T, expected: A) -> None:
    assert apply_restriction(level, category, 0).action is expected


def test_medium_returns_to_topic_by_third_message() -> None:
    count = 0
    actions = []
    for _ in range(4):
        decision = apply_restriction(L.MEDIUM, T.SMALL_TALK, count)
        actions.append(decision.action)
        count = decision.off_topic_count
    assert actions == [A.ANSWER_AND_STEER, A.ANSWER_AND_STEER, A.RETURN_TO_TOPIC, A.RETURN_TO_TOPIC]
    assert MEDIUM_RETURN_LIMIT == 3


def test_on_topic_message_resets_counter() -> None:
    decision = apply_restriction(L.MEDIUM, T.PRODUCTS_ORDERS, 2)
    assert decision.off_topic_count == 0


def test_decline_counts_messages() -> None:
    assert apply_restriction(L.HIGH, T.OFF_TOPIC, 4).off_topic_count == 5


def test_negative_count_is_rejected() -> None:
    with pytest.raises(ValueError, match="previous_off_topic_count"):
        apply_restriction(L.MEDIUM, T.OFF_TOPIC, -1)

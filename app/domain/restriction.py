"""Topic restriction policy.

- medium: other topics are allowed for a short time. The bot steers back and returns
  to the subject in a maximum of 3 messages.
- high: the bot briefly declines all other topics.
- strict: the bot answers only about products and orders.
"""

from dataclasses import dataclass
from enum import StrEnum

from app.domain.types import RestrictionLevel, TopicCategory

MEDIUM_RETURN_LIMIT = 3


class RestrictionAction(StrEnum):
    ANSWER = "answer"
    ANSWER_AND_STEER = "answer_and_steer"  # short answer, then steer back to the subject
    RETURN_TO_TOPIC = "return_to_topic"  # do not continue the other topic
    DECLINE = "decline"  # short refusal


@dataclass(frozen=True)
class RestrictionDecision:
    action: RestrictionAction
    off_topic_count: int  # consecutive messages on other topics; keep it on the conversation


_ALLOWED: dict[RestrictionLevel, frozenset[TopicCategory]] = {
    RestrictionLevel.MEDIUM: frozenset(
        {TopicCategory.PRODUCTS_ORDERS, TopicCategory.BUSINESS_RELATED}
    ),
    RestrictionLevel.HIGH: frozenset(
        {TopicCategory.PRODUCTS_ORDERS, TopicCategory.BUSINESS_RELATED}
    ),
    RestrictionLevel.STRICT: frozenset({TopicCategory.PRODUCTS_ORDERS}),
}


def apply_restriction(
    level: RestrictionLevel, category: TopicCategory, previous_off_topic_count: int
) -> RestrictionDecision:
    if previous_off_topic_count < 0:
        raise ValueError("previous_off_topic_count must not be negative")
    if category in _ALLOWED[level]:
        return RestrictionDecision(RestrictionAction.ANSWER, 0)

    count = previous_off_topic_count + 1
    if level is not RestrictionLevel.MEDIUM:
        return RestrictionDecision(RestrictionAction.DECLINE, count)
    if count >= MEDIUM_RETURN_LIMIT:
        return RestrictionDecision(RestrictionAction.RETURN_TO_TOPIC, count)
    return RestrictionDecision(RestrictionAction.ANSWER_AND_STEER, count)

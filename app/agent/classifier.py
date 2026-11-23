"""Fast-tier classifier: one call for each client message.

It gives the signals for the domain rules: language, topic, human request, harsh
sentiment, confidence, answer to a pending confirmation, funnel stage.
"""

import json
import logging
import re
from collections.abc import Sequence
from typing import Literal

from pydantic import BaseModel, Field, ValidationError

from app.adapters.llm.base import ChatMessage, LLMRequest
from app.domain.types import TopicCategory
from app.runtime import Deps

logger = logging.getLogger(__name__)


class Classification(BaseModel):
    language: str = Field(min_length=2, max_length=10)
    topic: TopicCategory
    asks_for_human: bool
    harsh_sentiment: bool
    confidence: float = Field(ge=0, le=1)
    confirmation: Literal["yes", "no", "none"] = "none"
    funnel_stage: str | None = None


CLASSIFIER_SYSTEM = """You classify one client message for a shop assistant bot.
Reply with one JSON object only, no other text:
{{"language": "<ISO 639-1 code of the client message>",
 "topic": "products_orders" | "business_related" | "small_talk" | "off_topic",
 "asks_for_human": <true if the client wants to talk to a person>,
 "harsh_sentiment": <true if the client is angry or rude>,
 "confidence": <0..1, how sure you are that the bot can answer this message well>,
 "confirmation": "yes" | "no" | "none",
 "funnel_stage": one of {stages}}}
"confirmation" is "yes" or "no" only if the bot asked to confirm this: {pending}.
Otherwise it is "none"."""

_JSON = re.compile(r"\{.*\}", re.DOTALL)


def _fallback(default_language: str, stage: str | None) -> Classification:
    return Classification(
        language=default_language,
        topic=TopicCategory.PRODUCTS_ORDERS,
        asks_for_human=False,
        harsh_sentiment=False,
        confidence=1.0,
        funnel_stage=stage,
    )


async def classify(
    deps: Deps,
    *,
    text: str,
    history: Sequence[ChatMessage],
    stages: Sequence[str],
    pending_summary: str | None,
    default_language: str,
    current_stage: str | None,
) -> Classification:
    system = CLASSIFIER_SYSTEM.format(
        stages=json.dumps(list(stages)), pending=pending_summary or "nothing"
    )
    request = LLMRequest(
        model=deps.settings.llm_model_fast,
        system=system,
        messages=[*history[-6:], ChatMessage("user", text)],
        max_tokens=200,
    )
    response = await deps.llm.complete(request)
    match = _JSON.search(response.text)
    try:
        if match is None:
            raise ValueError("no JSON")
        result = Classification.model_validate(json.loads(match.group(0)))
    except (ValueError, ValidationError):
        logger.warning("Classifier output is not valid; using neutral defaults")
        return _fallback(default_language, current_stage)
    if result.funnel_stage not in stages:
        result = result.model_copy(update={"funnel_stage": current_stage})
    return result

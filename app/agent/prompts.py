"""Prompt resolution (tenant version, else default) and system prompt assembly."""

import uuid
from collections.abc import Sequence
from dataclasses import dataclass

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Prompt
from app.domain.restriction import RestrictionAction

RESTRICTION_INSTRUCTIONS: dict[RestrictionAction, str] = {
    RestrictionAction.ANSWER: "",
    RestrictionAction.ANSWER_AND_STEER: (
        "The client talks about another topic. Answer in one short sentence, then steer the "
        "conversation back to our products and orders."
    ),
    RestrictionAction.RETURN_TO_TOPIC: (
        "The client talked about other topics for 3 messages. Do not continue that topic. "
        "Politely bring the conversation back to our products and orders."
    ),
    RestrictionAction.DECLINE: (
        "The client asks about a topic that you must not discuss. Decline in one short, polite "
        "sentence and offer help with our products and orders."
    ),
}

LANGUAGE_NAMES = {"en": "English", "fr": "French"}


class _SafeDict(dict[str, str]):
    def __missing__(self, key: str) -> str:
        return "{" + key + "}"


def render(template: str, **values: str) -> str:
    """Fill `{name}` placeholders. Unknown placeholders stay as they are."""
    return template.format_map(_SafeDict(values))


async def resolve_prompt(
    session: AsyncSession, tenant_id: uuid.UUID, key: str, language: str, fallback_language: str
) -> str:
    """Tenant version first, then the default. Language: client, then fallback, then English."""
    rows = (
        await session.scalars(
            select(Prompt).where(
                Prompt.key == key,
                or_(Prompt.tenant_id == tenant_id, Prompt.tenant_id.is_(None)),
            )
        )
    ).all()
    languages = [language, fallback_language, "en"]

    def rank(prompt: Prompt) -> tuple[int, int, int]:
        lang_rank = languages.index(prompt.language) if prompt.language in languages else 99
        return (lang_rank, 0 if prompt.tenant_id else 1, -prompt.version)

    candidates = sorted((p for p in rows if p.language in languages), key=rank)
    if not candidates:
        raise LookupError(f"No prompt {key!r} for {languages}")
    return candidates[0].body


@dataclass(frozen=True)
class SystemPromptParts:
    system: str
    tone: str
    restriction: str
    stage: str
    language: str
    examples: Sequence[str] = ()
    memories: Sequence[str] = ()
    notes: Sequence[str] = ()


def build_system_prompt(parts: SystemPromptParts) -> str:
    sections = [parts.system.strip(), f"Tone: {parts.tone}"]
    if parts.stage:
        sections.append(parts.stage.strip())
    if parts.restriction:
        sections.append(parts.restriction)
    language = LANGUAGE_NAMES.get(parts.language, parts.language)
    sections.append(f"Reply in {language}.")
    if parts.memories:
        sections.append(
            "What you know about this client:\n" + "\n".join(f"- {m}" for m in parts.memories)
        )
    if parts.examples:
        sections.append(
            "Example dialogs in the wanted style:\n"
            + "\n---\n".join(e.strip() for e in parts.examples)
        )
    sections.extend(parts.notes)
    return "\n\n".join(sections)

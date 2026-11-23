"""One client message: the full agent turn.

1. Save the message. Send the kept (pending) messages first.
2. During a handoff: show the message to the operator only.
3. Classify (fast model). Check the handoff triggers.
4. A pending confirmation: "yes" runs the action, "no" clears it.
5. Topic restriction. Prompt assembly. Tool loop (main model).
6. A tool asks for confirmation: send the order_confirmation prompt.
7. Send the reply after a human-like delay (with "typing...").
"""

import logging
import uuid
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.adapters.channels.base import InboundMessage
from app.adapters.crm.base import CRMAdapter
from app.adapters.llm.base import ChatMessage, LLMRequest
from app.agent.classifier import Classification, classify
from app.agent.memory import embed_one, similar_examples, similar_memories
from app.agent.prompts import (
    RESTRICTION_INSTRUCTIONS,
    SystemPromptParts,
    build_system_prompt,
    render,
    resolve_prompt,
)
from app.agent.tools import TOOLS, ToolContext, run_tool
from app.db.models import Channel, Conversation, LanguagePack, Tenant
from app.domain.handoff_rules import TurnSignals, evaluate_handoff
from app.domain.orders import may_execute
from app.domain.restriction import apply_restriction
from app.domain.state_machine import ai_may_reply
from app.domain.types import ConversationState, HandoffTrigger, MessageSender, RestrictionLevel
from app.runtime import Deps
from app.services.conversations import (
    add_message,
    chat_history,
    deliver_pending,
    get_or_create_conversation,
    publish,
    schedule_reply,
)
from app.services.handoff import start_handoff
from app.services.orders import execute_confirmed, pending_from_json, pending_to_json
from app.tenant_settings import TONE_PRESETS, TenantSettings, load_tenant_settings

logger = logging.getLogger(__name__)

MAX_TOOL_ROUNDS = 5
BUILT_IN_LANGUAGES = ("en", "fr")


@dataclass
class TurnResult:
    conversation: Conversation
    action: str  # "forwarded_to_operator" | "handoff" | "confirmation" | "reply"
    reply: str | None = None


async def _languages(session: AsyncSession, tenant_id: uuid.UUID) -> set[str]:
    packs = await session.scalars(
        select(LanguagePack.language).where(
            LanguagePack.tenant_id == tenant_id, LanguagePack.enabled.is_(True)
        )
    )
    return {*BUILT_IN_LANGUAGES, *packs.all()}


async def handle_inbound(
    session: AsyncSession, deps: Deps, channel: Channel, inbound: InboundMessage
) -> TurnResult:
    tenant = await session.get_one(Tenant, channel.tenant_id)
    settings = await load_tenant_settings(session, tenant.id)
    client, conversation = await get_or_create_conversation(session, channel, inbound)
    history = await chat_history(session, conversation.id)
    message = add_message(
        session, conversation, MessageSender.CLIENT, inbound.text, inbound.provider_message_id
    )
    conversation.last_client_message_at = inbound.received_at
    await session.flush()
    await publish(
        deps,
        tenant.id,
        "message",
        conversation_id=str(conversation.id),
        message_id=str(message.id),
        sender=MessageSender.CLIENT.value,
        body=inbound.text,
    )
    await deliver_pending(session, deps, conversation)

    if not ai_may_reply(ConversationState(conversation.state)):
        return TurnResult(conversation, "forwarded_to_operator")

    pending = pending_from_json(conversation.pending_confirmation)
    signals = await classify(
        deps,
        text=inbound.text,
        history=history,
        stages=settings.funnel_stages,
        pending_summary=pending.summary if pending else None,
        default_language=settings.default_language,
        current_stage=conversation.funnel_stage,
    )
    languages = await _languages(session, tenant.id)
    conversation.language = (
        signals.language if signals.language in languages else settings.default_language
    )
    client.language = conversation.language
    conversation.funnel_stage = signals.funnel_stage or conversation.funnel_stage

    decision = evaluate_handoff(
        text=inbound.text,
        signals=TurnSignals(signals.asks_for_human, signals.confidence, signals.harsh_sentiment),
        previous_human_requests=conversation.human_request_count,
        harsh_keywords=settings.harsh_keywords,
        confidence_limit=settings.confidence_limit,
    )
    conversation.human_request_count = decision.human_request_count
    if decision.trigger is not None:
        conversation.pending_confirmation = None
        await start_handoff(session, deps, conversation, decision.trigger)
        return TurnResult(conversation, "handoff")

    crm = deps.crm_factory(tenant)
    notes: list[str] = []
    if pending is not None and signals.confirmation != "none":
        conversation.pending_confirmation = None
        if may_execute(pending.action, pending, signals.confirmation == "yes"):
            note, _link = await execute_confirmed(session, crm, deps, conversation, pending)
            notes.append(f"[system note] {note}")
        else:
            notes.append("[system note] The client did not confirm. Nothing was changed.")

    return await _reply(session, deps, settings, tenant, conversation, crm, signals, notes, inbound)


async def _reply(
    session: AsyncSession,
    deps: Deps,
    settings: TenantSettings,
    tenant: Tenant,
    conversation: Conversation,
    crm: CRMAdapter,
    signals: Classification,
    notes: list[str],
    inbound: InboundMessage,
) -> TurnResult:
    language = conversation.language or settings.default_language
    restriction = apply_restriction(
        RestrictionLevel(settings.restriction_level), signals.topic, conversation.off_topic_count
    )
    conversation.off_topic_count = restriction.off_topic_count

    vector = await embed_one(deps, inbound.text)
    examples = (
        await similar_examples(session, tenant.id, language, settings.tone_preset, vector)
        if settings.use_dialog_dataset
        else []
    )
    memories = await similar_memories(session, tenant.id, conversation.client_id, vector)
    system = await resolve_prompt(session, tenant.id, "system", language, settings.default_language)
    stage = ""
    if conversation.funnel_stage:
        try:
            stage = await resolve_prompt(
                session,
                tenant.id,
                f"sales_funnel.{conversation.funnel_stage}",
                language,
                settings.default_language,
            )
        except LookupError:
            stage = ""
    channel = await session.get_one(Channel, conversation.channel_id)
    prompt = build_system_prompt(
        SystemPromptParts(
            system=render(system, business_name=settings.business_name, channel=channel.kind),
            tone=TONE_PRESETS[settings.tone_preset],
            restriction=RESTRICTION_INSTRUCTIONS[restriction.action],
            stage=stage,
            language=language,
            examples=examples,
            memories=memories,
            notes=notes,
        )
    )

    messages = await chat_history(session, conversation.id)
    ctx = ToolContext(session=session, deps=deps, crm=crm, conversation=conversation)
    text = ""
    for _ in range(MAX_TOOL_ROUNDS):
        response = await deps.llm.complete(
            LLMRequest(
                model=deps.settings.llm_model_main,
                system=prompt,
                messages=messages,
                tools=TOOLS,
                max_tokens=800,
            )
        )
        text = response.text.strip()
        if not response.tool_calls:
            break
        messages.append(ChatMessage("assistant", response.text, tool_calls=response.tool_calls))
        for call in response.tool_calls:
            result = await run_tool(ctx, call.name, call.arguments)
            messages.append(ChatMessage("tool", result, tool_call_id=call.id))
        if ctx.confirmation is not None or ctx.human_requested:
            break
    else:
        logger.warning("Tool loop limit reached in conversation %s", conversation.id)

    if ctx.human_requested:
        await start_handoff(session, deps, conversation, HandoffTrigger.LOW_CONFIDENCE)
        return TurnResult(conversation, "handoff")

    if ctx.confirmation is not None:
        conversation.pending_confirmation = pending_to_json(ctx.confirmation)
        template = await resolve_prompt(
            session, tenant.id, "order_confirmation", language, settings.default_language
        )
        text = render(template, summary=ctx.confirmation.summary).strip()
        await schedule_reply(session, deps, conversation, text, settings.delays.to_domain())
        return TurnResult(conversation, "confirmation", text)

    if not text:
        fallback = await resolve_prompt(
            session, tenant.id, "fallback", language, settings.default_language
        )
        text = fallback.strip()
    for note in notes:  # a created order: the payment link must reach the client
        if "payment link: " in note:
            link = note.split("payment link: ", 1)[1].split(". ", 1)[0]
            if link not in text:
                text = f"{text}\n{link}"
    await schedule_reply(session, deps, conversation, text, settings.delays.to_domain())
    return TurnResult(conversation, "reply", text)

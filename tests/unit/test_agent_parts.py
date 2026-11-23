"""Tenant settings, prompt assembly, classifier parsing, events, runtime builders."""

import asyncio
import json
import uuid

import pytest
from pydantic import ValidationError

from app.adapters.channels.instagram import InstagramAdapter
from app.adapters.channels.jivo import JivoAdapter
from app.adapters.channels.tidio import TidioAdapter
from app.adapters.llm.base import LLMResponse
from app.agent.classifier import classify
from app.agent.prompts import SystemPromptParts, build_system_prompt, render
from app.db.models import Channel
from app.events import InMemoryEventBus
from app.runtime import build_channel_adapter, build_deps, build_test_deps
from app.security import encrypt
from app.settings import Settings
from app.tenant_settings import DelaySettings, TenantSettings


def test_tenant_settings_defaults_and_validation() -> None:
    settings = TenantSettings()
    assert settings.confidence_limit == 0.6
    assert settings.operator_accept_timeout_seconds == 60
    assert settings.status_check_interval_minutes == 10
    assert settings.funnel_stages[-1] == "feedback"
    assert settings.delays.to_domain().max_total_delay == 30
    with pytest.raises(ValidationError):
        TenantSettings(tone_preset="rude")
    with pytest.raises(ValidationError):
        TenantSettings(funnel_stages=[])
    with pytest.raises(ValidationError):
        DelaySettings(min_delay=5, max_delay=1)


def test_render_keeps_unknown_placeholders() -> None:
    assert render("Hi {name}, {other}", name="Ann") == "Hi Ann, {other}"


def test_system_prompt_parts() -> None:
    prompt = build_system_prompt(
        SystemPromptParts(
            system="SYSTEM",
            tone="warm",
            restriction="DECLINE",
            stage="STAGE",
            language="fr",
            examples=["EX1"],
            memories=["likes pizza"],
            notes=["NOTE"],
        )
    )
    for part in (
        "SYSTEM",
        "Tone: warm",
        "DECLINE",
        "STAGE",
        "Reply in French.",
        "- likes pizza",
        "EX1",
        "NOTE",
    ):
        assert part in prompt
    minimal = build_system_prompt(SystemPromptParts("S", "t", "", "", "de"))
    assert "Reply in de." in minimal and "Example" not in minimal


async def test_classifier_unknown_stage_keeps_current() -> None:
    deps = build_test_deps(Settings())
    deps.llm.queue(  # type: ignore[attr-defined]
        LLMResponse(
            text="Result: "
            + json.dumps(
                {
                    "language": "en",
                    "topic": "small_talk",
                    "asks_for_human": False,
                    "harsh_sentiment": False,
                    "confidence": 0.9,
                    "funnel_stage": "nonsense",
                }
            )
        ),
        LLMResponse(text='{"topic": "bad"}'),
    )
    result = await classify(
        deps, text="hi", history=[], stages=["offer"], pending_summary=None,
        default_language="en", current_stage="offer",
    )  # fmt: skip
    assert (result.topic.value, result.funnel_stage) == ("small_talk", "offer")
    fallback = await classify(
        deps, text="hi", history=[], stages=["offer"], pending_summary=None,
        default_language="fr", current_stage=None,
    )  # fmt: skip
    assert (fallback.language, fallback.confidence) == ("fr", 1.0)


async def test_in_memory_event_bus() -> None:
    bus = InMemoryEventBus()
    tenant, other = uuid.uuid4(), uuid.uuid4()
    async with bus.subscribe(tenant) as queue:
        await bus.publish(other, {"type": "x"})
        await bus.publish(tenant, {"type": "y"})
        assert await asyncio.wait_for(queue.get(), 1) == {"type": "y"}
        assert queue.empty()
        for i in range(150):  # a slow subscriber loses events, the publisher never blocks
            await bus.publish(tenant, {"i": i})
        assert queue.qsize() == 100
    await bus.publish(tenant, {"type": "nobody listens"})
    await bus.start()
    await bus.stop()


def test_channel_adapter_builder() -> None:
    settings = Settings()
    jivo = Channel(
        kind="jivo", external_id="w", credentials_enc=encrypt('{"provider_id": "p", "token": "t"}')
    )
    assert isinstance(build_channel_adapter(settings, jivo), JivoAdapter)
    ig = Channel(
        kind="instagram", external_id="ig", credentials_enc=encrypt('{"access_token": "a"}')
    )
    assert isinstance(build_channel_adapter(settings, ig), InstagramAdapter)
    assert isinstance(
        build_channel_adapter(settings, Channel(kind="tidio", external_id="t")), TidioAdapter
    )


def test_build_deps() -> None:
    deps = build_deps(Settings(whatsapp_token="x", telephony_provider="twilio"))
    assert type(deps.whatsapp).__name__ == "CloudApiWhatsAppClient"
    assert type(deps.telephony).__name__ == "TwilioTelephonyClient"
    assert type(deps.events).__name__ == "PostgresEventBus"
    with pytest.raises(RuntimeError, match="not built yet"):
        build_deps(Settings(llm_provider="anthropic"))

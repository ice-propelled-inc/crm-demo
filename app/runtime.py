"""Runtime dependencies (adapters, clock, random). One `Deps` object per process.

Tests build a `Deps` with mocks and put it on `app.state.deps`.
"""

import json
import random
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from functools import lru_cache
from typing import Any

import httpx
from fastapi import Request

from app.adapters.channels.base import ChannelAdapter
from app.adapters.channels.instagram import InstagramAdapter
from app.adapters.channels.jivo import JivoAdapter
from app.adapters.channels.tidio import TidioAdapter
from app.adapters.crm.factory import CRMAdapterFactory, build_crm_adapter
from app.adapters.embeddings.base import EmbeddingProvider
from app.adapters.embeddings.mock import MockEmbeddingProvider
from app.adapters.llm.base import LLMProvider
from app.adapters.llm.mock import MockLLMProvider
from app.adapters.telephony.base import TelephonyClient
from app.adapters.telephony.mock import MockTelephonyClient
from app.adapters.telephony.twilio import TwilioTelephonyClient
from app.adapters.whatsapp.base import WhatsAppClient
from app.adapters.whatsapp.cloud_api import CloudApiWhatsAppClient
from app.adapters.whatsapp.mock import MockWhatsAppClient
from app.db.models import Channel
from app.domain.types import ChannelKind
from app.events import EventBus, InMemoryEventBus, PostgresEventBus
from app.security import decrypt
from app.settings import Settings

ChannelFactory = Callable[[Channel], ChannelAdapter]


def _utc_now() -> datetime:
    return datetime.now(UTC)


@dataclass
class Deps:
    settings: Settings
    llm: LLMProvider
    embedder: EmbeddingProvider
    crm_factory: CRMAdapterFactory
    channel_factory: ChannelFactory
    whatsapp: WhatsAppClient
    telephony: TelephonyClient
    events: EventBus
    now: Callable[[], datetime] = _utc_now
    rng: random.Random = field(default_factory=random.Random)


@lru_cache
def _shared_http() -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=15)


def channel_credentials(channel: Channel) -> dict[str, Any]:
    if not channel.credentials_enc:
        return {}
    data: dict[str, Any] = json.loads(decrypt(channel.credentials_enc))
    return data


def build_channel_adapter(settings: Settings, channel: Channel) -> ChannelAdapter:
    creds = channel_credentials(channel)
    kind = ChannelKind(channel.kind)
    if kind is ChannelKind.JIVO:
        return JivoAdapter(
            api_base=settings.jivo_api_base,
            provider_id=creds["provider_id"],
            token=creds["token"],
            http=_shared_http(),
        )
    if kind is ChannelKind.INSTAGRAM:
        return InstagramAdapter(
            api_base=settings.instagram_api_base,
            ig_account_id=channel.external_id,
            access_token=creds["access_token"],
            app_secret=creds.get("app_secret") or settings.instagram_app_secret,
            http=_shared_http(),
        )
    return TidioAdapter()


def build_deps(settings: Settings) -> Deps:
    """Production dependencies. A provider that is not built yet stays a mock."""
    if settings.llm_provider != "mock":
        raise RuntimeError(
            f"LLM provider {settings.llm_provider!r} is not built yet (build step 11). "
            "Use LLM_PROVIDER=mock."
        )
    whatsapp: WhatsAppClient = (
        CloudApiWhatsAppClient(
            api_base=settings.whatsapp_api_base,
            phone_number_id=settings.whatsapp_phone_id,
            token=settings.whatsapp_token,
            http=_shared_http(),
        )
        if settings.whatsapp_token
        else MockWhatsAppClient()
    )
    telephony: TelephonyClient = (
        TwilioTelephonyClient(
            api_base=settings.telephony_api_base,
            account_sid=settings.telephony_account_sid,
            auth_token=settings.telephony_api_key,
            from_number=settings.telephony_from_number,
            http=_shared_http(),
        )
        if settings.telephony_provider == "twilio"
        else MockTelephonyClient()
    )
    return Deps(
        settings=settings,
        llm=MockLLMProvider(),
        embedder=MockEmbeddingProvider(),
        crm_factory=build_crm_adapter,
        channel_factory=lambda channel: build_channel_adapter(settings, channel),
        whatsapp=whatsapp,
        telephony=telephony,
        events=PostgresEventBus(settings.database_url),
    )


def build_test_deps(settings: Settings) -> Deps:
    return Deps(
        settings=settings,
        llm=MockLLMProvider(),
        embedder=MockEmbeddingProvider(),
        crm_factory=build_crm_adapter,
        channel_factory=lambda channel: build_channel_adapter(settings, channel),
        whatsapp=MockWhatsAppClient(),
        telephony=MockTelephonyClient(),
        events=InMemoryEventBus(),
    )


def get_deps(request: Request) -> Deps:
    deps: Deps = request.app.state.deps
    return deps

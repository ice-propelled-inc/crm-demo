"""E2E harness: the real app, the real adapters and the mock servers, all in-process.

- The CRM, Jivo, Instagram, WhatsApp and Twilio adapters send real HTTP to the mock
  servers through an ASGI transport.
- The LLM is the scripted mock. The clock is fake, so delays and timeouts are instant.
- Jobs run when the test calls `world.run_jobs()`.
"""

import json
import random
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import parse_qs, urlparse

import httpx
import pytest
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.adapters.channels.base import ChannelAdapter
from app.adapters.channels.instagram import InstagramAdapter
from app.adapters.channels.jivo import JivoAdapter
from app.adapters.crm.generic_http import GenericHttpCRMAdapter
from app.adapters.embeddings.mock import MockEmbeddingProvider
from app.adapters.llm.base import LLMResponse, ToolCall
from app.adapters.llm.mock import MockLLMProvider
from app.adapters.telephony.twilio import TwilioTelephonyClient
from app.adapters.whatsapp.cloud_api import CloudApiWhatsAppClient
from app.db.models import (
    Channel,
    Conversation,
    Operator,
    Tenant,
    TenantConfig,
    UrgentManager,
    User,
)
from app.db.session import get_sessionmaker
from app.events import InMemoryEventBus
from app.main import create_app
from app.runtime import Deps, channel_credentials
from app.security import encrypt, hmac_sha256_signature
from app.settings import Settings
from app.tenant_settings import DelaySettings, TenantSettings
from app.workers.jobs import run_due_jobs
from mocks import server as mock_server
from tests.integration.conftest import migrated_database  # noqa: F401 - session fixture

MOCK = "http://mock"
JIVO_TOKEN = "jivo-token"
IG_ACCOUNT = "ig-1"
IG_SECRET = "ig-app-secret"
CRM_WEBHOOK_SECRET = "dev-webhook-secret"


@dataclass
class FakeClock:
    value: datetime = field(default_factory=lambda: datetime.now(UTC))

    def now(self) -> datetime:
        return self.value

    def advance(self, seconds: float) -> None:
        self.value += timedelta(seconds=seconds)


def classified(**overrides: Any) -> LLMResponse:
    data: dict[str, Any] = {
        "language": "en",
        "topic": "products_orders",
        "asks_for_human": False,
        "harsh_sentiment": False,
        "confidence": 0.95,
        "confirmation": "none",
        "funnel_stage": "offer",
    }
    data.update(overrides)
    return LLMResponse(text=json.dumps(data))


def reply(text: str) -> LLMResponse:
    return LLMResponse(text=text)


def tool(name: str, **arguments: Any) -> LLMResponse:
    return LLMResponse(
        text="",
        tool_calls=(ToolCall(f"call-{uuid.uuid4().hex[:6]}", name, arguments),),
        stop_reason="tool_use",
    )


@dataclass
class World:
    app_client: httpx.AsyncClient
    mock_http: httpx.AsyncClient
    deps: Deps
    llm: MockLLMProvider
    clock: FakeClock
    tenant_id: uuid.UUID
    jivo_channel_id: uuid.UUID
    ig_channel_id: uuid.UUID

    async def session(self) -> AsyncSession:
        return get_sessionmaker()()

    async def run_jobs(self) -> int:
        total = 0
        while ran := await run_due_jobs(get_sessionmaker(), self.deps):
            total += ran
        return total

    async def jivo(self, text: str, *, client_id: str = "c1", chat_id: str = "chat-1") -> None:
        event = {
            "id": uuid.uuid4().hex,
            "site_id": "site",
            "client_id": client_id,
            "chat_id": chat_id,
            "event": "CLIENT_MESSAGE",
            "sender": {"id": 1, "name": "Alice"},
            "message": {
                "type": "TEXT",
                "text": text,
                "timestamp": int(self.clock.now().timestamp()),
            },
        }
        response = await self.app_client.post(
            f"/webhooks/jivo/{self.tenant_id}/{JIVO_TOKEN}", json=event
        )
        assert response.status_code == 200, response.text
        await self.run_jobs()

    async def instagram(self, text: str, *, sender: str = "ig-user-1") -> httpx.Response:
        body = json.dumps(
            {
                "object": "instagram",
                "entry": [
                    {
                        "id": IG_ACCOUNT,
                        "time": 0,
                        "messaging": [
                            {
                                "sender": {"id": sender},
                                "recipient": {"id": IG_ACCOUNT},
                                "timestamp": int(self.clock.now().timestamp() * 1000),
                                "message": {"mid": uuid.uuid4().hex, "text": text},
                            }
                        ],
                    }
                ],
            }
        ).encode()
        return await self.app_client.post(
            f"/webhooks/instagram/{self.tenant_id}",
            content=body,
            headers={
                "Content-Type": "application/json",
                "X-Hub-Signature-256": hmac_sha256_signature(IG_SECRET, body),
            },
        )

    async def recorded(self, service: str) -> list[dict[str, Any]]:
        records: list[dict[str, Any]] = (
            await self.mock_http.get(f"{MOCK}/_recorded/{service}")
        ).json()
        return records

    async def jivo_texts(self) -> list[str]:
        return [r["body"]["message"]["text"] for r in await self.recorded("jivo")]

    async def crm_status(self, order_id: str, status: str, *, webhook: bool = True) -> None:
        """Change the status in the mock CRM, then (optionally) send the signed webhook."""
        event = (
            await self.mock_http.post(
                f"{MOCK}/crm/_control/orders/{order_id}/status",
                json={"status": status, "tenant_id": str(self.tenant_id), "send_webhook": False},
            )
        ).json()
        if webhook:
            payload = json.dumps(event).encode()
            response = await self.app_client.post(
                f"/webhooks/crm/{self.tenant_id}",
                content=payload,
                headers={
                    "Content-Type": "application/json",
                    "X-Signature": hmac_sha256_signature(CRM_WEBHOOK_SECRET, payload),
                },
            )
            assert response.json()["status"] == "queued"

    async def set_config(self, **changes: Any) -> None:
        base = TenantSettings(
            delays=DelaySettings(min_delay=0, max_delay=0, per_char_delay=0, max_total_delay=0),
        )
        settings = TenantSettings.model_validate({**base.model_dump(), **changes})
        async with get_sessionmaker()() as session:
            last = await session.scalar(
                select(TenantConfig.version)
                .where(TenantConfig.tenant_id == self.tenant_id)
                .order_by(TenantConfig.version.desc())
                .limit(1)
            )
            session.add(
                TenantConfig(
                    tenant_id=self.tenant_id,
                    version=(last or 0) + 1,
                    data=settings.model_dump(mode="json"),
                )
            )
            await session.commit()

    async def conversation(self, client_ref: str = "c1") -> Conversation:
        from app.db.models import Client

        async with get_sessionmaker()() as session:
            conversation = await session.scalar(
                select(Conversation)
                .join(Client, Client.id == Conversation.client_id)
                .where(Client.tenant_id == self.tenant_id, Client.channel_user_id == client_ref)
            )
            assert conversation is not None
            return conversation

    async def login(self, crm_user: str) -> httpx.AsyncClient:
        """A new browser (cookie jar) logged in through the mock CRM as `crm_user`."""
        client = httpx.AsyncClient(
            transport=self.app_client._transport,
            base_url="http://localhost:8000",
        )
        start = await client.get("/auth/login", params={"tenant_id": str(self.tenant_id)})
        authorize = await self.mock_http.get(start.headers["location"] + f"&login_as={crm_user}")
        params = {
            k: v[0] for k, v in parse_qs(urlparse(authorize.headers["location"]).query).items()
        }
        done = await client.get("/auth/callback", params=params)
        assert done.status_code == 302, done.text
        return client


def _channel_factory(settings: Settings, http: httpx.AsyncClient) -> Any:
    def build(channel: Channel) -> ChannelAdapter:
        creds = channel_credentials(channel)
        if channel.kind == "jivo":
            return JivoAdapter(
                api_base=settings.jivo_api_base,
                provider_id=creds["provider_id"],
                token=creds["token"],
                http=http,
            )
        return InstagramAdapter(
            api_base=settings.instagram_api_base,
            ig_account_id=channel.external_id,
            access_token=creds["access_token"],
            app_secret=creds["app_secret"],
            http=http,
        )

    return build


async def create_tenant(session: AsyncSession, name: str = "E2E shop") -> Tenant:
    tenant = Tenant(
        name=name,
        crm_base_url=f"{MOCK}/crm",
        crm_client_id="dev-client",
        crm_client_secret_enc=encrypt("dev-secret"),
        crm_webhook_secret_enc=encrypt(CRM_WEBHOOK_SECRET),
    )
    session.add(tenant)
    await session.flush()
    return tenant


async def add_people(session: AsyncSession, tenant: Tenant) -> None:
    for crm_id, phone in (("operator-1", "+33600000001"), ("operator-2", "+33600000002")):
        user = User(tenant_id=tenant.id, crm_user_id=crm_id, name=crm_id, roles=[])
        session.add(user)
        await session.flush()
        session.add(Operator(tenant_id=tenant.id, user_id=user.id, whatsapp_number=phone))
    manager = User(tenant_id=tenant.id, crm_user_id="manager-1", name="Max", roles=[])
    session.add(manager)
    await session.flush()
    session.add(
        UrgentManager(
            tenant_id=tenant.id,
            user_id=manager.id,
            phone_number="+33600000009",
            communication_types=["phone_call", "whatsapp_text"],
        )
    )


@pytest.fixture
async def world() -> AsyncIterator[World]:
    mock_server.reset()
    mock_http = httpx.AsyncClient(transport=httpx.ASGITransport(app=mock_server.create_mock_app()))
    settings = Settings(
        jivo_api_base=f"{MOCK}/jivo",
        instagram_api_base=f"{MOCK}/instagram",
        whatsapp_api_base=f"{MOCK}/whatsapp",
        telephony_api_base=f"{MOCK}/twilio",
        operator_chat_url="http://localhost:5174/operator",
    )
    clock = FakeClock()
    llm = MockLLMProvider()
    deps = Deps(
        settings=settings,
        llm=llm,
        embedder=MockEmbeddingProvider(),
        crm_factory=lambda tenant: GenericHttpCRMAdapter(
            base_url=tenant.crm_base_url,
            client_id="dev-client",
            client_secret="dev-secret",
            webhook_secret=CRM_WEBHOOK_SECRET,
            http=mock_http,
        ),
        channel_factory=_channel_factory(settings, mock_http),
        whatsapp=CloudApiWhatsAppClient(
            api_base=settings.whatsapp_api_base,
            phone_number_id="wa-phone",
            token="wa-token",
            http=mock_http,
        ),
        telephony=TwilioTelephonyClient(
            api_base=settings.telephony_api_base,
            account_sid="AC1",
            auth_token="tw-token",
            from_number="+10000000000",
            http=mock_http,
        ),
        events=InMemoryEventBus(),
        now=clock.now,
        rng=random.Random(1),
    )

    async with get_sessionmaker()() as session:
        await session.execute(delete(Tenant))
        tenant = await create_tenant(session)
        jivo = Channel(
            tenant_id=tenant.id,
            kind="jivo",
            external_id="widget-1",
            credentials_enc=encrypt(json.dumps({"provider_id": "prov", "token": JIVO_TOKEN})),
        )
        instagram = Channel(
            tenant_id=tenant.id,
            kind="instagram",
            external_id=IG_ACCOUNT,
            credentials_enc=encrypt(
                json.dumps({"access_token": "ig-token", "app_secret": IG_SECRET})
            ),
        )
        session.add_all([jivo, instagram])
        await add_people(session, tenant)
        await session.commit()
        ids = (tenant.id, jivo.id, instagram.id)

    app = create_app(deps)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://localhost:8000") as client:
        world = World(client, mock_http, deps, llm, clock, *ids)
        await world.set_config()
        yield world
    await mock_http.aclose()
    async with get_sessionmaker()() as session:
        await session.execute(delete(Tenant))
        await session.commit()

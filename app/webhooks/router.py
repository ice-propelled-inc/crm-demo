"""Incoming webhooks. Each handler: validate, remove duplicates, queue, return 200 (rule 7)."""

import json
import logging
import uuid
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import PlainTextResponse
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.adapters.channels.base import ChannelAdapter, InboundMessage, InvalidChannelWebhook
from app.adapters.channels.jivo import JivoAdapter
from app.adapters.channels.tidio import REASON as TIDIO_REASON
from app.adapters.crm.base import CRMError, InvalidWebhookSignature
from app.db.models import Channel, ProcessedEvent, Tenant
from app.db.session import get_session
from app.domain.types import ChannelKind
from app.runtime import Deps, get_deps
from app.security import verify_hmac_sha256
from app.workers.handlers import inbound_to_payload
from app.workers.jobs import JobKind, enqueue

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/webhooks", tags=["webhooks"])

Session = Annotated[AsyncSession, Depends(get_session)]
DepsDep = Annotated[Deps, Depends(get_deps)]


async def _first_time(
    session: AsyncSession, tenant_id: uuid.UUID, source: str, event_id: str
) -> bool:
    """Record the event. False if it was already processed."""
    inserted = await session.scalar(
        insert(ProcessedEvent)
        .values(id=uuid.uuid4(), tenant_id=tenant_id, source=source, event_id=event_id)
        .on_conflict_do_nothing(index_elements=["tenant_id", "source", "event_id"])
        .returning(ProcessedEvent.id)
    )
    return inserted is not None


async def _tenant(session: AsyncSession, tenant_id: uuid.UUID) -> Tenant:
    tenant = await session.get(Tenant, tenant_id)
    if tenant is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Unknown tenant")
    return tenant


async def _channels(
    session: AsyncSession, tenant_id: uuid.UUID, kind: ChannelKind
) -> list[Channel]:
    return list(
        (
            await session.scalars(
                select(Channel).where(
                    Channel.tenant_id == tenant_id,
                    Channel.kind == kind.value,
                    Channel.enabled.is_(True),
                )
            )
        ).all()
    )


async def _queue_messages(
    session: AsyncSession, deps: Deps, channel: Channel, messages: list[InboundMessage]
) -> int:
    queued = 0
    for message in messages:
        if await _first_time(session, channel.tenant_id, channel.kind, message.provider_message_id):
            enqueue(
                session,
                tenant_id=channel.tenant_id,
                kind=JobKind.INBOUND_MESSAGE,
                payload=inbound_to_payload(channel.id, message),
                run_at=deps.now(),
            )
            queued += 1
    await session.commit()
    return queued


@router.post("/crm/{tenant_id}")
async def crm_webhook(
    tenant_id: uuid.UUID, request: Request, session: Session, deps: DepsDep
) -> dict[str, str]:
    tenant = await _tenant(session, tenant_id)
    body = await request.body()
    try:
        event = deps.crm_factory(tenant).parse_webhook(dict(request.headers), body)
    except InvalidWebhookSignature as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid signature") from exc
    except CRMError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    if not await _first_time(session, tenant.id, "crm", event.event_id):
        return {"status": "duplicate"}
    enqueue(
        session,
        tenant_id=tenant.id,
        kind=JobKind.CRM_STATUS,
        payload={
            "crm_order_id": event.crm_order_id,
            "status": event.status.value,
            "changed_at": event.changed_at.isoformat(),
        },
        run_at=deps.now(),
    )
    await session.commit()
    return {"status": "queued"}


@router.post("/jivo/{tenant_id}/{token}")
async def jivo_webhook(
    tenant_id: uuid.UUID, token: str, request: Request, session: Session, deps: DepsDep
) -> dict[str, Any]:
    body = await request.body()
    for channel in await _channels(session, tenant_id, ChannelKind.JIVO):
        adapter = deps.channel_factory(channel)
        if isinstance(adapter, JivoAdapter) and not adapter.verify_path_token(token):
            continue
        try:
            messages = adapter.parse_webhook(dict(request.headers), body)
        except InvalidChannelWebhook as exc:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
        return {"queued": await _queue_messages(session, deps, channel, messages)}
    raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Unknown Jivo channel or token")


@router.get("/instagram/{tenant_id}", response_class=PlainTextResponse)
async def instagram_verify(
    tenant_id: uuid.UUID,
    deps: DepsDep,
    mode: Annotated[str, Query(alias="hub.mode")],
    token: Annotated[str, Query(alias="hub.verify_token")],
    challenge: Annotated[str, Query(alias="hub.challenge")],
) -> str:
    expected = deps.settings.instagram_verify_token
    if mode != "subscribe" or not expected or token != expected:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Verification failed")
    return challenge


@router.post("/instagram/{tenant_id}")
async def instagram_webhook(
    tenant_id: uuid.UUID, request: Request, session: Session, deps: DepsDep
) -> dict[str, Any]:
    body = await request.body()
    try:
        account_ids = {str(e["id"]) for e in json.loads(body).get("entry", [])}
    except (ValueError, KeyError, TypeError, AttributeError) as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Body is not valid") from exc
    queued = 0
    matched = False
    for channel in await _channels(session, tenant_id, ChannelKind.INSTAGRAM):
        if channel.external_id not in account_ids:
            continue
        matched = True
        adapter: ChannelAdapter = deps.channel_factory(channel)
        try:
            messages = adapter.parse_webhook(dict(request.headers), body)
        except InvalidChannelWebhook as exc:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, str(exc)) from exc
        queued += await _queue_messages(
            session, deps, channel, [m for m in messages if m.account_ref == channel.external_id]
        )
    if not matched:
        logger.info("Instagram webhook for unknown accounts %s", account_ids)
    return {"queued": queued}


@router.post("/tidio/{tenant_id}", status_code=status.HTTP_501_NOT_IMPLEMENTED)
async def tidio_webhook(tenant_id: uuid.UUID) -> dict[str, str]:
    raise HTTPException(status.HTTP_501_NOT_IMPLEMENTED, TIDIO_REASON)


@router.get("/whatsapp", response_class=PlainTextResponse)
async def whatsapp_verify(
    deps: DepsDep,
    mode: Annotated[str, Query(alias="hub.mode")],
    token: Annotated[str, Query(alias="hub.verify_token")],
    challenge: Annotated[str, Query(alias="hub.challenge")],
) -> str:
    expected = deps.settings.whatsapp_verify_token
    if mode != "subscribe" or not expected or token != expected:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Verification failed")
    return challenge


@router.post("/whatsapp")
async def whatsapp_status(request: Request, deps: DepsDep) -> dict[str, str]:
    """Delivery status of the notifications. Only logged."""
    body = await request.body()
    secret = deps.settings.whatsapp_app_secret
    if not secret or not verify_hmac_sha256(
        secret, body, request.headers.get("x-hub-signature-256")
    ):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid signature")
    logger.info("WhatsApp status callback: %d bytes", len(body))
    return {"status": "ok"}

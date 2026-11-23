"""Admin API (setup only). Role: admin. Each query is limited to the tenant of the user."""

import json
import secrets
import uuid
from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import CurrentUser, require_roles
from app.db.models import (
    Channel,
    Client,
    DialogExample,
    LanguagePack,
    Operator,
    Prompt,
    Tenant,
    TenantConfig,
    UrgentManager,
    User,
)
from app.db.session import get_session
from app.domain.types import ChannelKind, CommunicationType, Role
from app.runtime import Deps, channel_credentials, get_deps
from app.security import encrypt
from app.tenant_settings import TONE_PRESETS, TenantSettings, latest_config

router = APIRouter(prefix="/admin/api", tags=["admin"])

Session = Annotated[AsyncSession, Depends(get_session)]
DepsDep = Annotated[Deps, Depends(get_deps)]
Admin = Annotated[CurrentUser, Depends(require_roles(Role.ADMIN))]


def _not_found(what: str) -> HTTPException:
    return HTTPException(status.HTTP_404_NOT_FOUND, f"Unknown {what}")


# ---------- configuration ----------


class ConfigOut(BaseModel):
    version: int
    settings: TenantSettings
    tone_presets: list[str]


class ConfigVersion(BaseModel):
    version: int
    created_at: datetime
    created_by: uuid.UUID | None


@router.get("/config")
async def get_config(user: Admin, session: Session) -> ConfigOut:
    config = await latest_config(session, user.tenant_id)
    settings = TenantSettings.model_validate(config.data) if config else TenantSettings()
    return ConfigOut(
        version=config.version if config else 0, settings=settings, tone_presets=list(TONE_PRESETS)
    )


@router.put("/config")
async def put_config(body: TenantSettings, user: Admin, session: Session) -> ConfigOut:
    config = await latest_config(session, user.tenant_id)
    version = (config.version if config else 0) + 1
    session.add(
        TenantConfig(
            tenant_id=user.tenant_id,
            version=version,
            data=body.model_dump(mode="json"),
            created_by=user.id,
        )
    )
    await session.commit()
    return ConfigOut(version=version, settings=body, tone_presets=list(TONE_PRESETS))


@router.get("/config/versions")
async def config_versions(user: Admin, session: Session) -> list[ConfigVersion]:
    rows = (
        await session.scalars(
            select(TenantConfig)
            .where(TenantConfig.tenant_id == user.tenant_id)
            .order_by(TenantConfig.version.desc())
        )
    ).all()
    return [
        ConfigVersion(version=r.version, created_at=r.created_at, created_by=r.created_by)
        for r in rows
    ]


# ---------- prompts ----------


class PromptOut(BaseModel):
    key: str
    language: str
    body: str
    source: str  # "tenant" or "default"
    version: int


class PromptIn(BaseModel):
    body: str = Field(min_length=1, max_length=20000)


@router.get("/prompts")
async def list_prompts(user: Admin, session: Session) -> list[PromptOut]:
    rows = (
        await session.scalars(
            select(Prompt).where(
                or_(Prompt.tenant_id == user.tenant_id, Prompt.tenant_id.is_(None))
            )
        )
    ).all()
    best: dict[tuple[str, str], Prompt] = {}
    for p in rows:
        current = best.get((p.key, p.language))
        rank = (1 if p.tenant_id else 0, p.version)
        if current is None or rank > (1 if current.tenant_id else 0, current.version):
            best[(p.key, p.language)] = p
    return [
        PromptOut(
            key=p.key,
            language=p.language,
            body=p.body,
            source="tenant" if p.tenant_id else "default",
            version=p.version,
        )
        for (_, _), p in sorted(best.items())
    ]


@router.put("/prompts/{key}/{language}")
async def put_prompt(
    key: str, language: str, body: PromptIn, user: Admin, session: Session
) -> PromptOut:
    last = await session.scalar(
        select(func.max(Prompt.version)).where(
            Prompt.tenant_id == user.tenant_id, Prompt.key == key, Prompt.language == language
        )
    )
    prompt = Prompt(
        tenant_id=user.tenant_id,
        key=key,
        language=language,
        version=(last or 0) + 1,
        body=body.body,
    )
    session.add(prompt)
    await session.commit()
    return PromptOut(
        key=key, language=language, body=body.body, source="tenant", version=prompt.version
    )


# ---------- operators and urgent managers ----------


async def _user_for(
    session: AsyncSession, tenant_id: uuid.UUID, crm_user_id: str, name: str | None
) -> User:
    user = await session.scalar(
        select(User).where(User.tenant_id == tenant_id, User.crm_user_id == crm_user_id)
    )
    if user is None:
        user = User(tenant_id=tenant_id, crm_user_id=crm_user_id, name=name, roles=[])
        session.add(user)
        await session.flush()
    elif name and not user.name:
        user.name = name
    return user


class OperatorIn(BaseModel):
    crm_user_id: str = Field(min_length=1)
    name: str | None = None
    whatsapp_number: str = Field(pattern=r"^\+?[0-9]{6,20}$")
    is_available: bool = True


class OperatorOut(BaseModel):
    id: uuid.UUID
    crm_user_id: str
    name: str | None
    whatsapp_number: str
    is_available: bool


@router.get("/operators")
async def list_operators(user: Admin, session: Session) -> list[OperatorOut]:
    rows = (
        await session.execute(
            select(Operator, User)
            .join(User, User.id == Operator.user_id)
            .where(Operator.tenant_id == user.tenant_id)
            .order_by(Operator.created_at)
        )
    ).all()
    return [
        OperatorOut(
            id=o.id,
            crm_user_id=u.crm_user_id,
            name=u.name,
            whatsapp_number=o.whatsapp_number,
            is_available=o.is_available,
        )
        for o, u in rows
    ]


@router.post("/operators", status_code=status.HTTP_201_CREATED)
async def add_operator(body: OperatorIn, user: Admin, session: Session) -> OperatorOut:
    target = await _user_for(session, user.tenant_id, body.crm_user_id, body.name)
    exists = await session.scalar(select(Operator).where(Operator.user_id == target.id))
    if exists:
        raise HTTPException(status.HTTP_409_CONFLICT, "This user is already an operator")
    operator = Operator(
        tenant_id=user.tenant_id,
        user_id=target.id,
        whatsapp_number=body.whatsapp_number,
        is_available=body.is_available,
    )
    session.add(operator)
    await session.commit()
    return OperatorOut(
        id=operator.id,
        crm_user_id=target.crm_user_id,
        name=target.name,
        whatsapp_number=operator.whatsapp_number,
        is_available=operator.is_available,
    )


@router.delete("/operators/{operator_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_operator(operator_id: uuid.UUID, user: Admin, session: Session) -> Response:
    result = await session.execute(
        delete(Operator).where(Operator.id == operator_id, Operator.tenant_id == user.tenant_id)
    )
    if result.rowcount == 0:  # type: ignore[attr-defined]
        raise _not_found("operator")
    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


class UrgentManagerIn(BaseModel):
    crm_user_id: str = Field(min_length=1)
    name: str | None = None
    phone_number: str = Field(pattern=r"^\+?[0-9]{6,20}$")
    communication_types: list[CommunicationType] = Field(min_length=1)


class UrgentManagerOut(BaseModel):
    id: uuid.UUID
    crm_user_id: str
    name: str | None
    phone_number: str
    communication_types: list[CommunicationType]


@router.get("/urgent-managers")
async def list_urgent_managers(user: Admin, session: Session) -> list[UrgentManagerOut]:
    rows = (
        await session.execute(
            select(UrgentManager, User)
            .join(User, User.id == UrgentManager.user_id)
            .where(UrgentManager.tenant_id == user.tenant_id)
            .order_by(UrgentManager.created_at)
        )
    ).all()
    return [
        UrgentManagerOut(
            id=m.id,
            crm_user_id=u.crm_user_id,
            name=u.name,
            phone_number=m.phone_number,
            communication_types=[CommunicationType(t) for t in m.communication_types],
        )
        for m, u in rows
    ]


@router.post("/urgent-managers", status_code=status.HTTP_201_CREATED)
async def add_urgent_manager(
    body: UrgentManagerIn, user: Admin, session: Session
) -> UrgentManagerOut:
    target = await _user_for(session, user.tenant_id, body.crm_user_id, body.name)
    exists = await session.scalar(select(UrgentManager).where(UrgentManager.user_id == target.id))
    if exists:
        raise HTTPException(status.HTTP_409_CONFLICT, "This user is already an urgent manager")
    manager = UrgentManager(
        tenant_id=user.tenant_id,
        user_id=target.id,
        phone_number=body.phone_number,
        communication_types=sorted({t.value for t in body.communication_types}),
    )
    session.add(manager)
    await session.commit()
    return UrgentManagerOut(
        id=manager.id,
        crm_user_id=target.crm_user_id,
        name=target.name,
        phone_number=manager.phone_number,
        communication_types=[CommunicationType(t) for t in manager.communication_types],
    )


@router.delete("/urgent-managers/{manager_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_urgent_manager(manager_id: uuid.UUID, user: Admin, session: Session) -> Response:
    result = await session.execute(
        delete(UrgentManager).where(
            UrgentManager.id == manager_id, UrgentManager.tenant_id == user.tenant_id
        )
    )
    if result.rowcount == 0:  # type: ignore[attr-defined]
        raise _not_found("urgent manager")
    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ---------- language packs and dialog dataset ----------


class LanguagePackIn(BaseModel):
    language: str = Field(pattern=r"^[a-z]{2,3}(-[A-Z]{2})?$")
    name: str = Field(min_length=1)
    enabled: bool = True


class LanguagePackOut(LanguagePackIn):
    id: uuid.UUID


@router.get("/language-packs")
async def list_language_packs(user: Admin, session: Session) -> list[LanguagePackOut]:
    rows = (
        await session.scalars(select(LanguagePack).where(LanguagePack.tenant_id == user.tenant_id))
    ).all()
    return [
        LanguagePackOut(id=r.id, language=r.language, name=r.name, enabled=r.enabled) for r in rows
    ]


@router.post("/language-packs", status_code=status.HTTP_201_CREATED)
async def add_language_pack(body: LanguagePackIn, user: Admin, session: Session) -> LanguagePackOut:
    pack = LanguagePack(tenant_id=user.tenant_id, **body.model_dump())
    session.add(pack)
    await session.commit()
    return LanguagePackOut(id=pack.id, **body.model_dump())


@router.delete("/language-packs/{pack_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_language_pack(pack_id: uuid.UUID, user: Admin, session: Session) -> Response:
    result = await session.execute(
        delete(LanguagePack).where(
            LanguagePack.id == pack_id, LanguagePack.tenant_id == user.tenant_id
        )
    )
    if result.rowcount == 0:  # type: ignore[attr-defined]
        raise _not_found("language pack")
    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


class DialogExampleIn(BaseModel):
    language: str = Field(min_length=2, max_length=10)
    tone_tag: str | None = None
    content: str = Field(min_length=1, max_length=8000)


class DialogUpload(BaseModel):
    examples: list[DialogExampleIn] = Field(min_length=1, max_length=1000)


class DialogGroup(BaseModel):
    language: str
    tone_tag: str | None
    count: int


@router.get("/dialog-examples")
async def dialog_groups(user: Admin, session: Session) -> list[DialogGroup]:
    rows = (
        await session.execute(
            select(DialogExample.language, DialogExample.tone_tag, func.count())
            .where(DialogExample.tenant_id == user.tenant_id)
            .group_by(DialogExample.language, DialogExample.tone_tag)
            .order_by(DialogExample.language)
        )
    ).all()
    return [DialogGroup(language=lang, tone_tag=tag, count=n) for lang, tag, n in rows]


@router.post("/dialog-examples", status_code=status.HTTP_201_CREATED)
async def upload_dialogs(
    body: DialogUpload, user: Admin, session: Session, deps: DepsDep
) -> dict[str, int]:
    vectors = await deps.embedder.embed([e.content for e in body.examples])
    for example, vector in zip(body.examples, vectors, strict=True):
        session.add(
            DialogExample(
                tenant_id=user.tenant_id,
                language=example.language,
                tone_tag=example.tone_tag,
                content=example.content,
                embedding=vector,
            )
        )
    await session.commit()
    return {"added": len(body.examples)}


@router.delete("/dialog-examples", status_code=status.HTTP_204_NO_CONTENT)
async def delete_dialogs(
    user: Admin, session: Session, language: str, tone_tag: str | None = None
) -> Response:
    query = delete(DialogExample).where(
        DialogExample.tenant_id == user.tenant_id, DialogExample.language == language
    )
    if tone_tag is not None:
        query = query.where(DialogExample.tone_tag == tone_tag)
    await session.execute(query)
    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ---------- channels and CRM connection ----------


class ChannelIn(BaseModel):
    kind: ChannelKind
    external_id: str = Field(min_length=1)
    credentials: dict[str, str] = Field(default_factory=dict)
    enabled: bool = True


class ChannelPatch(BaseModel):
    enabled: bool | None = None
    credentials: dict[str, str] | None = None


class ChannelOut(BaseModel):
    id: uuid.UUID
    kind: ChannelKind
    external_id: str
    enabled: bool
    credential_keys: list[str]
    webhook_url: str | None


REQUIRED_CREDENTIALS = {
    ChannelKind.JIVO: {"provider_id"},
    ChannelKind.INSTAGRAM: {"access_token"},
    ChannelKind.TIDIO: set(),
    ChannelKind.TEST: set(),
}


def _channel_out(deps: Deps, channel: Channel) -> ChannelOut:
    creds = channel_credentials(channel)
    base = deps.settings.public_base_url.rstrip("/")
    kind = ChannelKind(channel.kind)
    url: str | None
    if kind is ChannelKind.JIVO:
        url = f"{base}/webhooks/jivo/{channel.tenant_id}/{creds.get('token', '')}"
    elif kind is ChannelKind.INSTAGRAM:
        url = f"{base}/webhooks/instagram/{channel.tenant_id}"
    else:
        url = None
    return ChannelOut(
        id=channel.id,
        kind=kind,
        external_id=channel.external_id,
        enabled=channel.enabled,
        credential_keys=sorted(creds),
        webhook_url=url,
    )


@router.get("/channels")
async def list_channels(user: Admin, session: Session, deps: DepsDep) -> list[ChannelOut]:
    rows = (await session.scalars(select(Channel).where(Channel.tenant_id == user.tenant_id))).all()
    return [_channel_out(deps, c) for c in rows]


@router.post("/channels", status_code=status.HTTP_201_CREATED)
async def add_channel(body: ChannelIn, user: Admin, session: Session, deps: DepsDep) -> ChannelOut:
    if body.kind is ChannelKind.TIDIO:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "Tidio is not supported: its API has no live-chat bot interface",
        )
    missing = REQUIRED_CREDENTIALS[body.kind] - set(body.credentials)
    if missing:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, f"Missing credentials: {sorted(missing)}"
        )
    creds = dict(body.credentials)
    if body.kind is ChannelKind.JIVO:
        creds.setdefault("token", secrets.token_urlsafe(24))  # the token in both Jivo URLs
    channel = Channel(
        tenant_id=user.tenant_id,
        kind=body.kind.value,
        external_id=body.external_id,
        credentials_enc=encrypt(json.dumps(creds)),
        enabled=body.enabled,
    )
    session.add(channel)
    await session.commit()
    return _channel_out(deps, channel)


async def _own_channel(session: AsyncSession, user: CurrentUser, channel_id: uuid.UUID) -> Channel:
    channel = await session.get(Channel, channel_id)
    if channel is None or channel.tenant_id != user.tenant_id:
        raise _not_found("channel")
    return channel


@router.patch("/channels/{channel_id}")
async def patch_channel(
    channel_id: uuid.UUID, body: ChannelPatch, user: Admin, session: Session, deps: DepsDep
) -> ChannelOut:
    channel = await _own_channel(session, user, channel_id)
    if body.enabled is not None:
        channel.enabled = body.enabled
    if body.credentials is not None:
        channel.credentials_enc = encrypt(
            json.dumps({**channel_credentials(channel), **body.credentials})
        )
    await session.commit()
    return _channel_out(deps, channel)


@router.delete("/channels/{channel_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_channel(channel_id: uuid.UUID, user: Admin, session: Session) -> Response:
    channel = await _own_channel(session, user, channel_id)
    await session.delete(channel)
    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


class CrmConnectionIn(BaseModel):
    base_url: str = Field(pattern=r"^https?://")
    client_id: str = Field(min_length=1)
    client_secret: str | None = None
    webhook_secret: str | None = None


class CrmConnectionOut(BaseModel):
    base_url: str
    client_id: str
    has_client_secret: bool
    has_webhook_secret: bool
    webhook_url: str


@router.get("/crm-connection")
async def get_crm_connection(user: Admin, session: Session, deps: DepsDep) -> CrmConnectionOut:
    tenant = await session.get_one(Tenant, user.tenant_id)
    return _crm_out(deps, tenant)


def _crm_out(deps: Deps, tenant: Tenant) -> CrmConnectionOut:
    return CrmConnectionOut(
        base_url=tenant.crm_base_url,
        client_id=tenant.crm_client_id,
        has_client_secret=bool(tenant.crm_client_secret_enc),
        has_webhook_secret=bool(tenant.crm_webhook_secret_enc),
        webhook_url=f"{deps.settings.public_base_url.rstrip('/')}/webhooks/crm/{tenant.id}",
    )


@router.put("/crm-connection")
async def put_crm_connection(
    body: CrmConnectionIn, user: Admin, session: Session, deps: DepsDep
) -> CrmConnectionOut:
    tenant = await session.get_one(Tenant, user.tenant_id)
    tenant.crm_base_url = body.base_url
    tenant.crm_client_id = body.client_id
    if body.client_secret:
        tenant.crm_client_secret_enc = encrypt(body.client_secret)
    if body.webhook_secret:
        tenant.crm_webhook_secret_enc = encrypt(body.webhook_secret)
    await session.commit()
    return _crm_out(deps, tenant)


# ---------- client data (deletion on request) ----------


class ClientOut(BaseModel):
    id: uuid.UUID
    channel: str
    channel_user_id: str
    display_name: str | None
    created_at: datetime


@router.get("/clients")
async def find_clients(user: Admin, session: Session, search: str = "") -> list[ClientOut]:
    query = (
        select(Client, Channel.kind)
        .join(Channel, Channel.id == Client.channel_id)
        .where(Client.tenant_id == user.tenant_id)
    )
    if search:
        like = f"%{search}%"
        query = query.where(
            or_(Client.display_name.ilike(like), Client.channel_user_id.ilike(like))
        )
    rows = (await session.execute(query.order_by(Client.created_at.desc()).limit(50))).all()
    return [
        ClientOut(
            id=c.id,
            channel=kind,
            channel_user_id=c.channel_user_id,
            display_name=c.display_name,
            created_at=c.created_at,
        )
        for c, kind in rows
    ]


@router.delete("/clients/{client_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_client_data(client_id: uuid.UUID, user: Admin, session: Session) -> Response:
    """Delete all data of one client: conversations, messages, memory, orders, pending messages."""
    client = await session.get(Client, client_id)
    if client is None or client.tenant_id != user.tenant_id:
        raise _not_found("client")
    await session.delete(client)  # ON DELETE CASCADE removes the rest
    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


def config_payload(settings: TenantSettings) -> dict[str, Any]:
    return settings.model_dump(mode="json")

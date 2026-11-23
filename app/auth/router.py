"""CRM OAuth login for admins, operators and urgent managers."""

import secrets
import uuid
from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import RedirectResponse, Response
from sqlalchemy import exists, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.adapters.crm.base import CRMError, CrmUser
from app.adapters.crm.factory import CRMAdapterFactory, get_crm_adapter_factory
from app.auth.deps import SESSION_USER_KEY, CurrentUser, get_current_user
from app.auth.pkce import code_challenge_s256, new_code_verifier
from app.db.models import Operator, Tenant, UrgentManager, User
from app.db.session import get_session
from app.domain.types import Role
from app.settings import get_settings

router = APIRouter(prefix="/auth", tags=["auth"])

SESSION_OAUTH_KEY = "oauth"

Session = Annotated[AsyncSession, Depends(get_session)]
AdapterFactory = Annotated[CRMAdapterFactory, Depends(get_crm_adapter_factory)]


def _redirect_uri() -> str:
    return f"{get_settings().public_base_url}/auth/callback"


def _safe_next(next_path: str) -> str:
    """Relative paths, or URLs on a configured SPA origin. This prevents an open redirect."""
    if "\\" in next_path:
        return "/"
    if next_path.startswith("/") and not next_path.startswith("//"):
        return next_path
    settings = get_settings()
    for origin in [settings.public_base_url, *settings.frontend_origins]:
        if next_path == origin or next_path.startswith(origin.rstrip("/") + "/"):
            return next_path
    return "/"


async def _get_tenant(session: AsyncSession, tenant_id: uuid.UUID) -> Tenant:
    tenant = await session.get(Tenant, tenant_id)
    if tenant is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Unknown tenant")
    return tenant


async def _roles_for(session: AsyncSession, user: User, crm_user: CrmUser) -> list[Role]:
    roles: list[Role] = []
    if crm_user.is_admin:
        roles.append(Role.ADMIN)
    if await session.scalar(select(exists().where(Operator.user_id == user.id))):
        roles.append(Role.OPERATOR)
    if await session.scalar(select(exists().where(UrgentManager.user_id == user.id))):
        roles.append(Role.URGENT_MANAGER)
    return roles


@router.get("/login")
async def login(
    request: Request,
    tenant_id: uuid.UUID,
    session: Session,
    adapters: AdapterFactory,
    next: str = "/",
) -> RedirectResponse:
    tenant = await _get_tenant(session, tenant_id)
    state = secrets.token_urlsafe(24)
    verifier = new_code_verifier()
    request.session[SESSION_OAUTH_KEY] = {
        "state": state,
        "verifier": verifier,
        "tenant_id": str(tenant.id),
        "next": _safe_next(next),
    }
    url = adapters(tenant).authorization_url(
        state=state, redirect_uri=_redirect_uri(), code_challenge=code_challenge_s256(verifier)
    )
    return RedirectResponse(url, status.HTTP_302_FOUND)


@router.get("/callback")
async def callback(
    request: Request, code: str, state: str, session: Session, adapters: AdapterFactory
) -> RedirectResponse:
    pending: Any = request.session.pop(SESSION_OAUTH_KEY, None)
    if not isinstance(pending, dict) or not secrets.compare_digest(pending["state"], state):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid login state")

    tenant = await _get_tenant(session, uuid.UUID(pending["tenant_id"]))
    crm = adapters(tenant)
    try:
        tokens = await crm.exchange_code(
            code=code, redirect_uri=_redirect_uri(), code_verifier=pending["verifier"]
        )
        crm_user = await crm.get_current_user(tokens.access_token)
    except CRMError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "CRM login failed") from exc

    user = await session.scalar(
        select(User).where(User.tenant_id == tenant.id, User.crm_user_id == crm_user.crm_user_id)
    )
    if user is None:
        user = User(tenant_id=tenant.id, crm_user_id=crm_user.crm_user_id)
        session.add(user)
        await session.flush()
    user.name = crm_user.name
    user.email = crm_user.email
    user.roles = [r.value for r in await _roles_for(session, user, crm_user)]
    user.last_login_at = datetime.now(UTC)
    await session.commit()

    if not user.roles:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "No access to AI-chat-helper")

    request.session[SESSION_USER_KEY] = {
        "id": str(user.id),
        "tenant_id": str(tenant.id),
        "roles": list(user.roles),
    }
    return RedirectResponse(pending["next"], status.HTTP_302_FOUND)


@router.get("/me")
async def me(user: Annotated[CurrentUser, Depends(get_current_user)]) -> dict[str, Any]:
    return {
        "id": str(user.id),
        "tenant_id": str(user.tenant_id),
        "roles": sorted(r.value for r in user.roles),
    }


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(request: Request) -> Response:
    request.session.clear()
    return Response(status_code=status.HTTP_204_NO_CONTENT)

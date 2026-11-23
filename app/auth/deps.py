"""Session user and role checks for the admin and operator APIs."""

import uuid
from collections.abc import Callable
from dataclasses import dataclass

from fastapi import HTTPException, Request, status

from app.domain.types import Role

SESSION_USER_KEY = "user"


@dataclass(frozen=True)
class CurrentUser:
    id: uuid.UUID
    tenant_id: uuid.UUID
    roles: frozenset[Role]


def get_current_user(request: Request) -> CurrentUser:
    data = request.session.get(SESSION_USER_KEY)
    if not isinstance(data, dict):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not logged in")
    return CurrentUser(
        id=uuid.UUID(data["id"]),
        tenant_id=uuid.UUID(data["tenant_id"]),
        roles=frozenset(Role(r) for r in data["roles"]),
    )


def require_roles(*roles: Role) -> Callable[[Request], CurrentUser]:
    """Dependency: the user must have at least one of `roles`."""
    wanted = frozenset(roles)

    def dependency(request: Request) -> CurrentUser:
        user = get_current_user(request)
        if not user.roles & wanted:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Missing role")
        return user

    return dependency

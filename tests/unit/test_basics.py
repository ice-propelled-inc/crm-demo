"""Security helpers, PKCE, prompt defaults, role checks and the liveness probe."""

import httpx
import pytest
from fastapi import Depends, FastAPI, Request
from starlette.middleware.sessions import SessionMiddleware

from app.auth.deps import SESSION_USER_KEY, CurrentUser, require_roles
from app.auth.pkce import code_challenge_s256, new_code_verifier
from app.auth.router import _safe_next
from app.domain.types import Role
from app.main import create_app
from app.prompts.loader import DEFAULT_FUNNEL_STAGES, REQUIRED_KEYS, load_default_prompts
from app.security import decrypt, encrypt, hmac_sha256_signature, verify_hmac_sha256


def test_encrypt_round_trip() -> None:
    token = encrypt("client-secret")
    assert token != "client-secret"
    assert decrypt(token) == "client-secret"


def test_hmac() -> None:
    signature = hmac_sha256_signature("s", b"body")
    assert signature.startswith("sha256=")
    assert verify_hmac_sha256("s", b"body", signature)
    assert not verify_hmac_sha256("s", b"other", signature)
    assert not verify_hmac_sha256("s", b"body", None)


def test_pkce_rfc7636_example() -> None:
    verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
    assert code_challenge_s256(verifier) == "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    assert len(new_code_verifier()) >= 43


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("/admin", "/admin"),
        ("/operator?x=1", "/operator?x=1"),
        ("//evil.test", "/"),
        ("https://evil.test", "/"),
        ("/\\evil.test", "/"),
    ],
)
def test_safe_next(value: str, expected: str) -> None:
    assert _safe_next(value) == expected


@pytest.mark.parametrize("lang", ["en", "fr"])
def test_default_prompts_are_complete(lang: str) -> None:
    prompts = load_default_prompts()
    keys = {key for (language, key) in prompts if language == lang}
    expected = set(REQUIRED_KEYS) | {f"sales_funnel.{s}" for s in DEFAULT_FUNNEL_STAGES}
    assert keys == expected
    assert all(prompts[(lang, k)].strip() for k in keys)


def _roles_app() -> FastAPI:
    app = FastAPI()
    app.add_middleware(SessionMiddleware, secret_key="test-secret")

    @app.get("/login-as/{roles}")
    async def login_as(roles: str, request: Request) -> dict[str, str]:
        request.session[SESSION_USER_KEY] = {
            "id": "00000000-0000-0000-0000-000000000001",
            "tenant_id": "00000000-0000-0000-0000-000000000002",
            "roles": [r for r in roles.split(",") if r != "none"],
        }
        return {}

    @app.get("/admin-only")
    async def admin_only(
        user: CurrentUser = Depends(require_roles(Role.ADMIN)),  # noqa: B008
    ) -> dict[str, list[str]]:
        return {"roles": sorted(user.roles)}

    return app


async def test_require_roles() -> None:
    transport = httpx.ASGITransport(app=_roles_app())
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as client:
        assert (await client.get("/admin-only")).status_code == 401
        await client.get("/login-as/operator")
        assert (await client.get("/admin-only")).status_code == 403
        await client.get("/login-as/admin,operator")
        response = await client.get("/admin-only")
        assert response.json() == {"roles": ["admin", "operator"]}


async def test_healthz() -> None:
    transport = httpx.ASGITransport(app=create_app())
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as client:
        assert (await client.get("/healthz")).json() == {"status": "ok"}

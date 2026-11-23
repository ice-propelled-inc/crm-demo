"""CRM OAuth login through the mock CRM server, with the real database."""

from collections.abc import AsyncIterator
from urllib.parse import parse_qs, urlparse

import httpx
import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.adapters.crm.factory import get_crm_adapter_factory
from app.adapters.crm.generic_http import GenericHttpCRMAdapter
from app.db.models import Operator, Tenant, UrgentManager, User
from app.main import create_app
from app.security import encrypt
from mocks import server as mock_server

pytestmark = pytest.mark.integration


@pytest.fixture
async def tenant(db: AsyncSession) -> Tenant:
    tenant = Tenant(
        name="Test shop",
        crm_base_url="http://mock/crm",
        crm_client_id="dev-client",
        crm_client_secret_enc=encrypt("dev-secret"),
        crm_webhook_secret_enc=encrypt("dev-webhook-secret"),
    )
    db.add(tenant)
    await db.commit()
    return tenant


@pytest.fixture
async def clients() -> AsyncIterator[tuple[httpx.AsyncClient, httpx.AsyncClient]]:
    """(app client, mock CRM client). The app talks to the mock CRM in-process."""
    mock_server.reset()
    mock_http = httpx.AsyncClient(transport=httpx.ASGITransport(app=mock_server.create_mock_app()))

    def factory(tenant: Tenant) -> GenericHttpCRMAdapter:
        return GenericHttpCRMAdapter(
            base_url=tenant.crm_base_url,
            client_id=tenant.crm_client_id,
            client_secret="dev-secret",
            webhook_secret="dev-webhook-secret",
            http=mock_http,
        )

    app = create_app()
    app.dependency_overrides[get_crm_adapter_factory] = lambda: factory
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://localhost:8000") as client:
        yield client, mock_http
    await mock_http.aclose()


async def _login(
    clients: tuple[httpx.AsyncClient, httpx.AsyncClient], tenant: Tenant, login_as: str
) -> httpx.Response:
    app_client, mock_http = clients
    start = await app_client.get(
        "/auth/login", params={"tenant_id": str(tenant.id), "next": "/admin"}
    )
    assert start.status_code == 302
    authorize = await mock_http.get(start.headers["location"] + f"&login_as={login_as}")
    assert authorize.status_code == 302
    callback = urlparse(authorize.headers["location"])
    assert callback.path == "/auth/callback"
    params = {k: v[0] for k, v in parse_qs(callback.query).items()}
    return await app_client.get("/auth/callback", params=params)


async def test_admin_login(
    clients: tuple[httpx.AsyncClient, httpx.AsyncClient], tenant: Tenant
) -> None:
    response = await _login(clients, tenant, "admin-1")
    assert response.status_code == 302
    assert response.headers["location"] == "/admin"
    me = (await clients[0].get("/auth/me")).json()
    assert me["roles"] == ["admin"]
    assert me["tenant_id"] == str(tenant.id)

    assert (await clients[0].post("/auth/logout")).status_code == 204
    assert (await clients[0].get("/auth/me")).status_code == 401


async def test_operator_and_urgent_manager_roles(
    clients: tuple[httpx.AsyncClient, httpx.AsyncClient], tenant: Tenant, db: AsyncSession
) -> None:
    user = User(tenant_id=tenant.id, crm_user_id="operator-1", roles=[])
    db.add(user)
    await db.flush()
    db.add(Operator(tenant_id=tenant.id, user_id=user.id, whatsapp_number="+33600000001"))
    db.add(
        UrgentManager(
            tenant_id=tenant.id,
            user_id=user.id,
            phone_number="+33600000001",
            communication_types=["phone_call"],
        )
    )
    await db.commit()

    response = await _login(clients, tenant, "operator-1")
    assert response.status_code == 302
    me = (await clients[0].get("/auth/me")).json()
    assert me["roles"] == ["operator", "urgent_manager"]
    assert me["id"] == str(user.id)


async def test_user_without_role_is_refused(
    clients: tuple[httpx.AsyncClient, httpx.AsyncClient], tenant: Tenant
) -> None:
    response = await _login(clients, tenant, "manager-1")
    assert response.status_code == 403
    assert (await clients[0].get("/auth/me")).status_code == 401


async def test_wrong_state_is_refused(
    clients: tuple[httpx.AsyncClient, httpx.AsyncClient], tenant: Tenant
) -> None:
    app_client, _ = clients
    await app_client.get("/auth/login", params={"tenant_id": str(tenant.id)})
    response = await app_client.get("/auth/callback", params={"code": "x", "state": "forged"})
    assert response.status_code == 400


async def test_callback_without_login_is_refused(
    clients: tuple[httpx.AsyncClient, httpx.AsyncClient],
) -> None:
    response = await clients[0].get("/auth/callback", params={"code": "x", "state": "y"})
    assert response.status_code == 400


async def test_crm_error_is_bad_gateway(
    clients: tuple[httpx.AsyncClient, httpx.AsyncClient], tenant: Tenant
) -> None:
    app_client, _ = clients
    start = await app_client.get("/auth/login", params={"tenant_id": str(tenant.id)})
    state = parse_qs(urlparse(start.headers["location"]).query)["state"][0]
    response = await app_client.get("/auth/callback", params={"code": "unknown", "state": state})
    assert response.status_code == 502


async def test_unknown_tenant(clients: tuple[httpx.AsyncClient, httpx.AsyncClient]) -> None:
    response = await clients[0].get(
        "/auth/login", params={"tenant_id": "00000000-0000-0000-0000-000000000000"}
    )
    assert response.status_code == 404


async def test_readyz(clients: tuple[httpx.AsyncClient, httpx.AsyncClient]) -> None:
    assert (await clients[0].get("/readyz")).json() == {"status": "ready"}

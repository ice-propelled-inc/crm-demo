"""Command line tools.

python -m app.cli create-tenant --name "Shop" --crm-base-url https://crm.example/api ...
python -m app.cli seed-dev        # tenant for the local mock CRM, with a Jivo channel
"""

import argparse
import asyncio
import json
import sys

from sqlalchemy import select

from app.db.models import Channel, Operator, Tenant, UrgentManager, User
from app.db.session import get_sessionmaker
from app.domain.types import ChannelKind, CommunicationType
from app.security import encrypt

DEV_TENANT_NAME = "Dev shop (mock CRM)"


async def create_tenant(
    name: str, base_url: str, client_id: str, client_secret: str, webhook_secret: str | None
) -> Tenant:
    async with get_sessionmaker()() as session:
        tenant = Tenant(
            name=name,
            crm_base_url=base_url,
            crm_client_id=client_id,
            crm_client_secret_enc=encrypt(client_secret),
            crm_webhook_secret_enc=encrypt(webhook_secret) if webhook_secret else None,
        )
        session.add(tenant)
        await session.commit()
        return tenant


async def seed_dev(mock_base: str) -> dict[str, str]:
    """Idempotent: a tenant that uses the mock servers, one Jivo channel, operators, a manager."""
    async with get_sessionmaker()() as session:
        tenant = await session.scalar(select(Tenant).where(Tenant.name == DEV_TENANT_NAME))
        if tenant is None:
            tenant = Tenant(
                name=DEV_TENANT_NAME,
                crm_base_url=f"{mock_base}/crm",
                crm_client_id="dev-client",
                crm_client_secret_enc=encrypt("dev-secret"),
                crm_webhook_secret_enc=encrypt("dev-webhook-secret"),
            )
            session.add(tenant)
            await session.flush()
            session.add(
                Channel(
                    tenant_id=tenant.id,
                    kind=ChannelKind.JIVO.value,
                    external_id="dev-widget",
                    credentials_enc=encrypt(
                        json.dumps({"provider_id": "dev-provider", "token": "dev-token"})
                    ),
                )
            )
            for crm_id, name, phone in (
                ("operator-1", "Olga Operator", "+33600000001"),
                ("operator-2", "Omar Operator", "+33600000002"),
            ):
                user = User(tenant_id=tenant.id, crm_user_id=crm_id, name=name, roles=[])
                session.add(user)
                await session.flush()
                session.add(Operator(tenant_id=tenant.id, user_id=user.id, whatsapp_number=phone))
            manager = User(
                tenant_id=tenant.id, crm_user_id="manager-1", name="Max Manager", roles=[]
            )
            session.add(manager)
            await session.flush()
            session.add(
                UrgentManager(
                    tenant_id=tenant.id,
                    user_id=manager.id,
                    phone_number="+33600000009",
                    communication_types=[
                        CommunicationType.PHONE_CALL.value,
                        CommunicationType.WHATSAPP_TEXT.value,
                    ],
                )
            )
            await session.commit()
        return {
            "tenant_id": str(tenant.id),
            "admin_login": f"/auth/login?tenant_id={tenant.id}&next=/docs",
            "jivo_webhook": f"/webhooks/jivo/{tenant.id}/dev-token",
        }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="app.cli")
    sub = parser.add_subparsers(dest="command", required=True)
    create = sub.add_parser("create-tenant")
    create.add_argument("--name", required=True)
    create.add_argument("--crm-base-url", required=True)
    create.add_argument("--client-id", required=True)
    create.add_argument("--client-secret", required=True)
    create.add_argument("--webhook-secret")
    seed = sub.add_parser("seed-dev")
    seed.add_argument("--mock-base", default="http://mocks:8090")
    args = parser.parse_args(argv)

    if args.command == "create-tenant":
        tenant = asyncio.run(
            create_tenant(
                args.name,
                args.crm_base_url,
                args.client_id,
                args.client_secret,
                args.webhook_secret,
            )
        )
        print(tenant.id)
    else:
        print(json.dumps(asyncio.run(seed_dev(args.mock_base)), indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())

"""Migrations are reversible and seed the default prompts."""

import asyncio

import pytest
from alembic import command
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from tests.conftest import TEST_DATABASE_URL
from tests.integration.conftest import alembic_config

pytestmark = pytest.mark.integration

EXPECTED_TABLES = {
    "tenants", "tenant_configs", "prompts", "channels", "clients", "conversations",
    "messages", "users", "operators", "urgent_managers", "handoffs", "orders",
    "pending_messages", "catalog_items", "memory_items", "dialog_examples",
    "language_packs", "processed_events", "jobs", "turn_traces",
}  # fmt: skip


async def _inspect() -> tuple[set[str], int]:
    engine = create_async_engine(TEST_DATABASE_URL)
    async with engine.connect() as conn:
        tables = set(
            (
                await conn.execute(
                    text(
                        "SELECT table_name FROM information_schema.tables "
                        "WHERE table_schema = 'public' AND table_name <> 'alembic_version'"
                    )
                )
            ).scalars()
        )
        prompts = 0
        if "prompts" in tables:
            prompts = (
                await conn.execute(text("SELECT count(*) FROM prompts WHERE tenant_id IS NULL"))
            ).scalar_one()
    await engine.dispose()
    return tables, prompts


def test_upgrade_downgrade_upgrade() -> None:
    config = alembic_config()

    tables, prompts = asyncio.run(_inspect())
    assert tables == EXPECTED_TABLES
    assert prompts == 24  # 12 prompts x 2 languages

    command.downgrade(config, "base")
    assert asyncio.run(_inspect()) == (set(), 0)

    command.upgrade(config, "head")
    assert asyncio.run(_inspect()) == (EXPECTED_TABLES, 24)

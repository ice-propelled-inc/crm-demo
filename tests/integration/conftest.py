"""Integration test fixtures: a migrated test database and a clean state for each test."""

from collections.abc import AsyncIterator, Iterator

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Tenant
from app.db.session import get_sessionmaker
from tests.conftest import TEST_DATABASE_URL

pytestmark = pytest.mark.integration


def alembic_config() -> Config:
    config = Config("alembic.ini")
    config.set_main_option("sqlalchemy.url", TEST_DATABASE_URL)
    return config


@pytest.fixture(scope="session", autouse=True)
def migrated_database() -> Iterator[None]:
    """Upgrade to head once. The migration test checks downgrade separately."""
    config = alembic_config()
    command.downgrade(config, "base")
    command.upgrade(config, "head")
    yield


@pytest.fixture
async def db() -> AsyncIterator[AsyncSession]:
    async with get_sessionmaker()() as session:
        yield session
        await session.rollback()
        # Deleting the tenants removes all tenant rows (ON DELETE CASCADE).
        await session.execute(delete(Tenant))
        await session.commit()

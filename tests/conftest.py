"""Shared test setup.

The integration tests use the database in TEST_DATABASE_URL (default: the `chat_test`
database of the docker compose `db` service). The URL is set before the app is imported,
so the app engine also uses it.
"""

import os

TEST_DATABASE_URL = os.environ.setdefault(
    "TEST_DATABASE_URL", "postgresql+asyncpg://chat:chat@localhost:5433/chat_test"
)
os.environ["DATABASE_URL"] = TEST_DATABASE_URL
os.environ.setdefault("PUBLIC_BASE_URL", "http://localhost:8000")

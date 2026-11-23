"""Seed the default harness prompts (tenant_id NULL).

Revision ID: 0002
Revises: 0001
"""

import uuid
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

from app.prompts.loader import load_default_prompts

revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

prompts_table = sa.table(
    "prompts",
    sa.column("id", sa.Uuid()),
    sa.column("tenant_id", sa.Uuid()),
    sa.column("key", sa.String()),
    sa.column("language", sa.String()),
    sa.column("version", sa.Integer()),
    sa.column("body", sa.Text()),
)


def upgrade() -> None:
    rows = [
        {
            "id": uuid.uuid4(),
            "tenant_id": None,
            "key": key,
            "language": language,
            "version": 1,
            "body": body,
        }
        for (language, key), body in load_default_prompts().items()
    ]
    op.bulk_insert(prompts_table, rows)


def downgrade() -> None:
    op.execute(prompts_table.delete().where(prompts_table.c.tenant_id.is_(None)))

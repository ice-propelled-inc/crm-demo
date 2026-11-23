"""turn traces

Revision ID: 0004
Revises: 0003
Create Date: 2026-11-23 22:54:07.692349
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0004"
down_revision: str | None = "0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "turn_traces",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column("conversation_id", sa.Uuid(), nullable=False),
        sa.Column("message_id", sa.Uuid(), nullable=True),
        sa.Column("data", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("clock_timestamp()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["conversation_id"],
            ["conversations.id"],
            name=op.f("fk_turn_traces_conversation_id_conversations"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_turn_traces_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_turn_traces")),
    )
    op.create_index(
        op.f("ix_turn_traces_conversation_id"), "turn_traces", ["conversation_id"], unique=False
    )
    op.create_index(op.f("ix_turn_traces_tenant_id"), "turn_traces", ["tenant_id"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_turn_traces_tenant_id"), table_name="turn_traces")
    op.drop_index(op.f("ix_turn_traces_conversation_id"), table_name="turn_traces")
    op.drop_table("turn_traces")

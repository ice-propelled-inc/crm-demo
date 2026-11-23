"""jobs and handoff fields

Revision ID: 0003
Revises: 0002
Create Date: 2026-11-23 18:17:51.172728
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0003"
down_revision: str | None = "0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "jobs",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column("kind", sa.String(length=40), nullable=False),
        sa.Column("payload", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("run_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("done_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("failed", sa.Boolean(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_jobs_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_jobs")),
    )
    op.create_index(
        "ix_jobs_due", "jobs", ["run_at"], unique=False, postgresql_where="done_at IS NULL"
    )
    op.create_index(op.f("ix_jobs_tenant_id"), "jobs", ["tenant_id"], unique=False)
    op.add_column(
        "conversations", sa.Column("channel_thread_ref", sa.String(length=200), nullable=True)
    )
    op.add_column(
        "conversations",
        sa.Column("pending_confirmation", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )
    op.add_column(
        "handoffs",
        sa.Column("tried_operator_ids", sa.ARRAY(sa.Uuid()), nullable=False, server_default="{}"),
    )
    op.add_column("handoffs", sa.Column("summary", sa.Text(), nullable=True))

    op.alter_column("messages", "created_at", server_default=sa.text("clock_timestamp()"))
    op.alter_column("handoffs", "requested_at", server_default=sa.text("clock_timestamp()"))
    op.alter_column("pending_messages", "created_at", server_default=sa.text("clock_timestamp()"))


def downgrade() -> None:
    op.alter_column("messages", "created_at", server_default=sa.text("now()"))
    op.alter_column("handoffs", "requested_at", server_default=sa.text("now()"))
    op.alter_column("pending_messages", "created_at", server_default=sa.text("now()"))
    op.drop_column("handoffs", "summary")
    op.drop_column("handoffs", "tried_operator_ids")
    op.drop_column("conversations", "pending_confirmation")
    op.drop_column("conversations", "channel_thread_ref")
    op.drop_index(op.f("ix_jobs_tenant_id"), table_name="jobs")
    op.drop_index("ix_jobs_due", table_name="jobs", postgresql_where="done_at IS NULL")
    op.drop_table("jobs")

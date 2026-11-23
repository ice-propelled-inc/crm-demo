"""Tenant configuration (admin panel). Kept as versioned JSON in `tenant_configs`."""

import uuid
from typing import Literal

from pydantic import BaseModel, Field, model_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import TenantConfig
from app.domain.delays import DelayConfig
from app.domain.handoff_rules import DEFAULT_CONFIDENCE_LIMIT
from app.domain.types import RestrictionLevel
from app.prompts.loader import DEFAULT_FUNNEL_STAGES

TONE_PRESETS: dict[str, str] = {
    "formal": "Use a formal, polite tone. Use the formal form of address (for example 'vous').",
    "friendly": "Use a warm, friendly tone. Short sentences. Use emojis rarely.",
    "playful": "Use a light, playful tone with some humour. Stay helpful and clear.",
}

DEFAULT_HARSH_KEYWORDS = [
    "idiot", "stupid", "useless", "damn", "crap", "shit",
    "nul", "débile", "crétin", "merde", "putain",
]  # fmt: skip


class DelaySettings(BaseModel):
    min_delay: float = Field(2.0, ge=0)
    max_delay: float = Field(10.0, ge=0)
    per_char_delay: float = Field(0.03, ge=0)
    max_total_delay: float = Field(30.0, ge=0)

    @model_validator(mode="after")
    def _check_range(self) -> "DelaySettings":
        if self.min_delay > self.max_delay:
            raise ValueError("min_delay must not be more than max_delay")
        return self

    def to_domain(self) -> DelayConfig:
        return DelayConfig(**self.model_dump())


class CatalogSourceSettings(BaseModel):
    type: Literal["crm_catalog", "external_api"] = "crm_catalog"
    url: str | None = None
    field_mapping: dict[str, str] = Field(default_factory=dict)


class TenantSettings(BaseModel):
    business_name: str = "our shop"
    default_language: str = "en"
    restriction_level: RestrictionLevel = RestrictionLevel.MEDIUM
    tone_preset: str = "friendly"
    use_dialog_dataset: bool = True
    delays: DelaySettings = Field(default_factory=DelaySettings)
    confidence_limit: float = Field(DEFAULT_CONFIDENCE_LIMIT, ge=0, le=1)
    harsh_keywords: list[str] = Field(default_factory=lambda: list(DEFAULT_HARSH_KEYWORDS))
    funnel_stages: list[str] = Field(default_factory=lambda: list(DEFAULT_FUNNEL_STAGES))
    operator_accept_timeout_seconds: int = Field(60, ge=10)
    status_check_interval_minutes: int = Field(10, ge=1)
    notification_language: str = "en"
    catalog_source: CatalogSourceSettings = Field(default_factory=CatalogSourceSettings)

    @model_validator(mode="after")
    def _check(self) -> "TenantSettings":
        if self.tone_preset not in TONE_PRESETS:
            raise ValueError(f"tone_preset must be one of {sorted(TONE_PRESETS)}")
        if not self.funnel_stages:
            raise ValueError("funnel_stages must not be empty")
        return self


async def latest_config(session: AsyncSession, tenant_id: uuid.UUID) -> TenantConfig | None:
    result: TenantConfig | None = await session.scalar(
        select(TenantConfig)
        .where(TenantConfig.tenant_id == tenant_id)
        .order_by(TenantConfig.version.desc())
        .limit(1)
    )
    return result


async def load_tenant_settings(session: AsyncSession, tenant_id: uuid.UUID) -> TenantSettings:
    config = await latest_config(session, tenant_id)
    return TenantSettings.model_validate(config.data) if config else TenantSettings()

"""Application settings, read from environment variables (or `.env`)."""

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+asyncpg://chat:chat@localhost:5433/chat"

    llm_provider: str = "mock"
    llm_api_key: str = ""
    llm_model_main: str = "claude-sonnet-5-5"
    llm_model_fast: str = "claude-haiku-5-5"
    embedding_model: str = "mock"

    whatsapp_token: str = ""
    whatsapp_phone_id: str = ""
    whatsapp_app_secret: str = ""
    whatsapp_verify_token: str = ""
    whatsapp_template_name: str = ""

    instagram_app_id: str = ""
    instagram_app_secret: str = ""
    instagram_verify_token: str = ""

    telephony_provider: str = "mock"
    telephony_api_key: str = ""
    telephony_from_number: str = ""

    operator_chat_url: str = "http://localhost:8000/operator"
    public_base_url: str = "http://localhost:8000"

    session_secret_key: str = Field(default="dev-only-change-me", min_length=8)
    # Fernet key for credentials kept in the database. Dev-only default: replace it.
    encryption_key: str = "E-48iBJNo8BIYNveqLydENtVbHjs2rMtzVh4y36bb54="

    log_level: str = "INFO"


@lru_cache
def get_settings() -> Settings:
    return Settings()

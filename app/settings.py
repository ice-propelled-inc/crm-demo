"""Application settings, read from environment variables (or `.env`)."""

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+asyncpg://chat:chat@localhost:5433/chat"

    # "mock" | "openai_compat" (Ollama, Gemini, Groq: free tests). Claude: build step 11.
    llm_provider: str = "mock"
    llm_base_url: str = "http://localhost:11434/v1"
    llm_api_key: str = ""
    llm_model_main: str = "claude-sonnet-5-5"
    llm_model_fast: str = "claude-haiku-5-5"
    llm_timeout_seconds: float = 300.0
    # OpenAI-compatible "reasoning_effort". "none" switches off thinking (Ollama qwen3).
    llm_reasoning_effort: str = ""
    # "mock" | "openai_compat". The model must give 1024 dimensions.
    embedding_provider: str = "mock"
    embedding_base_url: str = "http://localhost:11434/v1"
    embedding_api_key: str = ""
    embedding_model: str = "mxbai-embed-large"

    whatsapp_token: str = ""
    whatsapp_phone_id: str = ""
    whatsapp_app_secret: str = ""
    whatsapp_verify_token: str = ""
    whatsapp_template_name: str = "operator_handoff"
    whatsapp_urgent_template_name: str = "urgent_handoff"
    whatsapp_api_base: str = "https://graph.facebook.com/v21.0"

    instagram_app_id: str = ""
    instagram_app_secret: str = ""
    instagram_verify_token: str = ""
    instagram_api_base: str = "https://graph.instagram.com/v21.0"

    jivo_api_base: str = "https://bot.jivosite.com"

    telephony_provider: str = "mock"
    telephony_account_sid: str = ""
    telephony_api_key: str = ""  # Twilio auth token
    telephony_from_number: str = ""
    telephony_api_base: str = "https://api.twilio.com"

    operator_chat_url: str = "http://localhost:8000/operator"
    public_base_url: str = "http://localhost:8000"
    # Absolute URLs that the login may redirect to (SPA dev servers).
    frontend_origins: list[str] = ["http://localhost:5173", "http://localhost:5174"]

    worker_poll_seconds: float = 1.0
    # Local docker only: the browser URL of the mock CRM (the app uses http://mocks:8090/crm).
    crm_authorize_base_override: str = ""

    session_secret_key: str = Field(default="dev-only-change-me", min_length=8)
    # Fernet key for credentials kept in the database. Dev-only default: replace it.
    encryption_key: str = "E-48iBJNo8BIYNveqLydENtVbHjs2rMtzVh4y36bb54="

    log_level: str = "INFO"


@lru_cache
def get_settings() -> Settings:
    return Settings()

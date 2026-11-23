"""FastAPI app factory."""

from typing import Annotated

from fastapi import Depends, FastAPI, Response, status
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.middleware.sessions import SessionMiddleware

from app.auth.router import router as auth_router
from app.db.session import get_session
from app.settings import get_settings


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(title="AI-chat-helper", version="0.1.0")
    app.add_middleware(
        SessionMiddleware,
        secret_key=settings.session_secret_key,
        session_cookie="aich_session",
        same_site="lax",
        https_only=settings.public_base_url.startswith("https://"),
    )
    app.include_router(auth_router)

    @app.get("/healthz", tags=["ops"])
    async def healthz() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/readyz", tags=["ops"])
    async def readyz(
        response: Response, session: Annotated[AsyncSession, Depends(get_session)]
    ) -> dict[str, str]:
        try:
            await session.execute(text("SELECT 1"))
        except Exception:
            response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
            return {"status": "database unavailable"}
        return {"status": "ready"}

    return app


app = create_app()

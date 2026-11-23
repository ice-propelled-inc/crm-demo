"""FastAPI app factory."""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated

from fastapi import Depends, FastAPI, Response, status
from fastapi.staticfiles import StaticFiles
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.middleware.sessions import SessionMiddleware

from app.admin.router import router as admin_router
from app.admin.test_chat import router as test_chat_router
from app.auth.router import router as auth_router
from app.db.session import get_session
from app.operator.router import router as operator_router
from app.operator.router import ws_router as operator_ws_router
from app.runtime import Deps, build_deps
from app.settings import get_settings
from app.webhooks.router import router as webhooks_router

FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"


def create_app(deps: Deps | None = None) -> FastAPI:
    settings = get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        await app.state.deps.events.start()
        try:
            yield
        finally:
            await app.state.deps.events.stop()

    app = FastAPI(title="AI-chat-helper", version="0.2.0", lifespan=lifespan)
    app.state.deps = deps or build_deps(settings)
    app.add_middleware(
        SessionMiddleware,
        secret_key=settings.session_secret_key,
        session_cookie="aich_session",
        same_site="lax",
        https_only=settings.public_base_url.startswith("https://"),
    )
    app.include_router(auth_router)
    app.include_router(webhooks_router)
    app.include_router(admin_router)
    app.include_router(test_chat_router)
    app.include_router(operator_router)
    app.include_router(operator_ws_router)

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

    # Built SPAs (npm run build) are served by the backend when they exist.
    for name in ("admin", "operator"):
        dist = FRONTEND_DIR / name / "dist"
        if dist.is_dir():
            app.mount(f"/{name}", StaticFiles(directory=dist, html=True), name=f"{name}-spa")

    return app


app = create_app()

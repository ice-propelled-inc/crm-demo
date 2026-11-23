"""Worker process: `python -m app.workers.run`. Runs due jobs in a loop."""

import asyncio
import logging
import time

from app.db.session import get_sessionmaker
from app.runtime import build_deps
from app.settings import get_settings
from app.workers.handlers import ensure_status_polls
from app.workers.jobs import run_due_jobs

logger = logging.getLogger("app.worker")

ENSURE_POLLS_EVERY = 60.0


async def main() -> None:
    settings = get_settings()
    logging.basicConfig(level=settings.log_level)
    deps = build_deps(settings)
    sessionmaker = get_sessionmaker()
    last_ensure = 0.0
    logger.info("Worker started")
    while True:
        if time.monotonic() - last_ensure > ENSURE_POLLS_EVERY:
            async with sessionmaker() as session:
                await ensure_status_polls(session, deps)
            last_ensure = time.monotonic()
        ran = await run_due_jobs(sessionmaker, deps)
        if not ran:
            await asyncio.sleep(settings.worker_poll_seconds)


if __name__ == "__main__":
    asyncio.run(main())

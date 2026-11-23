"""Admin "Test chat": web test channel with a trace of each turn."""

import pytest

from tests.e2e.conftest import World, classified, reply, tool

pytestmark = pytest.mark.integration


async def test_test_chat_shows_reply_and_rule_trace(world: World) -> None:
    admin = await world.login("admin-1")
    client_ref = (await admin.post("/admin/api/test-chat/sessions")).json()["client_ref"]

    empty = (
        await admin.get("/admin/api/test-chat/conversation", params={"client_ref": client_ref})
    ).json()
    assert empty["conversation_id"] is None and empty["messages"] == []

    world.llm.queue(
        classified(topic="small_talk", funnel_stage="greeting"),
        tool("search_catalog", query="pizza"),
        reply("Hi! We have pizza."),
    )
    sent = await admin.post(
        "/admin/api/test-chat/messages", json={"client_ref": client_ref, "text": "hello, pizza?"}
    )
    assert sent.status_code == 202
    queued = (
        await admin.get("/admin/api/test-chat/conversation", params={"client_ref": client_ref})
    ).json()
    assert queued["queued_turns"] == 1

    await world.run_jobs()
    state = (
        await admin.get("/admin/api/test-chat/conversation", params={"client_ref": client_ref})
    ).json()
    assert [(m["sender"], m["body"]) for m in state["messages"]] == [
        ("client", "hello, pizza?"),
        ("ai", "Hi! We have pizza."),
    ]
    assert state["state"] == "AI_ACTIVE" and state["queued_turns"] == 0
    [trace] = state["traces"]
    data = trace["data"]
    assert trace["message_id"] == state["messages"][0]["id"]
    assert data["classification"]["topic"] == "small_talk"
    assert data["restriction"] == {
        "level": "medium",
        "action": "answer_and_steer",
        "off_topic_count": 1,
    }
    assert data["handoff"]["trigger"] is None
    assert data["tools"][0]["name"] == "search_catalog"
    assert "Margherita" in data["tools"][0]["result"]
    assert [c["tier"] for c in data["llm_calls"]] == ["fast", "main", "main"]
    assert data["outcome"] == "reply" and data["reply"] == "Hi! We have pizza."
    assert "Stage: greeting" in data["system_prompt"]
    assert data["delay_seconds"] == 0
    await admin.aclose()


async def test_test_chat_handoff_and_confirmation_trace(world: World) -> None:
    admin = await world.login("admin-1")
    ref = (await admin.post("/admin/api/test-chat/sessions")).json()["client_ref"]

    async def say(text: str) -> dict[str, object]:
        await admin.post("/admin/api/test-chat/messages", json={"client_ref": ref, "text": text})
        await world.run_jobs()
        state: dict[str, object] = (
            await admin.get("/admin/api/test-chat/conversation", params={"client_ref": ref})
        ).json()
        return state

    world.llm.queue(
        classified(), tool("create_order", lines=[{"product_id": "P-2", "quantity": 1}])
    )
    state = await say("one lemonade")
    assert state["pending_confirmation"]["action"] == "create_order"  # type: ignore[index]

    world.llm.queue(classified(confirmation="yes"), reply("Ordered!"))
    state = await say("yes")
    last = state["traces"][-1]["data"]  # type: ignore[index]
    assert last["confirmation"]["executed"] is True
    assert len(state["orders"]) == 1  # type: ignore[arg-type]

    world.llm.queue(classified(asks_for_human=True, harsh_sentiment=True), reply("Angry client."))
    state = await say("useless bot, a human now")
    assert state["state"] == "HANDOFF_PENDING"
    assert state["handoff"]["trigger"] == "harsh_words"  # type: ignore[index]
    assert state["traces"][-1]["data"]["outcome"] == "handoff"  # type: ignore[index]
    await admin.aclose()


async def test_test_chat_needs_admin_and_known_client(world: World) -> None:
    olga = await world.login("operator-1")
    assert (await olga.post("/admin/api/test-chat/sessions")).status_code == 403
    admin = await world.login("admin-1")
    missing = await admin.get("/admin/api/test-chat/conversation", params={"client_ref": "nobody"})
    assert missing.status_code == 404
    await olga.aclose()
    await admin.aclose()


async def test_real_channels_keep_no_trace(world: World) -> None:
    from sqlalchemy import func, select

    from app.db.models import TurnTrace
    from app.db.session import get_sessionmaker

    world.llm.queue(classified(), reply("Hello"))
    await world.jivo("hi")
    async with get_sessionmaker()() as session:
        assert await session.scalar(select(func.count()).select_from(TurnTrace)) == 0

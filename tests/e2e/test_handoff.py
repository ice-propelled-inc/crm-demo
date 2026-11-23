"""Handoff, operator chat API, urgent alerts and tenant isolation."""

import uuid

import pytest
from sqlalchemy import select

from app.db.models import Channel, Handoff, MemoryItem, Operator, User
from app.db.session import get_sessionmaker
from app.domain.types import ConversationState
from app.security import encrypt
from tests.e2e.conftest import World, add_people, classified, create_tenant, reply

pytestmark = pytest.mark.integration


async def _ask_human_twice(world: World) -> None:
    world.llm.queue(classified(asks_for_human=True), reply("I can help you too. What do you need?"))
    await world.jivo("can I talk to a person?")
    assert (await world.conversation()).state == ConversationState.AI_ACTIVE
    world.llm.queue(classified(asks_for_human=True), reply("Client wants a human about an order."))
    await world.jivo("a person please")


async def _handoff(world: World) -> Handoff:
    async with get_sessionmaker()() as session:
        handoff = await session.scalar(select(Handoff).order_by(Handoff.requested_at.desc()))
        assert handoff is not None
        return handoff


async def test_full_handoff_cycle(world: World) -> None:
    await _ask_human_twice(world)
    conversation = await world.conversation()
    assert conversation.state == ConversationState.HANDOFF_PENDING
    assert "colleague" in (await world.jivo_texts())[-1]  # escalation prompt

    [notification] = await world.recorded("whatsapp")
    template = notification["body"]["template"]
    assert notification["body"]["to"] == "33600000001"
    assert template["name"] == "operator_handoff"
    link = template["components"][0]["parameters"][0]["text"]
    assert link.endswith(f"#/conversations/{conversation.id}")

    handoff = await _handoff(world)
    assert handoff.trigger == "human_requested_twice"
    assert handoff.summary == "Client wants a human about an order."

    olga = await world.login("operator-1")
    accepted = await olga.post(f"/operator/api/handoffs/{handoff.id}/accept")
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["mine"] is True
    assert (await world.conversation()).state == ConversationState.HANDOFF_ACTIVE

    # The client writes: no LLM call, the operator sees it.
    calls = len(world.llm.requests)
    await world.jivo("is anybody there?")
    assert len(world.llm.requests) == calls
    detail = (await olga.get(f"/operator/api/conversations/{conversation.id}")).json()
    assert detail["messages"][-1]["body"] == "is anybody there?"
    assert detail["handoffs"][0]["summary"] == "Client wants a human about an order."

    sent = await olga.post(
        f"/operator/api/conversations/{conversation.id}/messages", json={"text": "Hi, I am Olga."}
    )
    assert sent.json() == {"status": "sent"}
    assert (await world.jivo_texts())[-1] == "Hi, I am Olga."

    back = await olga.post(
        f"/operator/api/conversations/{conversation.id}/messages", json={"text": "/out-to-AI"}
    )
    assert back.json() == {"status": "returned_to_ai"}
    assert (await world.conversation()).state == ConversationState.AI_ACTIVE
    async with get_sessionmaker()() as session:
        [memory] = (await session.scalars(select(MemoryItem))).all()
        assert "Hi, I am Olga." in memory.content
        assert memory.embedding is not None

    world.llm.queue(classified(), reply("I am back. How can I help?"))
    await world.jivo("thanks")
    assert (await world.jivo_texts())[-1] == "I am back. How can I help?"
    assert "Hi, I am Olga." in world.llm.requests[-1].system  # memory of the handoff

    log = (await olga.get("/operator/api/handoffs")).json()
    assert log[0]["status"] == "closed"
    await olga.aclose()


async def test_harsh_words_start_handoff_at_once(world: World) -> None:
    world.llm.queue(classified(asks_for_human=True), reply("Angry client."))
    await world.jivo("this bot is useless, give me a human")
    assert (await world.conversation()).state == ConversationState.HANDOFF_PENDING
    assert (await _handoff(world)).trigger == "harsh_words"


async def test_low_confidence_starts_handoff(world: World) -> None:
    world.llm.queue(classified(confidence=0.3), reply("Unclear request."))
    await world.jivo("my thing from last year with the blue box")
    assert (await _handoff(world)).trigger == "low_confidence"


async def test_model_can_request_human(world: World) -> None:
    from tests.e2e.conftest import tool

    world.llm.queue(classified(), tool("request_human", reason="refund"), reply("Refund request."))
    await world.jivo("I want a refund for a broken item")
    assert (await world.conversation()).state == ConversationState.HANDOFF_PENDING


async def test_status_change_during_handoff_goes_to_operator_only(world: World) -> None:
    from tests.e2e.test_conversation import _create_order

    order_id = await _create_order(world)
    await _ask_human_twice(world)
    sent_before = len(await world.jivo_texts())
    await world.crm_status(order_id, "paid")
    calls = len(world.llm.requests)
    await world.run_jobs()
    assert len(await world.jivo_texts()) == sent_before
    assert len(world.llm.requests) == calls
    olga = await world.login("operator-1")
    detail = (
        await olga.get(f"/operator/api/conversations/{(await world.conversation()).id}")
    ).json()
    assert detail["messages"][-1] == {**detail["messages"][-1], "sender": "system"}
    assert "new status paid" in detail["messages"][-1]["body"]
    await olga.aclose()


async def test_no_operator_accepts_urgent_alerts_and_ai_continues(world: World) -> None:
    await _ask_human_twice(world)
    handoff = await _handoff(world)

    world.clock.advance(61)
    await world.run_jobs()
    notified = [r["body"]["to"] for r in await world.recorded("whatsapp")]
    assert notified == ["33600000001", "33600000002"]

    world.clock.advance(61)
    await world.run_jobs()
    [call] = await world.recorded("twilio")
    assert call["body"]["To"] == "+33600000009"
    assert "unhandled order conversations" in call["body"]["Twiml"]
    urgent = (await world.recorded("whatsapp"))[-1]["body"]
    assert urgent["template"]["name"] == "urgent_handoff"
    assert (await world.conversation()).state == ConversationState.AI_ACTIVE

    async with get_sessionmaker()() as session:
        handoff_row = await session.get_one(Handoff, handoff.id)
        kinds = [a["type"] for a in handoff_row.alerts]
        assert kinds == [
            "accept_timeout",
            "accept_timeout",
            "urgent_phone_call",
            "urgent_whatsapp_text",
        ]
        assert handoff_row.status == "no_operator"

    # The first operator is too late now.
    olga = await world.login("operator-1")
    assert (await olga.post(f"/operator/api/handoffs/{handoff.id}/accept")).status_code == 409
    await olga.aclose()

    world.llm.queue(classified(), reply("Sorry for the wait, I can help."))
    await world.jivo("hello?")
    assert (await world.jivo_texts())[-1] == "Sorry for the wait, I can help."


async def test_unavailable_operator_is_skipped(world: World) -> None:
    olga = await world.login("operator-1")
    assert (await olga.put("/operator/api/me/availability", json={"is_available": False})).json()[
        "is_available"
    ] is False
    await _ask_human_twice(world)
    assert [r["body"]["to"] for r in await world.recorded("whatsapp")] == ["33600000002"]
    await olga.aclose()


async def test_only_assigned_operator_can_accept_and_write(world: World) -> None:
    await _ask_human_twice(world)
    handoff = await _handoff(world)
    omar = await world.login("operator-2")
    assert (await omar.post(f"/operator/api/handoffs/{handoff.id}/accept")).status_code == 409
    response = await omar.post(
        f"/operator/api/conversations/{handoff.conversation_id}/messages", json={"text": "hi"}
    )
    assert response.status_code == 409
    await omar.aclose()


async def test_operator_of_other_tenant_sees_nothing(world: World) -> None:
    await _ask_human_twice(world)
    handoff = await _handoff(world)

    async with get_sessionmaker()() as session:
        other = await create_tenant(session, "Other shop")
        session.add(
            Channel(tenant_id=other.id, kind="jivo", external_id="w", credentials_enc=encrypt("{}"))
        )
        await add_people(session, other)
        await session.commit()
        other_id = other.id

    original = world.tenant_id
    world.tenant_id = other_id
    stranger = await world.login("operator-1")  # same CRM user ID, other tenant
    world.tenant_id = original

    assert (
        await stranger.get(f"/operator/api/conversations/{handoff.conversation_id}")
    ).status_code == 404
    assert (await stranger.post(f"/operator/api/handoffs/{handoff.id}/accept")).status_code == 404
    assert (await stranger.get("/operator/api/conversations", params={"scope": "all"})).json() == []
    assert (await stranger.get("/operator/api/handoffs")).json() == []
    await stranger.aclose()


async def test_operator_api_needs_operator_role(world: World) -> None:
    admin = await world.login("admin-1")
    assert (await admin.get("/operator/api/conversations")).status_code == 403
    assert (await world.app_client.get("/operator/api/conversations")).status_code == 401
    await admin.aclose()


async def test_conversation_lists(world: World) -> None:
    world.llm.queue(classified(), reply("Hello!"))
    await world.jivo("hi", client_id="c9", chat_id="chat-9")
    await _ask_human_twice(world)
    olga = await world.login("operator-1")
    active = (await olga.get("/operator/api/conversations")).json()
    assert [c["state"] for c in active] == ["HANDOFF_PENDING"]
    assert active[0]["handoff"]["mine"] is True
    everything = (await olga.get("/operator/api/conversations", params={"scope": "all"})).json()
    assert len(everything) == 2
    me = (await olga.get("/operator/api/me")).json()
    assert me["roles"] == ["operator"]
    assert (await olga.get("/operator/api/stats")).json() == {"active_handoffs": 1}
    await olga.aclose()


async def test_operator_user_row_has_role(world: World) -> None:
    olga = await world.login("operator-1")
    async with get_sessionmaker()() as session:
        user = await session.scalar(
            select(User).where(User.tenant_id == world.tenant_id, User.crm_user_id == "operator-1")
        )
        assert user is not None and user.roles == ["operator"]
        assert await session.scalar(select(Operator).where(Operator.user_id == user.id))
    await olga.aclose()
    assert uuid.UUID(str(world.tenant_id))

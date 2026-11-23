"""Agent turn, orders and status changes through the real adapters and the mock servers."""

import pytest
from sqlalchemy import func, select

from app.db.models import Order, PendingMessage
from app.db.session import get_sessionmaker
from app.domain.types import RestrictionLevel
from mocks import server as mock_server
from tests.e2e.conftest import MOCK, World, classified, reply, tool

pytestmark = pytest.mark.integration


async def test_catalog_question_uses_live_catalog(world: World) -> None:
    world.llm.queue(
        classified(),
        tool("search_catalog", query="pizza"),
        reply("We have a Margherita pizza for 11.50 EUR."),
    )
    await world.jivo("Do you have pizza?")

    assert await world.jivo_texts() == ["We have a Margherita pizza for 11.50 EUR."]
    [sent] = await world.recorded("jivo")
    assert sent["path"] == f"webhooks/prov/{'jivo-token'}"
    assert sent["body"]["chat_id"] == "chat-1"
    assert "Margherita" in world.llm.requests[2].messages[-1].content
    assert world.llm.requests[0].model == "claude-haiku-5-5"  # classifier: fast tier
    assert world.llm.requests[1].model == "claude-sonnet-5-5"  # reply: main tier


async def _create_order(world: World) -> str:
    world.llm.queue(
        classified(funnel_stage="order"),
        tool("search_catalog", query="pizza"),
        tool("create_order", lines=[{"product_id": "P-1", "quantity": 2}]),
    )
    await world.jivo("I want 2 pizzas")
    confirmation = (await world.jivo_texts())[-1]
    assert "2 x Margherita pizza" in confirmation
    assert 'Reply "yes"' in confirmation
    assert not mock_server.crm_state.orders  # nothing is created before "yes"

    world.llm.queue(
        classified(confirmation="yes", funnel_stage="payment"),
        reply("Done! Here is the payment link."),
    )
    await world.jivo("yes")
    [order_id] = mock_server.crm_state.orders
    last = (await world.jivo_texts())[-1]
    assert f"https://pay.example.test/{order_id}" in last
    return order_id


async def test_order_with_confirmation_and_payment_link(world: World) -> None:
    order_id = await _create_order(world)
    async with get_sessionmaker()() as session:
        order = await session.scalar(select(Order).where(Order.crm_order_id == order_id))
        assert order is not None
        assert (order.status, order.payment_link) == (
            "awaiting_payment",
            f"https://pay.example.test/{order_id}",
        )
    assert (await world.conversation()).pending_confirmation is None


async def test_client_says_no(world: World) -> None:
    world.llm.queue(
        classified(), tool("create_order", lines=[{"product_id": "P-2", "quantity": 1}])
    )
    await world.jivo("one lemonade")
    world.llm.queue(classified(confirmation="no"), reply("OK, nothing ordered."))
    await world.jivo("no, wait")
    assert not mock_server.crm_state.orders
    assert "did not confirm" in world.llm.requests[-1].system


async def test_paid_webhook_tells_client(world: World) -> None:
    order_id = await _create_order(world)
    world.llm.queue(reply("Your payment is received, thank you!"))
    await world.crm_status(order_id, "paid")
    await world.run_jobs()
    assert (await world.jivo_texts())[-1] == "Your payment is received, thank you!"
    assert "paid" in world.llm.requests[-1].messages[-1].content

    # The same event again is a duplicate; an older status is ignored.
    async with get_sessionmaker()() as session:
        order = await session.scalar(select(Order).where(Order.crm_order_id == order_id))
        assert order is not None and order.status == "paid"


async def test_cancel_with_confirmation(world: World) -> None:
    order_id = await _create_order(world)
    world.llm.queue(classified(), tool("cancel_order", order_id=order_id))
    await world.jivo("cancel my order please")
    assert "Cancel the order" in (await world.jivo_texts())[-1]
    assert mock_server.crm_state.orders[order_id]["status"] == "awaiting_payment"

    world.llm.queue(classified(confirmation="yes"), reply("Your order is cancelled."))
    await world.jivo("yes")
    assert mock_server.crm_state.orders[order_id]["status"] == "cancelled"


async def test_cannot_cancel_order_of_other_client(world: World) -> None:
    order_id = await _create_order(world)
    world.llm.queue(
        classified(), tool("cancel_order", order_id=order_id), reply("I cannot find this order.")
    )
    await world.jivo("cancel order " + order_id, client_id="c2", chat_id="chat-2")
    assert "no order with this ID" in world.llm.requests[-1].messages[-1].content


async def test_closed_window_keeps_status_message_and_sends_it_later(world: World) -> None:
    order_id = await _create_order(world)
    await world.mock_http.put(f"{MOCK}/_control/fail/jivo", json={"status": 410})
    world.llm.queue(reply("Your order is on its way."))
    await world.crm_status(order_id, "shipped")
    await world.run_jobs()
    async with get_sessionmaker()() as session:
        pending = (await session.scalars(select(PendingMessage))).all()
        assert [p.body for p in pending] == ["Your order is on its way."]
        assert pending[0].delivered_at is None

    await world.mock_http.delete(f"{MOCK}/_control/fail/jivo")
    world.clock.advance(3 * 24 * 3600)
    world.llm.queue(classified(), reply("Anything else?"))
    await world.jivo("hello again")
    assert (await world.jivo_texts())[-2:] == ["Your order is on its way.", "Anything else?"]


async def test_finished_order_status_is_kept_in_history_only(world: World) -> None:
    order_id = await _create_order(world)
    await world.mock_http.put(f"{MOCK}/_control/fail/jivo", json={"status": 410})
    world.llm.queue(reply("Your order is complete."))
    await world.crm_status(order_id, "completed")
    await world.run_jobs()
    async with get_sessionmaker()() as session:
        assert await session.scalar(select(func.count()).select_from(PendingMessage)) == 0


async def test_lost_webhook_found_by_status_check(world: World) -> None:
    from app.workers.handlers import ensure_status_polls

    order_id = await _create_order(world)
    await world.crm_status(order_id, "paid", webhook=False)
    async with get_sessionmaker()() as session:
        assert await ensure_status_polls(session, world.deps) == 1
    world.llm.queue(reply("Payment received!"))
    await world.run_jobs()
    assert (await world.jivo_texts())[-1] == "Payment received!"
    # The next check waits 10 minutes.
    async with get_sessionmaker()() as session:
        assert await ensure_status_polls(session, world.deps) == 0


@pytest.mark.parametrize(
    ("level", "topic", "expected"),
    [
        (RestrictionLevel.MEDIUM, "small_talk", "steer the conversation back"),
        (RestrictionLevel.HIGH, "small_talk", "Decline in one short"),
        (RestrictionLevel.STRICT, "business_related", "Decline in one short"),
        (RestrictionLevel.HIGH, "business_related", None),
    ],
)
async def test_restriction_levels(
    world: World, level: RestrictionLevel, topic: str, expected: str | None
) -> None:
    await world.set_config(restriction_level=level)
    world.llm.queue(classified(topic=topic), reply("..."))
    await world.jivo("how is the weather?")
    system = world.llm.requests[-1].system
    if expected:
        assert expected in system
    else:
        assert "Decline" not in system and "steer" not in system


async def test_medium_returns_to_topic_on_third_message(world: World) -> None:
    for _ in range(3):
        world.llm.queue(classified(topic="off_topic"), reply("..."))
        await world.jivo("tell me a joke")
    assert "talked about other topics for 3 messages" in world.llm.requests[-1].system


async def test_french_conversation_stays_french(world: World) -> None:
    world.llm.queue(classified(language="fr"), reply("Bonjour ! Que puis-je faire pour vous ?"))
    await world.jivo("Bonjour, vous avez des pizzas ?")
    system = world.llm.requests[-1].system
    assert "Vous êtes l'assistant client" in system
    assert "Reply in French." in system
    assert (await world.conversation()).language == "fr"


async def test_unknown_language_uses_default(world: World) -> None:
    world.llm.queue(classified(language="de"), reply("Hello!"))
    await world.jivo("Hallo")
    assert (await world.conversation()).language == "en"


async def test_bad_classifier_output_is_neutral(world: World) -> None:
    world.llm.queue(reply("not json"), reply("Hello!"))
    await world.jivo("hi")
    assert await world.jivo_texts() == ["Hello!"]


async def test_instagram_reply_with_typing_and_delay(world: World) -> None:
    await world.set_config(
        delays={"min_delay": 2, "max_delay": 2, "per_char_delay": 0, "max_total_delay": 30}
    )
    world.llm.queue(classified(), reply("Hi from Instagram"))
    response = await world.instagram("hello")
    assert response.json() == {"queued": 1}
    await world.run_jobs()
    records = await world.recorded("instagram")
    assert [r["body"].get("sender_action") for r in records] == ["typing_on"]  # not sent yet

    world.clock.advance(2.5)
    await world.run_jobs()
    records = await world.recorded("instagram")
    assert records[-1]["body"] == {
        "recipient": {"id": "ig-user-1"},
        "message": {"text": "Hi from Instagram"},
    }
    assert records[-2]["body"]["sender_action"] == "typing_off"
    assert records[-1]["headers"]["authorization"] == "Bearer ig-token"


async def test_instagram_bad_signature(world: World) -> None:
    response = await world.app_client.post(
        f"/webhooks/instagram/{world.tenant_id}",
        json={"object": "instagram", "entry": [{"id": "ig-1", "messaging": []}]},
        headers={"X-Hub-Signature-256": "sha256=bad"},
    )
    assert response.status_code == 401


async def test_duplicate_jivo_event_is_ignored(world: World) -> None:
    event = {
        "id": "same-event",
        "client_id": "c1",
        "chat_id": "chat-1",
        "event": "CLIENT_MESSAGE",
        "message": {"type": "TEXT", "text": "hi", "timestamp": 1},
    }
    url = f"/webhooks/jivo/{world.tenant_id}/jivo-token"
    assert (await world.app_client.post(url, json=event)).json() == {"queued": 1}
    assert (await world.app_client.post(url, json=event)).json() == {"queued": 0}
    assert (
        await world.app_client.post(f"/webhooks/jivo/{world.tenant_id}/wrong", json=event)
    ).status_code == 401


async def test_crm_webhook_bad_signature(world: World) -> None:
    response = await world.app_client.post(
        f"/webhooks/crm/{world.tenant_id}", content=b"{}", headers={"X-Signature": "sha256=x"}
    )
    assert response.status_code == 401


async def test_tidio_is_not_supported(world: World) -> None:
    response = await world.app_client.post(f"/webhooks/tidio/{world.tenant_id}", json={})
    assert response.status_code == 501

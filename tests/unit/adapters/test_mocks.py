"""The in-process mocks behave as the tests of later steps expect."""

import json
import math
from datetime import UTC, datetime

import pytest

from app.adapters.catalog.crm_catalog import CrmCatalogSource
from app.adapters.catalog.mock import MockCatalogSource
from app.adapters.channels.base import InvalidChannelWebhook
from app.adapters.channels.mock import MockChannelAdapter
from app.adapters.crm.base import (
    CatalogEntry,
    CRMError,
    CrmUser,
    InvalidWebhookSignature,
    OrderLine,
)
from app.adapters.crm.mock import MockCRMAdapter
from app.adapters.embeddings.mock import MockEmbeddingProvider
from app.adapters.llm.base import ChatMessage, LLMRequest, LLMResponse, ToolCall
from app.adapters.llm.mock import MockLLMProvider, ScriptExhaustedError
from app.adapters.telephony.base import URGENT_CALL_TEXT, TelephonyError
from app.adapters.telephony.mock import MockTelephonyClient
from app.adapters.whatsapp.base import WhatsAppError
from app.adapters.whatsapp.mock import MockWhatsAppClient
from app.db.models import EMBEDDING_DIM
from app.domain.types import OrderStatus


async def test_crm_mock_orders_and_login() -> None:
    user = CrmUser("u1", "U", None, is_admin=True)
    crm = MockCRMAdapter(users={"code-1": user})
    assert "state=s" in crm.authorization_url(state="s", redirect_uri="r", code_challenge="c")
    tokens = await crm.exchange_code(code="code-1", redirect_uri="r", code_verifier="v")
    assert await crm.get_current_user(tokens.access_token) == user
    with pytest.raises(CRMError):
        await crm.exchange_code(code="bad", redirect_uri="r", code_verifier="v")
    with pytest.raises(CRMError):
        await crm.get_current_user("bad")

    order = await crm.create_order(client_ref="c1", lines=[OrderLine("P-1", 1)])
    assert order.payment_link == f"https://pay.mock/{order.crm_order_id}"
    assert (await crm.get_order_status(order.crm_order_id)).status is OrderStatus.AWAITING_PAYMENT
    assert (await crm.cancel_order(order.crm_order_id)).status is OrderStatus.CANCELLED
    with pytest.raises(CRMError):
        await crm.cancel_order("nope")


def test_crm_mock_webhook() -> None:
    crm = MockCRMAdapter()
    body = json.dumps(
        {"event_id": "e", "order_id": "O", "status": "paid", "changed_at": "2026-11-23T10:00:00"}
    ).encode()
    assert crm.parse_webhook({"x-signature": "mock-secret"}, body).status is OrderStatus.PAID
    with pytest.raises(InvalidWebhookSignature):
        crm.parse_webhook({}, body)


async def test_catalog_sources() -> None:
    entry = CatalogEntry("P-1", "Pizza")
    crm = MockCRMAdapter(catalog=[entry])
    assert await CrmCatalogSource(crm).fetch() == [entry]
    assert await MockCatalogSource([entry]).fetch() == [entry]


async def test_channel_mock_closed_window() -> None:
    channel = MockChannelAdapter(closed_clients={"c2"})
    assert (await channel.send_message("c1", "hi", human_agent=True)).delivered
    result = await channel.send_message("c2", "hi")
    assert not result.delivered
    assert result.reason == "window_closed"
    assert [(m.client_ref, m.human_agent) for m in channel.sent] == [("c1", True)]
    await channel.set_typing("c1", True)
    assert channel.typing == [("c1", True)]


def test_channel_mock_webhook() -> None:
    channel = MockChannelAdapter()
    body = json.dumps(
        {
            "client_ref": "c1",
            "text": "Bonjour",
            "message_id": "m1",
            "received_at": datetime(2026, 11, 23, tzinfo=UTC).isoformat(),
        }
    ).encode()
    [message] = channel.parse_webhook({}, body)
    assert (message.client_ref, message.text, message.display_name) == ("c1", "Bonjour", None)
    with pytest.raises(InvalidChannelWebhook):
        channel.parse_webhook({}, b"{}")


async def test_whatsapp_mock() -> None:
    wa = MockWhatsAppClient(failing_numbers={"+2"})
    message_id = await wa.send_template(
        to="+1", template_name="handoff", language="en", parameters=["link"]
    )
    assert message_id.startswith("wamid.")
    assert wa.sent[0].parameters == ["link"]
    with pytest.raises(WhatsAppError):
        await wa.send_template(to="+2", template_name="handoff", language="en", parameters=[])


async def test_telephony_mock() -> None:
    phone = MockTelephonyClient(failing_numbers={"+2"})
    await phone.call_with_tts(to="+1", text=URGENT_CALL_TEXT)
    assert phone.calls[0].text.startswith("Hello. You have unhandled order conversations")
    with pytest.raises(TelephonyError):
        await phone.call_with_tts(to="+2", text="x")


async def test_llm_mock_is_scripted() -> None:
    llm = MockLLMProvider()
    call = ToolCall("t1", "search_catalog", {"query": "pizza"})
    llm.queue(LLMResponse(text="", tool_calls=(call,), stop_reason="tool_use"))
    request = LLMRequest(model="m", system="s", messages=[ChatMessage("user", "pizza?")])
    response = await llm.complete(request)
    assert response.tool_calls == (call,)
    assert llm.requests == [request]
    with pytest.raises(ScriptExhaustedError):
        await llm.complete(request)


async def test_embedding_mock_is_deterministic_unit_vector() -> None:
    embedder = MockEmbeddingProvider()
    a1, a2, b = await embedder.embed(["pizza", "pizza", "lemonade"])
    assert a1 == a2
    assert a1 != b
    assert len(a1) == EMBEDDING_DIM
    assert math.isclose(sum(v * v for v in a1), 1.0, rel_tol=1e-9)

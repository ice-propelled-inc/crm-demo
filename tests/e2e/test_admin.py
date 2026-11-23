"""Admin API: setup only, admin role, tenant scope."""

import pytest
from sqlalchemy import func, select

from app.db.models import Client, DialogExample, MemoryItem, Message, Order
from app.db.session import get_sessionmaker
from tests.e2e.conftest import World, classified, reply

pytestmark = pytest.mark.integration


async def test_admin_role_is_required(world: World) -> None:
    olga = await world.login("operator-1")
    assert (await olga.get("/admin/api/config")).status_code == 403
    assert (await world.app_client.get("/admin/api/config")).status_code == 401
    await olga.aclose()


async def test_config_versions_and_validation(world: World) -> None:
    admin = await world.login("admin-1")
    current = (await admin.get("/admin/api/config")).json()
    assert current["settings"]["restriction_level"] == "medium"
    assert current["tone_presets"] == ["formal", "friendly", "playful"]

    new = {**current["settings"], "restriction_level": "strict", "business_name": "Pizza Roma"}
    saved = (await admin.put("/admin/api/config", json=new)).json()
    assert saved["version"] == current["version"] + 1
    versions = (await admin.get("/admin/api/config/versions")).json()
    assert versions[0]["version"] == saved["version"]

    bad = {**new, "delays": {**new["delays"], "min_delay": 50, "max_delay": 10}}
    assert (await admin.put("/admin/api/config", json=bad)).status_code == 422
    assert (
        await admin.put("/admin/api/config", json={**new, "tone_preset": "rude"})
    ).status_code == 422

    world.llm.queue(classified(), reply("Ciao!"))
    await world.jivo("hello")
    assert "Pizza Roma" in world.llm.requests[-1].system
    await admin.aclose()


async def test_prompt_override(world: World) -> None:
    admin = await world.login("admin-1")
    prompts = (await admin.get("/admin/api/prompts")).json()
    assert len(prompts) == 24 and {p["source"] for p in prompts} == {"default"}
    saved = await admin.put(
        "/admin/api/prompts/escalation/en", json={"body": "One moment, a human is coming."}
    )
    assert saved.json()["version"] == 1
    prompts = (await admin.get("/admin/api/prompts")).json()
    escalation = next(p for p in prompts if p["key"] == "escalation" and p["language"] == "en")
    assert escalation["source"] == "tenant"

    world.llm.queue(classified(confidence=0.1), reply("summary"))
    await world.jivo("???")
    assert (await world.jivo_texts())[-1] == "One moment, a human is coming."
    await admin.aclose()


async def test_operators_and_urgent_managers(world: World) -> None:
    admin = await world.login("admin-1")
    operators = (await admin.get("/admin/api/operators")).json()
    assert [o["crm_user_id"] for o in operators] == ["operator-1", "operator-2"]

    added = await admin.post(
        "/admin/api/operators",
        json={"crm_user_id": "new-op", "name": "Nina", "whatsapp_number": "+33611111111"},
    )
    assert added.status_code == 201
    duplicate = await admin.post(
        "/admin/api/operators", json={"crm_user_id": "new-op", "whatsapp_number": "+33611111111"}
    )
    assert duplicate.status_code == 409
    assert (
        await admin.post(
            "/admin/api/operators", json={"crm_user_id": "x", "whatsapp_number": "abc"}
        )
    ).status_code == 422
    assert (await admin.delete(f"/admin/api/operators/{added.json()['id']}")).status_code == 204
    assert (await admin.delete(f"/admin/api/operators/{added.json()['id']}")).status_code == 404

    manager = await admin.post(
        "/admin/api/urgent-managers",
        json={
            "crm_user_id": "boss",
            "phone_number": "+33622222222",
            "communication_types": ["phone_call"],
        },
    )
    assert manager.json()["communication_types"] == ["phone_call"]
    managers = (await admin.get("/admin/api/urgent-managers")).json()
    assert {m["crm_user_id"] for m in managers} == {"manager-1", "boss"}
    assert (
        await admin.post(
            "/admin/api/urgent-managers",
            json={"crm_user_id": "x", "phone_number": "+33622222222", "communication_types": []},
        )
    ).status_code == 422
    assert (
        await admin.delete(f"/admin/api/urgent-managers/{manager.json()['id']}")
    ).status_code == 204
    await admin.aclose()


async def test_channels_and_crm_connection(world: World) -> None:
    admin = await world.login("admin-1")
    channels = (await admin.get("/admin/api/channels")).json()
    assert {c["kind"] for c in channels} == {"jivo", "instagram"}
    assert all("access_token" not in str(c) or "credential_keys" in c for c in channels)

    added = await admin.post(
        "/admin/api/channels",
        json={"kind": "jivo", "external_id": "widget-2", "credentials": {"provider_id": "p2"}},
    )
    assert added.status_code == 201
    body = added.json()
    assert body["credential_keys"] == ["provider_id", "token"]  # token generated
    assert body["webhook_url"].startswith(f"http://localhost:8000/webhooks/jivo/{world.tenant_id}/")
    assert (
        await admin.post("/admin/api/channels", json={"kind": "jivo", "external_id": "w3"})
    ).status_code == 422
    assert (
        await admin.post("/admin/api/channels", json={"kind": "tidio", "external_id": "t"})
    ).status_code == 422
    patched = await admin.patch(f"/admin/api/channels/{body['id']}", json={"enabled": False})
    assert patched.json()["enabled"] is False
    assert (await admin.delete(f"/admin/api/channels/{body['id']}")).status_code == 204

    crm = (await admin.get("/admin/api/crm-connection")).json()
    assert crm["has_client_secret"] is True
    assert crm["webhook_url"] == f"http://localhost:8000/webhooks/crm/{world.tenant_id}"
    updated = await admin.put(
        "/admin/api/crm-connection", json={"base_url": "http://mock/crm", "client_id": "dev-client"}
    )
    assert updated.json()["has_client_secret"] is True  # not changed without a new secret
    await admin.aclose()


async def test_language_packs_and_dialog_dataset(world: World) -> None:
    admin = await world.login("admin-1")
    pack = await admin.post("/admin/api/language-packs", json={"language": "de", "name": "Deutsch"})
    assert pack.status_code == 201
    uploaded = await admin.post(
        "/admin/api/dialog-examples",
        json={
            "examples": [
                {"language": "de", "tone_tag": "friendly", "content": "Kunde: Hallo\nBot: Hallo!"},
                {
                    "language": "en",
                    "tone_tag": "friendly",
                    "content": "Client: Hi\nBot: Hey there!",
                },
            ]
        },
    )
    assert uploaded.json() == {"added": 2}
    groups = (await admin.get("/admin/api/dialog-examples")).json()
    assert {(g["language"], g["count"]) for g in groups} == {("de", 1), ("en", 1)}

    world.llm.queue(classified(language="de"), reply("Hallo!"))
    await world.jivo("Hallo")
    assert (await world.conversation()).language == "de"  # the pack enables German
    assert "Kunde: Hallo" in world.llm.requests[-1].system  # few-shot example

    assert (
        await admin.delete("/admin/api/dialog-examples", params={"language": "de"})
    ).status_code == 204
    async with get_sessionmaker()() as session:
        assert await session.scalar(select(func.count()).select_from(DialogExample)) == 1
    assert (await admin.delete(f"/admin/api/language-packs/{pack.json()['id']}")).status_code == 204
    await admin.aclose()


async def test_delete_all_client_data(world: World) -> None:
    from tests.e2e.test_conversation import _create_order

    await _create_order(world)
    admin = await world.login("admin-1")
    [found] = (await admin.get("/admin/api/clients", params={"search": "Ali"})).json()
    assert found["display_name"] == "Alice"
    assert (await admin.delete(f"/admin/api/clients/{found['id']}")).status_code == 204
    async with get_sessionmaker()() as session:
        for model in (Client, Message, Order, MemoryItem):
            assert await session.scalar(select(func.count()).select_from(model)) == 0
    assert (await admin.delete(f"/admin/api/clients/{found['id']}")).status_code == 404
    await admin.aclose()

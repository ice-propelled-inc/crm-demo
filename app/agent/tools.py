"""Tools of the main model. Create and cancel go through the confirmation gate."""

import json
import uuid
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.adapters.crm.base import CRMAdapter, CRMError
from app.adapters.llm.base import ToolSpec
from app.agent.memory import embed_one, search_catalog
from app.db.models import Conversation, Order
from app.domain.orders import OrderAction, PendingConfirmation
from app.runtime import Deps

TOOLS = [
    ToolSpec(
        "search_catalog",
        "Search the catalog of products and services. Use it before you name a product or price.",
        {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]},
    ),
    ToolSpec(
        "create_order",
        "Create an order. The system asks the client to confirm before the order is created.",
        {
            "type": "object",
            "properties": {
                "lines": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "product_id": {"type": "string"},
                            "quantity": {"type": "integer", "minimum": 1},
                        },
                        "required": ["product_id", "quantity"],
                    },
                    "minItems": 1,
                }
            },
            "required": ["lines"],
        },
    ),
    ToolSpec(
        "get_order_status",
        "Get the current status of the orders of this client.",
        {"type": "object", "properties": {}},
    ),
    ToolSpec(
        "cancel_order",
        "Cancel an order of this client. The system asks the client to confirm first.",
        {
            "type": "object",
            "properties": {"order_id": {"type": "string"}},
            "required": ["order_id"],
        },
    ),
    ToolSpec(
        "request_human",
        "Ask for a human operator when you cannot help the client.",
        {"type": "object", "properties": {"reason": {"type": "string"}}},
    ),
]


@dataclass
class ToolContext:
    session: AsyncSession
    deps: Deps
    crm: CRMAdapter
    conversation: Conversation
    # Set by a tool to stop the loop:
    confirmation: PendingConfirmation | None = None
    human_requested: bool = False
    product_names: dict[str, str] = field(default_factory=dict)


async def run_tool(ctx: ToolContext, name: str, arguments: dict[str, Any]) -> str:
    try:
        if name == "search_catalog":
            return await _search_catalog(ctx, str(arguments.get("query", "")))
        if name == "create_order":
            return await _create_order(ctx, arguments.get("lines") or [])
        if name == "get_order_status":
            return await _order_status(ctx)
        if name == "cancel_order":
            return await _cancel_order(ctx, str(arguments.get("order_id", "")))
        if name == "request_human":
            ctx.human_requested = True
            return json.dumps({"status": "handoff_started"})
    except CRMError as exc:
        return json.dumps({"error": f"CRM error: {exc}"})
    return json.dumps({"error": f"unknown tool {name}"})


async def _search_catalog(ctx: ToolContext, query: str) -> str:
    vector = await embed_one(ctx.deps, query)
    items = await search_catalog(ctx.session, ctx.conversation.tenant_id, query, vector)
    if items:
        found = [
            {
                "product_id": i.external_id,
                "name": i.name,
                "description": i.description,
                "price": str(i.price) if i.price is not None else None,
                "currency": i.currency,
            }
            for i in items
        ]
    else:  # the catalog cache is empty: ask the CRM
        words = [w.casefold() for w in query.split() if len(w) > 2]
        found = [
            {
                "product_id": e.external_id,
                "name": e.name,
                "description": e.description,
                "price": str(e.price) if e.price is not None else None,
                "currency": e.currency,
            }
            for e in await ctx.crm.get_catalog()
            if not words or any(w in f"{e.name} {e.description or ''}".casefold() for w in words)
        ][:5]
    for item in found:
        ctx.product_names[str(item["product_id"])] = str(item["name"])
    return json.dumps({"items": found}, ensure_ascii=False)


async def _create_order(ctx: ToolContext, lines: list[dict[str, Any]]) -> str:
    clean: list[dict[str, Any]] = [
        {"product_id": str(ln["product_id"]), "quantity": int(ln["quantity"])}
        for ln in lines
        if ln.get("product_id") and int(ln.get("quantity", 0)) > 0
    ]
    if not clean:
        return json.dumps({"error": "the order has no valid lines"})
    summary = "\n".join(
        f"- {ln['quantity']} x {ctx.product_names.get(ln['product_id'], ln['product_id'])}"
        for ln in clean
    )
    ctx.confirmation = PendingConfirmation(OrderAction.CREATE, summary, {"lines": clean})
    return json.dumps({"status": "confirmation_required"})


async def _client_orders(ctx: ToolContext) -> list[Order]:
    return list(
        (
            await ctx.session.scalars(
                select(Order)
                .where(
                    Order.tenant_id == ctx.conversation.tenant_id,
                    Order.client_id == ctx.conversation.client_id,
                )
                .order_by(Order.created_at.desc())
                .limit(5)
            )
        ).all()
    )


async def _order_status(ctx: ToolContext) -> str:
    result = []
    for order in await _client_orders(ctx):
        state = await ctx.crm.get_order_status(order.crm_order_id)
        result.append({"order_id": order.crm_order_id, "status": state.status.value})
    return json.dumps({"orders": result})


async def _cancel_order(ctx: ToolContext, order_id: str) -> str:
    own = {o.crm_order_id for o in await _client_orders(ctx)}
    if order_id not in own:
        return json.dumps({"error": "this client has no order with this ID"})
    ctx.confirmation = PendingConfirmation(
        OrderAction.CANCEL, f"Cancel the order {order_id}", {"order_id": order_id}
    )
    return json.dumps({"status": "confirmation_required"})


def tool_call_id() -> str:
    return f"call_{uuid.uuid4().hex[:12]}"

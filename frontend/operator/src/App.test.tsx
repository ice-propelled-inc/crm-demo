import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import App from "./App";

const HANDOFF = {
  id: "h-1",
  conversation_id: "c-1",
  trigger: "human_requested_twice",
  status: "active",
  operator_id: "o-1",
  operator_name: "Olga",
  mine: true,
  summary: "Client wants a refund.",
  alerts: [],
  requested_at: "2026-11-23T10:00:00Z",
  accepted_at: "2026-11-23T10:00:30Z",
  closed_at: null,
};
const ITEM = {
  id: "c-1",
  client_name: "Alice",
  channel: "jivo",
  state: "HANDOFF_ACTIVE",
  language: "en",
  last_message: "hello?",
  last_message_at: "2026-11-23T10:01:00Z",
  handoff: HANDOFF,
};
const DETAIL = {
  ...ITEM,
  messages: [{ id: "m-1", sender: "client", body: "hello?", created_at: "2026-11-23T10:01:00Z" }],
  orders: [{ crm_order_id: "ORD-1", status: "paid", payment_link: null, created_at: "2026-11-23T09:00:00Z" }],
  handoffs: [HANDOFF],
};

const posts: { url: string; body: unknown }[] = [];

function respond(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status }));
}

beforeEach(() => {
  posts.length = 0;
  window.history.replaceState(null, "", "/operator/?tenant=t-1#/conversations/c-1");
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body ?? "null"));
        posts.push({ url, body });
        return respond({ status: body?.text === "/out-to-AI" ? "returned_to_ai" : "sent" });
      }
      if (url.startsWith("/operator/api/conversations?")) return respond([ITEM]);
      if (url === "/operator/api/conversations/c-1") return respond(DETAIL);
      if (url === "/operator/api/me") {
        return respond({ user_id: "u-1", roles: ["operator"], operator_id: "o-1", is_available: true });
      }
      if (url === "/operator/api/handoffs") return respond([HANDOFF]);
      return respond({});
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("shows the conversation with the summary and sends a reply", async () => {
  render(<App />);
  expect(await screen.findByText("Client wants a refund.")).toBeDefined();
  expect(screen.getAllByText("hello?").length).toBeGreaterThan(0);

  fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Hi, I am Olga." } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(posts).toHaveLength(1));
  expect(posts[0]).toEqual({ url: "/operator/api/conversations/c-1/messages", body: { text: "Hi, I am Olga." } });

  fireEvent.click(screen.getByRole("button", { name: "Give back to AI" }));
  await waitFor(() => expect(posts).toHaveLength(2));
  expect(posts[1].body).toEqual({ text: "/out-to-AI" });
});

test("shows the handoff log", async () => {
  window.history.replaceState(null, "", "/operator/?tenant=t-1#/handoffs");
  render(<App />);
  expect(await screen.findByText("human_requested_twice")).toBeDefined();
  expect(screen.getByText("Olga")).toBeDefined();
});

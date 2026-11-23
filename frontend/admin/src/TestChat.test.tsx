import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { TestChatSection } from "./sections/TestChat";

const STATE = {
  client_ref: "tester-1",
  conversation_id: "c-1",
  state: "AI_ACTIVE",
  language: "en",
  funnel_stage: "offer",
  human_request_count: 0,
  off_topic_count: 1,
  pending_confirmation: null,
  messages: [
    { id: "m-1", sender: "client", body: "pizza?", created_at: "2026-11-23T10:00:00Z" },
    { id: "m-2", sender: "ai", body: "We have Margherita.", created_at: "2026-11-23T10:00:05Z" },
  ],
  traces: [
    {
      id: "t-1",
      message_id: "m-1",
      created_at: "2026-11-23T10:00:04Z",
      data: {
        outcome: "reply",
        reply: "We have Margherita.",
        seconds: 3.2,
        delay_seconds: 2.5,
        classification: { topic: "small_talk", confidence: 0.9 },
        handoff: { trigger: null, human_request_count: 0, confidence_limit: 0.6 },
        restriction: { level: "medium", action: "answer_and_steer", off_topic_count: 1 },
        tools: [{ name: "search_catalog", arguments: { query: "pizza" }, result: "{\"items\": []}" }],
        llm_calls: [{ tier: "fast", model: "qwen3:8b", seconds: 1.1, input_tokens: 10, output_tokens: 5, tool_calls: [] }],
        system_prompt: "You are the client assistant",
      },
    },
  ],
  handoff: null,
  orders: [],
  queued_turns: 0,
  thinking_since: null,
  typing_until: null,
  oldest_waiting_job_seconds: null,
};

const posts: { url: string; body: unknown }[] = [];

beforeEach(() => {
  posts.length = 0;
  vi.stubGlobal("localStorage", { getItem: () => "tester-1", setItem: () => undefined });
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        posts.push({ url, body: init.body ? JSON.parse(String(init.body)) : null });
        const body = url.endsWith("/sessions") ? { client_ref: "tester-2" } : { queued: true };
        return Promise.resolve(new Response(JSON.stringify(body), { status: url.endsWith("/sessions") ? 201 : 202 }));
      }
      return Promise.resolve(new Response(JSON.stringify(STATE), { status: 200 }));
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("shows the chat and the decisions of the turn", async () => {
  render(<TestChatSection />);
  expect(await screen.findByText("pizza?")).toBeDefined();
  expect(screen.getByText("medium → answer_and_steer")).toBeDefined();
  expect(screen.getByText(/search_catalog/)).toBeDefined();
  expect(screen.getByText("qwen3:8b")).toBeDefined();

  fireEvent.change(screen.getByLabelText("Client message"), { target: { value: "2 please" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(posts.some((p) => p.url === "/admin/api/test-chat/messages")).toBe(true));
  expect(posts.find((p) => p.url.endsWith("/messages"))?.body).toEqual({ client_ref: "tester-1", text: "2 please" });
});

test("new conversation makes a new test client", async () => {
  render(<TestChatSection />);
  await screen.findByText("pizza?");
  fireEvent.click(screen.getByRole("button", { name: "New conversation" }));
  await waitFor(() => expect(posts.some((p) => p.url === "/admin/api/test-chat/sessions")).toBe(true));
});

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import App from "./App";

const CONFIG = {
  version: 3,
  tone_presets: ["formal", "friendly", "playful"],
  settings: {
    business_name: "Pizza Roma",
    default_language: "en",
    restriction_level: "medium",
    tone_preset: "friendly",
    use_dialog_dataset: true,
    delays: { min_delay: 2, max_delay: 10, per_char_delay: 0.03, max_total_delay: 30 },
    confidence_limit: 0.6,
    harsh_keywords: ["idiot"],
    funnel_stages: ["greeting", "offer"],
    operator_accept_timeout_seconds: 60,
    status_check_interval_minutes: 10,
    notification_language: "en",
    catalog_source: { type: "crm_catalog", url: null, field_mapping: {} },
  },
};

const calls: { url: string; init?: RequestInit }[] = [];

function respond(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status }));
}

beforeEach(() => {
  calls.length = 0;
  window.history.replaceState(null, "", "/admin/?tenant=t-1");
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === "/admin/api/config" && init?.method === "PUT") {
        return respond({ ...CONFIG, version: 4, settings: JSON.parse(String(init.body)) });
      }
      if (url === "/admin/api/config") return respond(CONFIG);
      if (url === "/admin/api/operators") return respond([]);
      return respond([]);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("loads the settings and saves a new version", async () => {
  render(<App />);
  const name = await screen.findByLabelText("Business name");
  expect((name as HTMLInputElement).value).toBe("Pizza Roma");

  fireEvent.change(name, { target: { value: "Pizza Napoli" } });
  fireEvent.change(screen.getByLabelText("Topic restriction"), { target: { value: "strict" } });
  fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

  await screen.findByText("Saved as version 4.");
  const put = calls.find((c) => c.init?.method === "PUT");
  const sent = JSON.parse(String(put?.init?.body));
  expect(sent.business_name).toBe("Pizza Napoli");
  expect(sent.restriction_level).toBe("strict");
  expect(sent.delays.max_total_delay).toBe(30);
});

test("without a tenant ID the login uses the only tenant", async () => {
  const assign = vi.fn();
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
  vi.stubGlobal("location", { ...window.location, href: "http://localhost:5173/admin/", search: "", assign });
  vi.stubGlobal("fetch", vi.fn(() => respond({ detail: "Not logged in" }, 401)));
  render(<App />);
  await waitFor(() => expect(assign).toHaveBeenCalled());
  expect(String(assign.mock.calls[0][0])).toMatch(/^\/auth\/login\?next=/);
});

test("a 401 sends the user to the CRM login", async () => {
  const assign = vi.fn();
  vi.stubGlobal("location", { ...window.location, href: "http://localhost:5173/admin/?tenant=t-1", search: "?tenant=t-1", assign });
  vi.stubGlobal("fetch", vi.fn(() => respond({ detail: "Not logged in" }, 401)));
  render(<App />);
  await waitFor(() => expect(assign).toHaveBeenCalled());
  expect(String(assign.mock.calls[0][0])).toMatch(/^\/auth\/login\?tenant_id=t-1&next=/);
});

test("opens the operators section", async () => {
  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "Operators" }));
  expect(await screen.findByRole("button", { name: "Add operator" })).toBeDefined();
});

test("a user without the admin role sees the switch-user banner", async () => {
  vi.stubGlobal("fetch", vi.fn(() => respond({ detail: "Missing role" }, 403)));
  render(<App />);
  expect(await screen.findByRole("alert")).toBeDefined();
  expect(screen.getByRole("button", { name: "Log in as another user" })).toBeDefined();
});

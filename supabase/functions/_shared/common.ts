// deno-lint-ignore-file no-explicit-any
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

export function env(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Missing secret ${name}`);
  return v;
}

// Service-role client: bypasses RLS. Use only inside Edge Functions.
export const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false },
});

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-admin-pin",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

// Optional shared PIN for the functions the page calls (softphone token, Deepgram key, observer).
export function pinError(req: Request): Response | null {
  const pin = Deno.env.get("ADMIN_PIN");
  if (!pin || req.headers.get("x-admin-pin") === pin) return null;
  return json({ error: "Invalid admin PIN" }, 401);
}

export async function systemMessage(callId: string, text: string) {
  await db.from("call_messages").insert({ call_id: callId, speaker: "system", text });
}

export const digits = (phone?: string | null) => (phone || "").replace(/\D/g, "").slice(-10);

// agent-config.json and schedule.json are read from the published page, so the repo stays the single source.
let cache: { at: number; config: any; schedule: any } | null = null;
export async function loadConfig(): Promise<{ config: any; schedule: any }> {
  if (cache && Date.now() - cache.at < 60_000) return cache;
  const base = env("PAGES_BASE_URL").replace(/\/$/, "");
  const get = async (f: string) => {
    const r = await fetch(`${base}/${f}`);
    if (!r.ok) throw new Error(`Cannot load ${f}: HTTP ${r.status}`);
    return r.json();
  };
  const [config, schedule] = await Promise.all([get("agent-config.json"), get("schedule.json")]);
  cache = { at: Date.now(), config, schedule };
  return cache;
}

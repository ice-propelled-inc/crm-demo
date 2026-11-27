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
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-admin-pin, x-client-info",
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

// Business set id: "dental" (docs/ root) or a folder in docs/crm-demo-local/businesses.
export const normBiz = (b?: string | null) => (b && /^[a-z0-9_-]{1,32}$/.test(b) ? b : "dental");

export async function callBusiness(callId?: string | null): Promise<string> {
  if (!callId) return "dental";
  const { data } = await db.from("calls").select("business").eq("id", callId).maybeSingle();
  return normBiz(data?.business);
}

// Clinic data: the business_data row edited on the page; without a row, the seed files published with the page.
const cache = new Map<string, { at: number; config: any; schedule: any }>();
export function dropConfigCache(business: string) { cache.delete(normBiz(business)); }

export async function seedConfig(business = "dental"): Promise<{ config: any; schedule: any }> {
  const biz = normBiz(business);
  const base = env("PAGES_BASE_URL").replace(/\/$/, "");
  const sets = (Deno.env.get("BUSINESSES_PATH") || "crm-demo-local/businesses").replace(/^\/|\/$/g, "");
  const dir = biz === "dental" ? base : `${base}/${sets}/${biz}`;
  const get = async (f: string) => {
    const r = await fetch(`${dir}/${f}`);
    if (!r.ok) throw new Error(`Cannot load ${biz}/${f}: HTTP ${r.status}`);
    return r.json();
  };
  const [config, schedule] = await Promise.all([get("agent-config.json"), get("schedule.json")]);
  return { config, schedule };
}

export async function loadConfig(business = "dental"): Promise<{ config: any; schedule: any }> {
  const biz = normBiz(business);
  const hit = cache.get(biz);
  if (hit && Date.now() - hit.at < 15_000) return hit;
  const { data: row } = await db.from("business_data").select("config,schedule").eq("business", biz).maybeSingle();
  const { config, schedule } = row ?? await seedConfig(biz);
  // The other sets use generic key names; the code uses the dental ones.
  config.clinic = config.clinic || config.business;
  schedule.doctors = schedule.doctors || schedule.resources;
  schedule.clinic_hours = schedule.clinic_hours || schedule.business_hours;
  const entry = { at: Date.now(), config, schedule };
  cache.set(biz, entry);
  return entry;
}

// Operation mode, administrator availability and notifications: business_settings row over agent-config.json "settings".
export type Settings = { operation_mode: string; admin_availability: string; notifications: any };
export async function loadSettings(business = "dental"): Promise<Settings> {
  const biz = normBiz(business);
  const { config } = await loadConfig(biz);
  const d = config.settings || {};
  const { data } = await db.from("business_settings").select("*").eq("business", biz).maybeSingle();
  const notifications = { channel: "off", events: {}, ...(d.notifications || {}), ...(data?.notifications || {}) };
  notifications.events = { ...(d.notifications?.events || {}), ...(data?.notifications?.events || {}) };
  return {
    operation_mode: data?.operation_mode || d.operation_mode || "overflow",
    admin_availability: data?.admin_availability || d.admin_availability || "available",
    notifications,
  };
}

// Who takes a new call or chat first: "admin" (ring / wait for the administrator) or "ai" (the AI at once).
export const firstResponder = (s: Settings) =>
  s.operation_mode === "autonomous" || (s.operation_mode === "overflow" && s.admin_availability !== "available") ? "ai" : "admin";

// A handoff can reach the administrator live only while Available.
export const canHandOff = (s: Settings) => s.admin_availability === "available";

export const loadConfigForCall = async (callId?: string | null) => loadConfig(await callBusiness(callId));

// Call-state field that names the doctor / technician / courier (agent-config.json labels.resource_field).
export const resourceField = (config: any): string => config.labels?.resource_field || "doctor";

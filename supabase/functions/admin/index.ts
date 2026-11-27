// deno-lint-ignore-file no-explicit-any
// Administrator actions from the page (POST JSON, admin PIN):
//   settings    { business, operation_mode?, admin_availability?, notifications? }  save the AI assistant settings
//   data        { business, config, schedule }  save clinic data, rebuild the prompt and push it to Vapi
//   reset-data  { business }                    back to the seed files published with the page
//   task        { id, status }                  change a task status
//   chat-join   { call_id }                     the administrator takes over a chat
//   chat-reply  { call_id, text }               the administrator writes in a chat; the observer updates the live page
//   reminders   { business? }                   send due reminders (call it from pg_cron every 15 minutes)
import { CORS, db, dropConfigCache, json, loadConfig, normBiz, pinError, seedConfig, systemMessage } from "../_shared/common.ts";
import { pushToVapi } from "../_shared/prompt.ts";
import { observe } from "../_shared/observer.ts";
import { sendDueReminders } from "../_shared/notify.ts";

const MODES = ["copilot", "overflow", "autonomous"];
const AVAILABILITY = ["available", "busy", "offline"];
const TASK_STATUSES = ["pending", "acknowledged", "resolved", "declined"];

function checkData(config: any, schedule: any): string | null {
  if (!config || typeof config !== "object" || !schedule || typeof schedule !== "object") return "config and schedule are required";
  if (!(config.clinic || config.business)?.name) return "The name is required";
  for (const k of ["services", "appointment_fields", "script", "tools", "funnel_stages"]) {
    if (!Array.isArray(config[k])) return `config.${k} must be a list`;
  }
  if (!Array.isArray(config.knowledge_base?.faq)) return "config.knowledge_base.faq must be a list";
  if (!Array.isArray(schedule.doctors || schedule.resources)) return "schedule.doctors must be a list";
  return null;
}

async function joinChat(callId: string) {
  const { data } = await db.from("calls").select("mode,channel,status").eq("id", callId).single();
  if (data?.channel !== "chat" || data.status === "ended" || data.mode === "admin") return;
  await db.from("calls").update({ status: "active", mode: "admin" }).eq("id", callId);
  await systemMessage(callId, data.mode === "transferring" ? "Administrator joined the chat." : "Administrator replied. The AI assistant shows intake and suggestions.");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const denied = pinError(req);
  if (denied) return denied;

  try {
    const body = await req.json();
    const business = normBiz(body.business);
    switch (body.action) {
      case "settings": {
        const row: Record<string, any> = { business, updated_at: new Date().toISOString() };
        if (body.operation_mode !== undefined) {
          if (!MODES.includes(body.operation_mode)) return json({ error: "Unknown operation mode" }, 400);
          row.operation_mode = body.operation_mode;
        }
        if (body.admin_availability !== undefined) {
          if (!AVAILABILITY.includes(body.admin_availability)) return json({ error: "Unknown availability" }, 400);
          row.admin_availability = body.admin_availability;
        }
        if (body.notifications !== undefined) row.notifications = body.notifications;
        const { data, error } = await db.from("business_settings").upsert(row).select().single();
        if (error) throw new Error(error.message);
        return json({ ok: true, settings: data });
      }

      case "data": {
        const bad = checkData(body.config, body.schedule);
        if (bad) return json({ error: bad }, 400);
        const { error } = await db.from("business_data")
          .upsert({ business, config: body.config, schedule: body.schedule, updated_at: new Date().toISOString() });
        if (error) throw new Error(error.message);
        dropConfigCache(business);
        const { config, schedule } = await loadConfig(business);
        const vapi = await pushToVapi(business, config, schedule).catch((e) => `failed: ${(e as Error).message}`);
        return json({ ok: true, vapi });
      }

      case "reset-data": {
        await db.from("business_data").delete().eq("business", business);
        dropConfigCache(business);
        const { config, schedule } = await seedConfig(business);
        config.clinic = config.clinic || config.business;
        schedule.doctors = schedule.doctors || schedule.resources;
        const vapi = await pushToVapi(business, config, schedule).catch((e) => `failed: ${(e as Error).message}`);
        return json({ ok: true, vapi });
      }

      case "task": {
        if (!TASK_STATUSES.includes(body.status)) return json({ error: "Unknown task status" }, 400);
        const { data, error } = await db.from("tasks").update({ status: body.status }).eq("id", body.id).select().single();
        if (error) throw new Error(error.message);
        return json({ ok: true, task: data });
      }

      case "chat-join":
        await joinChat(body.call_id);
        return json({ ok: true });

      case "chat-reply": {
        if (!body.call_id || !body.text) return json({ error: "call_id and text are required" }, 400);
        await joinChat(body.call_id);
        await db.from("call_messages").insert({ call_id: body.call_id, speaker: "admin", text: String(body.text) });
        const out = await observe(body.call_id).catch((e) => ({ error: (e as Error).message }));
        return json({ ok: true, ...out });
      }

      case "reminders": {
        const list = body.business
          ? [business]
          : ["dental", ...((await db.from("business_settings").select("business")).data || []).map((r: any) => r.business)];
        let sent = 0;
        for (const b of new Set(list)) sent += await sendDueReminders(b);
        return json({ ok: true, sent });
      }
    }
    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: (e as Error).message }, 500);
  }
});

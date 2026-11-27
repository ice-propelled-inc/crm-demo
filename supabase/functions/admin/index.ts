// deno-lint-ignore-file no-explicit-any
// Administrator actions from the page (POST JSON, admin PIN):
//   settings    { business, operation_mode?, admin_availability?, notifications? }  save the AI assistant settings
//   data        { business, config, schedule }  save clinic data, rebuild the prompt and push it to Vapi
//   reset-data  { business }                    back to the seed files published with the page
//   task        { id, status }                  change a task status
//   chat-join   { call_id }                     the administrator takes over a chat
//   takeover    { call_id }                     the administrator takes a call or chat over from the AI
//   chat-reply  { call_id, text }               the administrator writes in a chat; the observer updates the live page
//   reminders   { business? }                   send due reminders (call it from pg_cron every 15 minutes)
import { CORS, db, dropConfigCache, env, json, loadConfig, normBiz, pinError, seedConfig, systemMessage } from "../_shared/common.ts";
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

// The administrator takes a conversation over from the AI assistant.
//   chat              the AI stops replying, the administrator writes
//   Twilio call       the live call is redirected to twilio-voice?step=takeover, which rings the admin softphone
//   fake caller page  stage "handoff" in call_state makes the page stop Vapi and ring the administrator
async function takeOver(callId: string): Promise<Record<string, unknown>> {
  if (!callId) throw new Error("call_id is required");
  const { data: call } = await db.from("calls").select("mode,status,channel,twilio_call_sid").eq("id", callId).single();
  if (!call || call.status === "ended") throw new Error("The conversation has ended");
  if (call.channel === "chat") {
    await joinChat(callId);
    return { ok: true, message: "You are in the chat. The AI assistant stopped replying." };
  }
  if (call.mode === "admin") return { ok: true, message: "You are already on the call" };
  if (call.mode !== "ai") throw new Error("The AI assistant is not on the call");
  const sid = call.twilio_call_sid || "";
  if (/^CA[0-9a-f]{32}$/i.test(sid)) {
    const account = env("TWILIO_ACCOUNT_SID");
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${account}/Calls/${sid}.json`, {
      method: "POST",
      headers: { Authorization: `Basic ${btoa(`${account}:${env("TWILIO_AUTH_TOKEN")}`)}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        Url: `${env("FUNCTIONS_PUBLIC_URL").replace(/\/$/, "")}/twilio-voice?step=takeover&call_id=${callId}`, Method: "POST",
      }),
    });
    if (!r.ok) throw new Error(`Twilio: ${(await r.json().catch(() => ({}))).message || r.status}`);
  } else if (sid) {
    throw new Error("Take over works for Twilio calls and the fake caller. Telnyx calls are not supported yet.");
  } else {
    const { data: st } = await db.from("call_state").select("call_id").eq("call_id", callId).maybeSingle();
    const { error } = st
      ? await db.from("call_state").update({ stage: "handoff", updated_at: new Date().toISOString() }).eq("call_id", callId)
      : await db.from("call_state").insert({ call_id: callId, fields: {}, stage: "handoff" });
    if (error) throw new Error(error.message);
  }
  await systemMessage(callId, "Administrator is taking over the call");
  return { ok: true, message: "Taking over: your softphone answers in a moment" };
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

      case "takeover":
        return json(await takeOver(body.call_id));

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

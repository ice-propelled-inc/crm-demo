// deno-lint-ignore-file no-explicit-any
// Web chat (docs/.../chat.html). Same rules, data and tools as the phone assistant; the operation mode decides
// who replies first. The chat page reads its messages over Realtime (call_messages of its call_id).
//   start   { business }        -> { call_id, mode, wait_sec }  "ringing" = waiting for the administrator
//   message { call_id, text }   -> { mode }                     the visitor writes; the AI replies when it leads
//   timeout { call_id }         -> { mode }                     nobody replied in time: the AI takes over, or the
//                                                                 handoff failed (callback task)
//   end     { call_id }
import { canHandOff, CORS, db, firstResponder, json, loadConfig, loadConfigForCall, loadSettings, normBiz, systemMessage } from "../_shared/common.ts";
import { agentPrompt, llmTools } from "../_shared/prompt.ts";
import { askLlm, observe } from "../_shared/observer.ts";
import { callbackTask, ensureDraft, runTool } from "../_shared/tools.ts";
import { nowInTz } from "../_shared/schedule.ts";

async function markEnded(callId: string, outcome?: string) {
  const { data: call } = await db.from("calls").select("status,outcome").eq("id", callId).single();
  if (call?.status === "ended") return;
  const { data: appt } = await db.from("appointments").select("id").eq("call_id", callId).eq("status", "filled").limit(1);
  await db.from("calls").update({
    status: "ended", ended_at: new Date().toISOString(),
    outcome: outcome ?? call?.outcome ?? (appt?.length ? "booked" : null),
  }).eq("id", callId);
  await systemMessage(callId, "Chat ended");
}

// The administrator could not take over: apology, Draft, callback task.
async function handoffFailed(callId: string, config: any) {
  await ensureDraft(callId);
  await callbackTask(callId);
  await db.from("calls").update({ mode: "ai" }).eq("id", callId);
  await db.from("call_messages").insert({ call_id: callId, speaker: "ai", text: config.handoff.admin_no_answer.say });
}

// One AI turn: the whole chat history, the agent tools, up to 6 tool rounds, then the reply.
async function aiTurn(callId: string) {
  const { data: call } = await db.from("calls").select("business").eq("id", callId).single();
  const business = normBiz(call?.business);
  const { config, schedule } = await loadConfig(business);
  const now = nowInTz(config.clinic.timezone);
  const { data: msgs } = await db.from("call_messages").select("speaker,text").eq("call_id", callId)
    .neq("speaker", "system").order("created_at").limit(60);
  const messages: any[] = [
    { role: "system", content: agentPrompt(config, schedule, "chat", `${now.weekday}, ${now.date}`) },
    ...(msgs || []).map((m: any) => m.speaker === "caller"
      ? { role: "user", content: m.text }
      : { role: "assistant", content: m.speaker === "admin" ? `(Administrator) ${m.text}` : m.text }),
  ];
  if (!msgs?.length) messages.push({ role: "user", content: "(The visitor opened the chat.)" });

  for (let round = 0; round < 6; round++) {
    const msg = await askLlm(messages, { tools: llmTools(config, "chat"), temperature: 0.3 });
    const calls = msg.tool_calls || [];
    if (!calls.length) {
      if (msg.content) await db.from("call_messages").insert({ call_id: callId, speaker: "ai", text: msg.content });
      return;
    }
    messages.push(msg);
    for (const tc of calls) {
      let result: any;
      try {
        const args = JSON.parse(tc.function.arguments || "{}");
        if (tc.function.name === "transfer_to_admin") {
          if (canHandOff(await loadSettings(business))) {
            await db.from("calls").update({ mode: "transferring" }).eq("id", callId);
            await systemMessage(callId, "Inviting the administrator to the chat");
            result = { ok: true, status: "The administrator is invited. Tell the visitor to wait a moment." };
          } else {
            await ensureDraft(callId);
            await callbackTask(callId);
            result = { error: `The administrator is not available. Say: "${config.handoff.admin_no_answer.say}" A callback task was created.` };
          }
        } else {
          result = await runTool(tc.function.name, args, callId);
        }
      } catch (e) {
        result = { error: (e as Error).message };
      }
      messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(result) });
    }
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  try {
    const { action, call_id: callId, text, business } = await req.json();
    if (action === "start") {
      const biz = normBiz(business);
      const { config } = await loadConfig(biz);
      const settings = await loadSettings(biz);
      const first = firstResponder(settings);
      const { data, error } = await db.from("calls").insert({
        business: biz, channel: "chat", status: first === "ai" ? "active" : "ringing", mode: first === "ai" ? "ai" : "ringing",
      }).select("id").single();
      if (error) throw new Error(error.message);
      if (first === "ai") {
        await systemMessage(data.id, settings.operation_mode === "autonomous"
          ? "Autonomous mode: the AI assistant replies"
          : `Administrator is ${settings.admin_availability}: the AI assistant replies`);
        await aiTurn(data.id);
      } else {
        await systemMessage(data.id, `Waiting ${config.clinic.chat_timeout_sec ?? 30} s for the administrator`);
      }
      return json({ call_id: data.id, mode: first === "ai" ? "ai" : "ringing", wait_sec: config.clinic.chat_timeout_sec ?? 30 });
    }

    if (!callId) return json({ error: "call_id is required" }, 400);
    const { data: call } = await db.from("calls").select("mode,status,channel").eq("id", callId).single();
    if (call?.channel !== "chat") return json({ error: "Not a chat" }, 400);
    if (call.status === "ended" && action !== "end") return json({ mode: "ended" });
    const { config } = await loadConfigForCall(callId);

    switch (action) {
      case "message": {
        if (!text) return json({ error: "text is required" }, 400);
        await db.from("call_messages").insert({ call_id: callId, speaker: "caller", text: String(text).slice(0, 2000) });
        if (call.mode === "ai") await aiTurn(callId);
        else if (call.mode === "admin") await observe(callId).catch((e) => console.error(e));
        return json({ mode: call.mode });
      }
      case "timeout": {
        if (call.mode === "ringing") {
          await db.from("calls").update({ status: "active", mode: "ai" }).eq("id", callId);
          await systemMessage(callId, `No reply in ${config.clinic.chat_timeout_sec ?? 30} s, the AI assistant replied`);
          await aiTurn(callId);
          return json({ mode: "ai" });
        }
        if (call.mode === "transferring") {
          await systemMessage(callId, "The administrator did not join");
          await handoffFailed(callId, config);
          await markEnded(callId, "callback");
          return json({ mode: "ended" });
        }
        return json({ mode: call.mode });
      }
      case "end":
        await markEnded(callId);
        return json({ mode: "ended" });
    }
    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: (e as Error).message }, 500);
  }
});

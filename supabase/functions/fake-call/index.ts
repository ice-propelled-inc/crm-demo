// deno-lint-ignore-file no-explicit-any
// Fake page-to-page call (docs/crm-demo-local/caller.html): keeps the calls table in the same states
// as twilio-voice does for a real call. Audio goes browser-to-browser over WebRTC (signalling over
// Supabase Realtime Broadcast) or to the Vapi assistant as a Vapi web call.
//   start     { phone, business } -> { call_id }  new call, ringing the administrator
//   ai        { call_id }                 no answer, the AI assistant answers
//   answered  { call_id }                 the administrator answered (first ring or transfer)
//   transfer  { call_id }                 the AI hands the call over, ring the administrator again
//   no-answer { call_id } -> { say }      the administrator missed the transfer: Draft, call back later
//   end       { call_id }                 the call ended
import { callBusiness, canHandOff, CORS, db, firstResponder, json, loadConfig, loadConfigForCall, loadSettings, normBiz, pinError, systemMessage } from "../_shared/common.ts";
import { callbackTask, ensureDraft } from "../_shared/tools.ts";

async function markEnded(callId: string, outcome?: string) {
  const { data: call } = await db.from("calls").select("status,outcome").eq("id", callId).single();
  if (call?.status === "ended") return;
  const { data: appt } = await db.from("appointments").select("id").eq("call_id", callId).eq("status", "filled").limit(1);
  await db.from("calls").update({
    status: "ended", ended_at: new Date().toISOString(),
    outcome: outcome ?? call?.outcome ?? (appt?.length ? "booked" : null),
  }).eq("id", callId);
  await systemMessage(callId, "Call ended");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const denied = pinError(req);
  if (denied) return denied;

  try {
    const { action, call_id: callId, phone, business } = await req.json();
    if (action !== "start" && !callId) return json({ error: "call_id is required" }, 400);
    const { config } = action === "start" ? await loadConfig(normBiz(business)) : await loadConfigForCall(callId);

    switch (action) {
      case "start": {
        const { data, error } = await db.from("calls")
          .insert({ phone: phone || null, business: normBiz(business), status: "ringing", mode: "ringing" }).select("id").single();
        if (error) throw new Error(error.message);
        return json({ call_id: data.id });
      }
      case "ai":
        await db.from("calls").update({ status: "active", mode: "ai" }).eq("id", callId);
        {
          // The page declines the ring at once when the AI answers first (mode and availability).
          const s = await loadSettings(await callBusiness(callId));
          await systemMessage(callId, firstResponder(s) === "ai"
            ? (s.operation_mode === "autonomous" ? "Autonomous mode: the AI assistant answered at once" : `Administrator is ${s.admin_availability}: the AI assistant answered at once`)
            : `No answer in ${config.clinic.admin_ring_timeout_sec} s, the AI assistant answered` + (s.operation_mode === "copilot" ? " (Copilot: it takes a message)" : ""));
        }
        return json({ ok: true });
      case "answered": {
        const { data } = await db.from("calls").select("mode").eq("id", callId).single();
        await db.from("calls").update({ status: "active", mode: "admin" }).eq("id", callId);
        await systemMessage(callId, data?.mode === "transferring"
          ? "Administrator joined. Collected data and transcript are on this page."
          : "Administrator answered. The AI assistant is listening and transcribing.");
        return json({ ok: true });
      }
      case "transfer":
        await db.from("calls").update({ mode: "transferring" }).eq("id", callId);
        await systemMessage(callId, "Transferring the call to the administrator");
        return json({ ok: true });
      case "no-answer":
        await systemMessage(callId, canHandOff(await loadSettings(await callBusiness(callId)))
          ? "The administrator did not pick up" : "The administrator is busy or offline: no live transfer");
        await ensureDraft(callId);
        await callbackTask(callId);
        await markEnded(callId, "callback");
        return json({ say: config.handoff.admin_no_answer.say });
      case "end":
        await markEnded(callId);
        return json({ ok: true });
    }
    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: (e as Error).message }, 500);
  }
});

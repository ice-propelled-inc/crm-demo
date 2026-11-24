// deno-lint-ignore-file no-explicit-any
// Vapi Server URL: live transcript, call status, tool calls and the end-of-call report.
// Configure the assistant's server URL to <functions>/vapi-webhook with the header x-vapi-secret = VAPI_SECRET.
import { db, digits, env, json, systemMessage } from "../_shared/common.ts";
import { runTool } from "../_shared/tools.ts";

// Find the call row created by twilio-voice (matched by caller number), or create one.
async function ensureCall(vc: any): Promise<string> {
  const vid = vc?.id;
  if (!vid) throw new Error("Vapi message without call id");
  const byVapi = await db.from("calls").select("id").eq("vapi_call_id", vid).limit(1);
  if (byVapi.data?.[0]) return byVapi.data[0].id;

  const phone = vc.customer?.number ?? null;
  const since = new Date(Date.now() - 10 * 60_000).toISOString();
  const { data: open } = await db.from("calls").select("id,phone").is("vapi_call_id", null)
    .neq("status", "ended").gte("started_at", since).order("started_at", { ascending: false }).limit(10);
  const match = open?.find((c: any) => phone && digits(c.phone) === digits(phone)) ?? open?.[0];
  if (match) {
    await db.from("calls").update({ vapi_call_id: vid, status: "active", mode: "ai" }).eq("id", match.id);
    return match.id;
  }
  const ins = await db.from("calls").insert({ phone, vapi_call_id: vid, status: "active", mode: "ai" }).select("id").single();
  if (ins.error) {
    // Another event of the same call created the row first.
    const again = await db.from("calls").select("id").eq("vapi_call_id", vid).single();
    if (again.error) throw new Error(ins.error.message);
    return again.data.id;
  }
  return ins.data.id;
}

async function handleToolCalls(msg: any) {
  const callId = await ensureCall(msg.call);
  const list = msg.toolCallList ?? msg.toolCalls ?? [];
  const results = [];
  for (const tc of list) {
    const name = tc.name ?? tc.function?.name;
    let args = tc.arguments ?? tc.function?.arguments ?? {};
    let result: unknown;
    try {
      if (typeof args === "string") args = JSON.parse(args || "{}");
      result = await runTool(name, args, callId);
    } catch (e) {
      console.error(name, e);
      result = { error: (e as Error).message };
    }
    results.push({ toolCallId: tc.id, result: JSON.stringify(result) });
  }
  return { results };
}

async function markEnded(callId: string) {
  const { data: call } = await db.from("calls").select("status,outcome").eq("id", callId).single();
  if (call?.status === "ended") return;
  const { data: appt } = await db.from("appointments").select("status").eq("call_id", callId).eq("status", "filled").limit(1);
  await db.from("calls").update({
    status: "ended", ended_at: new Date().toISOString(), outcome: call?.outcome ?? (appt?.length ? "booked" : null),
  }).eq("id", callId);
  await systemMessage(callId, "Call ended");
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (req.headers.get("x-vapi-secret") !== env("VAPI_SECRET")) return new Response("Unauthorized", { status: 401 });
  const body = await req.json();
  const msg = body.message ?? body;

  try {
    switch (msg.type) {
      case "tool-calls":
        return json(await handleToolCalls(msg));

      case "transcript":
        if (msg.transcriptType === "final" && msg.transcript) {
          const callId = await ensureCall(msg.call);
          await db.from("call_messages").insert({
            call_id: callId, speaker: msg.role === "assistant" ? "ai" : "caller", text: msg.transcript,
          });
        }
        break;

      case "status-update": {
        const callId = await ensureCall(msg.call);
        if (msg.status === "forwarding") {
          await db.from("calls").update({ mode: "transferring" }).eq("id", callId);
          await systemMessage(callId, "Transferring the call to the administrator");
        } else if (msg.status === "ended") {
          // After a transfer the Twilio leg continues with the administrator; twilio-voice ends the call then.
          const { data } = await db.from("calls").select("mode").eq("id", callId).single();
          if (data?.mode !== "transferring" && data?.mode !== "admin") await markEnded(callId);
        }
        break;
      }

      case "end-of-call-report": {
        const callId = await ensureCall(msg.call);
        const url = msg.recordingUrl ?? msg.artifact?.recordingUrl ?? msg.artifact?.recording?.mono?.combinedUrl;
        if (url) await db.from("calls").update({ recording_url: url }).eq("id", callId);
        break;
      }
    }
  } catch (e) {
    console.error(msg.type, e);
    return json({ error: (e as Error).message }, 500);
  }
  return json({ ok: true });
});

// deno-lint-ignore-file no-explicit-any
// Telnyx TeXML webhook for the clinic number (same routing as twilio-voice):
//   incoming        ring the admin softphone (SIP user of the credential connection) for admin_ring_timeout_sec
//   after-admin     no answer -> forward to the Vapi assistant over SIP
//   refer           Vapi transferCall (SIP REFER) -> ring the admin softphone again
//   transfer-result admin did not pick up -> apologise, keep a Draft, end the call
//   client-answered admin answered (status callback)
//   vapi-done       the Vapi leg ended without a transfer
//   recording       recording of the administrator's call is ready
// TeXML sends the same parameter names as TwiML (From, CallSid, DialCallStatus, RecordingUrl).
import { canHandOff, db, env, firstResponder, loadConfig, loadSettings, systemMessage } from "../_shared/common.ts";
import { callbackTask, ensureDraft } from "../_shared/tools.ts";

const xmlEsc = (s: string) => s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c]!));
const texml = (body: string) =>
  new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`, { headers: { "Content-Type": "text/xml" } });
const base = () => `${env("FUNCTIONS_PUBLIC_URL").replace(/\/$/, "")}/telnyx-voice`;
const step = (name: string, callId: string) => xmlEsc(`${base()}?step=${name}&call_id=${callId}`);
const adminSip = () => `sip:${env("TELNYX_SIP_USERNAME")}@sip.telnyx.com`;

// telnyx-signature-ed25519: base64 Ed25519 signature of "<telnyx-timestamp>|<raw body>",
// checked with the account public key (Mission Control > Keys & Credentials > Public Key).
async function validSignature(req: Request, raw: string): Promise<boolean> {
  const sig = req.headers.get("telnyx-signature-ed25519");
  const ts = req.headers.get("telnyx-timestamp");
  if (!sig || !ts || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const bytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", bytes(env("TELNYX_PUBLIC_KEY")), { name: "Ed25519" }, false, ["verify"]);
  return crypto.subtle.verify("Ed25519", key, bytes(sig), new TextEncoder().encode(`${ts}|${raw}`));
}

function adminDial(callId: string) {
  return `<Sip statusCallbackEvent="answered" statusCallback="${step("client-answered", callId)}">${xmlEsc(adminSip())}</Sip>`;
}

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

// Forward the call to the Vapi assistant over SIP (no answer, or the AI answers first).
const toVapi = (callId: string) =>
  `<Dial answerOnBridge="true" action="${step("vapi-done", callId)}" referUrl="${step("refer", callId)}">` +
  `<Sip>${xmlEsc(env("VAPI_SIP_URI"))}</Sip></Dial>`;

const aiFirstText = (s: { operation_mode: string; admin_availability: string }) => s.operation_mode === "autonomous"
  ? "Autonomous mode: the AI assistant answered at once"
  : `Administrator is ${s.admin_availability}: the AI assistant answered at once`;

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const raw = await req.text();
  if (!(await validSignature(req, raw))) return new Response("Invalid signature", { status: 403 });
  const p: Record<string, string> = Object.fromEntries(new URLSearchParams(raw));

  const q = new URL(req.url).searchParams;
  const callId = q.get("call_id") || "";
  const { config } = await loadConfig();
  const ring = config.clinic.admin_ring_timeout_sec;

  switch (q.get("step") || "incoming") {
    case "incoming": {
      // twilio_call_sid holds the provider call id (here the TeXML CallSid).
      const settings = await loadSettings();
      const aiFirst = firstResponder(settings) === "ai";
      const { data, error } = await db.from("calls").insert({
        phone: p.From, twilio_call_sid: p.CallSid, status: aiFirst ? "active" : "ringing", mode: aiFirst ? "ai" : "ringing",
      }).select("id").single();
      if (error) throw new Error(error.message);
      if (aiFirst) {
        await systemMessage(data.id, aiFirstText(settings));
        return texml(toVapi(data.id));
      }
      return texml(
        `<Dial timeout="${ring}" answerOnBridge="true" record="record-from-answer-dual" ` +
        `recordingStatusCallback="${step("recording", data.id)}" action="${step("after-admin", data.id)}">` +
        adminDial(data.id) + `</Dial>`,
      );
    }

    case "after-admin": {
      if (p.DialCallStatus === "completed") {
        await markEnded(callId);
        return texml("<Hangup/>");
      }
      await db.from("calls").update({ status: "active", mode: "ai" }).eq("id", callId);
      const copilot = (await loadSettings()).operation_mode === "copilot";
      await systemMessage(callId, `No answer in ${ring} s, the AI assistant answered` + (copilot ? " (Copilot: it takes a message)" : ""));
      return texml(toVapi(callId));
    }

    case "refer": {
      if (!canHandOff(await loadSettings())) {
        await systemMessage(callId, "The administrator is busy or offline: no live transfer");
        await ensureDraft(callId);
        await callbackTask(callId);
        await markEnded(callId, "callback");
        return texml(`<Say voice="Polly.Joanna">${xmlEsc(config.handoff.admin_no_answer.say)}</Say><Hangup/>`);
      }
      await db.from("calls").update({ mode: "transferring" }).eq("id", callId);
      return texml(
        `<Dial timeout="20" answerOnBridge="true" record="record-from-answer-dual" ` +
        `recordingStatusCallback="${step("recording", callId)}" action="${step("transfer-result", callId)}">` +
        adminDial(callId) + `</Dial>`,
      );
    }

    case "transfer-result": {
      if (p.DialCallStatus === "completed") {
        await markEnded(callId);
        return texml("<Hangup/>");
      }
      await systemMessage(callId, "The administrator did not pick up");
      await ensureDraft(callId);
      await callbackTask(callId);
      await markEnded(callId, "callback");
      return texml(`<Say voice="Polly.Joanna">${xmlEsc(config.handoff.admin_no_answer.say)}</Say><Hangup/>`);
    }

    case "client-answered": {
      const { data } = await db.from("calls").select("mode").eq("id", callId).single();
      await db.from("calls").update({ status: "active", mode: "admin" }).eq("id", callId);
      await systemMessage(callId, data?.mode === "transferring"
        ? "Administrator joined. Collected data and transcript are on this page."
        : "Administrator answered. The AI assistant is listening and transcribing.");
      return new Response("", { status: 204 });
    }

    case "vapi-done": {
      const { data } = await db.from("calls").select("mode").eq("id", callId).single();
      if (data?.mode !== "transferring" && data?.mode !== "admin") await markEnded(callId);
      return texml("<Hangup/>");
    }

    case "recording": {
      if (p.RecordingUrl) await db.from("calls").update({ recording_url: p.RecordingUrl }).eq("id", callId);
      return new Response("", { status: 204 });
    }
  }
  return new Response("Unknown step", { status: 400 });
});

// deno-lint-ignore-file no-explicit-any
// Twilio voice webhook for the clinic number (<functions>/twilio-voice?biz=<business set>, dental by default). Call routing:
//   incoming        ring the admin softphone for admin_ring_timeout_sec
//   after-admin     no answer -> forward to the Vapi assistant over SIP
//   refer           Vapi transferCall (SIP REFER) -> ring the admin softphone again
//   transfer-result admin did not pick up -> apologise, keep a Draft, end the call
//   client-answered admin answered (status callback)
//   vapi-done       the Vapi leg ended without a transfer
//   recording       recording of the administrator's call is ready
import { callBusiness, canHandOff, db, env, firstResponder, loadConfig, loadConfigForCall, loadSettings, normBiz, systemMessage } from "../_shared/common.ts";
import { callbackTask, ensureDraft } from "../_shared/tools.ts";

const xmlEsc = (s: string) => s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c]!));
const twiml = (body: string) =>
  new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`, { headers: { "Content-Type": "text/xml" } });
const base = () => `${env("FUNCTIONS_PUBLIC_URL").replace(/\/$/, "")}/twilio-voice`;
const step = (name: string, callId: string) => xmlEsc(`${base()}?step=${name}&call_id=${callId}`);

// X-Twilio-Signature: base64(HMAC-SHA1(auth token, URL + sorted POST params)).
async function validSignature(req: Request, params: Record<string, string>): Promise<boolean> {
  const sig = req.headers.get("x-twilio-signature");
  if (!sig) return false;
  const url = base() + new URL(req.url).search;
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env("TWILIO_AUTH_TOKEN")),
    { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(mac))) === sig;
}

function adminClient(callId: string, transfer: boolean) {
  return `<Client statusCallbackEvent="answered" statusCallback="${step("client-answered", callId)}">` +
    `<Identity>admin</Identity><Parameter name="call_id" value="${callId}"/>` +
    (transfer ? `<Parameter name="transfer" value="1"/>` : "") + `</Client>`;
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
  const form = await req.formData();
  const p: Record<string, string> = {};
  form.forEach((v, k) => (p[k] = String(v)));
  if (!(await validSignature(req, p))) return new Response("Invalid signature", { status: 403 });

  const q = new URL(req.url).searchParams;
  const callId = q.get("call_id") || "";
  const { config } = callId ? await loadConfigForCall(callId) : await loadConfig(normBiz(q.get("biz")));
  const ring = config.clinic.admin_ring_timeout_sec;

  switch (q.get("step") || "incoming") {
    case "incoming": {
      const biz = normBiz(q.get("biz"));
      const settings = await loadSettings(biz);
      const aiFirst = firstResponder(settings) === "ai";
      const { data, error } = await db.from("calls").insert({
        phone: p.From, business: biz, twilio_call_sid: p.CallSid, status: aiFirst ? "active" : "ringing", mode: aiFirst ? "ai" : "ringing",
      }).select("id").single();
      if (error) throw new Error(error.message);
      if (aiFirst) {
        await systemMessage(data.id, aiFirstText(settings));
        return twiml(toVapi(data.id));
      }
      return twiml(
        `<Dial timeout="${ring}" answerOnBridge="true" record="record-from-answer-dual" ` +
        `recordingStatusCallback="${step("recording", data.id)}" action="${step("after-admin", data.id)}">` +
        adminClient(data.id, false) + `</Dial>`,
      );
    }

    case "after-admin": {
      if (p.DialCallStatus === "completed") {
        await markEnded(callId);
        return twiml("<Hangup/>");
      }
      await db.from("calls").update({ status: "active", mode: "ai" }).eq("id", callId);
      const copilot = (await loadSettings(await callBusiness(callId))).operation_mode === "copilot";
      await systemMessage(callId, `No answer in ${ring} s, the AI assistant answered` + (copilot ? " (Copilot: it takes a message)" : ""));
      return twiml(toVapi(callId));
    }

    case "refer": {
      if (!canHandOff(await loadSettings(await callBusiness(callId)))) {
        await systemMessage(callId, "The administrator is busy or offline: no live transfer");
        await ensureDraft(callId);
        await callbackTask(callId);
        await markEnded(callId, "callback");
        return twiml(`<Say voice="Polly.Joanna">${xmlEsc(config.handoff.admin_no_answer.say)}</Say><Hangup/>`);
      }
      await db.from("calls").update({ mode: "transferring" }).eq("id", callId);
      return twiml(
        `<Dial timeout="20" answerOnBridge="true" record="record-from-answer-dual" ` +
        `recordingStatusCallback="${step("recording", callId)}" action="${step("transfer-result", callId)}">` +
        adminClient(callId, true) + `</Dial>`,
      );
    }

    case "transfer-result": {
      if (p.DialCallStatus === "completed") {
        await markEnded(callId);
        return twiml("<Hangup/>");
      }
      await systemMessage(callId, "The administrator did not pick up");
      await ensureDraft(callId);
      await callbackTask(callId);
      await markEnded(callId, "callback");
      return twiml(`<Say voice="Polly.Joanna">${xmlEsc(config.handoff.admin_no_answer.say)}</Say><Hangup/>`);
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
      return twiml("<Hangup/>");
    }

    case "recording": {
      if (p.RecordingUrl) await db.from("calls").update({ recording_url: `${p.RecordingUrl}.mp3` }).eq("id", callId);
      return new Response("", { status: 204 });
    }
  }
  return new Response("Unknown step", { status: 400 });
});

// deno-lint-ignore-file no-explicit-any
// Observer LLM for conversations the administrator leads (UC2 calls, and chats the administrator joined).
// Reads the transcript, updates stage / script step / fields and the suggestions for the live page,
// and books the slot once all required fields are known.
import { db, env, loadConfigForCall, resourceField } from "./common.ts";
import { bookSlot, missingRequired, updateCallState } from "./tools.ts";
import { nowInTz } from "./schedule.ts";

function systemPrompt(config: any, schedule: any): string {
  const now = nowInTz(config.clinic.timezone);
  return [
    config.prompts.observer,
    `Today is ${now.weekday}, ${now.date}. All times are clinic local time.`,
    "Funnel stages (id: label):", ...config.funnel_stages.map((s: any) => `- ${s.id}: ${s.label}`),
    "Script steps (step / stage: text):", ...config.script.map((s: any) => `- ${s.step} / ${s.stage}: ${s.say || s.goal}`),
    "Appointment fields:", ...config.appointment_fields.map((f: any) => `- ${f.id}${f.required ? " (required)" : ""}: ${f.label}`),
    "Services (id: name):", ...config.services.map((s: any) => `- ${s.id}: ${s.name}`),
    `Resources for the "${resourceField(config)}" field (id: name, speciality):`,
    ...schedule.doctors.map((d: any) => `- ${d.id}: ${d.name}, ${d.speciality_label}`),
    "Knowledge base (question: answer):", ...config.knowledge_base.faq.map((f: any) => `- ${f.q}: ${f.a}`),
    "Handoff triggers (id: description):", ...config.handoff.triggers.map((t: any) => `- ${t.id}: ${t.description}`),
    "Return only JSON:",
    '{"stage": "<stage id>", "script_step": "<step id>", "fields": {"<field id>": "<value>"},',
    ' "suggestions": {"next_question": "<what the administrator should ask next>",',
    '   "kb_answer": "<knowledge-base answer to the last question of the caller, or empty>",',
    '   "handoff_warning": "<trigger id if a handoff trigger fired, or empty>"}}.',
    `Include only fields that were actually said in the conversation. service and ${resourceField(config)} are ids;`,
    'datetime is "YYYY-MM-DDTHH:MM".',
  ].join("\n");
}

export async function askLlm(messages: any[], extra: Record<string, unknown> = {}): Promise<any> {
  const r = await fetch(`${env("LLM_BASE_URL").replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env("LLM_API_KEY")}` },
    body: JSON.stringify({ model: env("LLM_MODEL"), temperature: 0, messages, ...extra }),
  });
  if (!r.ok) throw new Error(`LLM: HTTP ${r.status}`);
  return (await r.json()).choices?.[0]?.message ?? {};
}

const SPEAKER: Record<string, string> = { admin: "Administrator", ai: "AI assistant", caller: "Caller" };

export async function observe(callId: string) {
  const { config, schedule } = await loadConfigForCall(callId);
  const [{ data: msgs }, { data: state }, { data: call }] = await Promise.all([
    db.from("call_messages").select("speaker,text").eq("call_id", callId).neq("speaker", "system")
      .order("created_at", { ascending: false }).limit(40),
    db.from("call_state").select("stage,script_step,fields").eq("call_id", callId).maybeSingle(),
    db.from("calls").select("phone,channel").eq("id", callId).single(),
  ]);
  const transcript = (msgs || []).reverse().map((m: any) => `${SPEAKER[m.speaker] || m.speaker}: ${m.text}`).join("\n");
  const user = `Channel: ${call?.channel || "phone"}\nCaller ID: ${call?.phone ?? "unknown"}\n` +
    `Current state: ${JSON.stringify(state || {})}\n\nTranscript:\n${transcript}`;

  const msg = await askLlm([{ role: "system", content: systemPrompt(config, schedule) }, { role: "user", content: user }]);
  const text: string = msg.content ?? "";
  const out = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  const stage = config.funnel_stages.some((s: any) => s.id === out.stage) ? out.stage : undefined;
  const script_step = config.script.some((s: any) => s.step === out.script_step) ? out.script_step : undefined;
  const fields = await updateCallState(callId, { stage, script_step, fields: out.fields || {} });
  const s = out.suggestions || {};
  const suggestions = {
    next_question: String(s.next_question || ""), kb_answer: String(s.kb_answer || ""),
    handoff_warning: config.handoff.triggers.some((t: any) => t.id === s.handoff_warning) ? s.handoff_warning : "",
  };
  await db.from("call_state").update({ suggestions }).eq("call_id", callId);

  // Auto-save: book the slot as soon as everything required is known (the administrator leads, so Copilot may book).
  let booking = null;
  const { data: appt } = await db.from("appointments").select("status").eq("call_id", callId).neq("status", "cancelled").limit(1);
  if (!missingRequired(config, fields).length && appt?.[0]?.status === "draft") {
    booking = await bookSlot({
      ...fields, service_id: fields.service, doctor_id: fields[resourceField(config)] || undefined, start: fields.datetime,
    }, callId, true).catch((e) => ({ error: (e as Error).message }));
  }
  return { stage, script_step, fields, suggestions, booking };
}

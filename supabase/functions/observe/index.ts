// deno-lint-ignore-file no-explicit-any
// UC2 observer: the page sends each final utterance of the administrator's call.
// Stores the message, asks the LLM for stage / script step / fields, updates the call state,
// and books the slot automatically once all required fields are known.
import { CORS, db, env, json, loadConfig, pinError } from "../_shared/common.ts";
import { bookSlot, missingRequired, updateCallState } from "../_shared/tools.ts";
import { nowInTz } from "../_shared/schedule.ts";

function systemPrompt(config: any, schedule: any): string {
  const now = nowInTz(config.clinic.timezone);
  return [
    config.prompts.observer,
    `Today is ${now.weekday}, ${now.date}. All times are clinic local time.`,
    "Funnel stages (id: label):", ...config.funnel_stages.map((s: any) => `- ${s.id}: ${s.label}`),
    "Script steps (step / stage: text):", ...config.script.map((s: any) => `- ${s.step} / ${s.stage}: ${s.say || s.goal}`),
    "Appointment fields:", ...config.appointment_fields.map((f: any) => `- ${f.id}${f.required ? " (required)" : ""}: ${f.label}`),
    "Services (id: name):", ...config.services.map((s: any) => `- ${s.id}: ${s.name}`),
    "Doctors (id: name, speciality):", ...schedule.doctors.map((d: any) => `- ${d.id}: ${d.name}, ${d.speciality_label}`),
    'Return only JSON: {"stage": "<stage id>", "script_step": "<step id>", "fields": {"<field id>": "<value>"}}.',
    "Include only fields that were actually said in the conversation. service and doctor are ids;",
    'datetime is "YYYY-MM-DDTHH:MM"; patient_type is "new" or "returning".',
  ].join("\n");
}

async function askLlm(system: string, user: string): Promise<any> {
  const r = await fetch(`${env("LLM_BASE_URL").replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env("LLM_API_KEY")}` },
    body: JSON.stringify({
      model: env("LLM_MODEL"), temperature: 0,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    }),
  });
  if (!r.ok) throw new Error(`LLM: HTTP ${r.status}`);
  const text: string = (await r.json()).choices?.[0]?.message?.content ?? "";
  return JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const denied = pinError(req);
  if (denied) return denied;

  const { call_id, speaker, text } = await req.json();
  if (!call_id || !text || !["admin", "caller"].includes(speaker)) return json({ error: "call_id, speaker and text are required" }, 400);

  try {
    await db.from("call_messages").insert({ call_id, speaker, text });

    const { config, schedule } = await loadConfig();
    const [{ data: msgs }, { data: state }] = await Promise.all([
      db.from("call_messages").select("speaker,text").eq("call_id", call_id).neq("speaker", "system")
        .order("created_at", { ascending: false }).limit(40),
      db.from("call_state").select("stage,script_step,fields").eq("call_id", call_id).maybeSingle(),
    ]);
    const transcript = (msgs || []).reverse()
      .map((m: any) => `${m.speaker === "admin" ? "Administrator" : "Caller"}: ${m.text}`).join("\n");
    const caller = await db.from("calls").select("phone").eq("id", call_id).single();
    const user = `Caller ID: ${caller.data?.phone ?? "unknown"}\nCurrent state: ${JSON.stringify(state || {})}\n\nTranscript:\n${transcript}`;

    const out = await askLlm(systemPrompt(config, schedule), user);
    const stage = config.funnel_stages.some((s: any) => s.id === out.stage) ? out.stage : undefined;
    const script_step = config.script.some((s: any) => s.step === out.script_step) ? out.script_step : undefined;
    const fields = await updateCallState(call_id, { stage, script_step, fields: out.fields || {} });

    // Auto-save: book the slot as soon as everything required is known.
    let booking = null;
    const { data: appt } = await db.from("appointments").select("status").eq("call_id", call_id).neq("status", "cancelled").limit(1);
    if (!missingRequired(fields).length && appt?.[0]?.status === "draft") {
      booking = await bookSlot({
        service_id: fields.service, doctor_id: fields.doctor || undefined, start: fields.datetime, name: fields.name,
        phone: fields.phone, patient_type: fields.patient_type, complaint: fields.complaint, insurance_number: fields.insurance_number,
      }, call_id).catch((e) => ({ error: (e as Error).message }));
    }
    return json({ ok: true, stage, script_step, fields, booking });
  } catch (e) {
    console.error(e);
    return json({ error: (e as Error).message }, 500);
  }
});

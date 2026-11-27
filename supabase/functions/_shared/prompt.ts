// deno-lint-ignore-file no-explicit-any
// Agent prompt built from the clinic data (same content as scripts/deploy_vapi_assistant.py), and the push to Vapi
// after the administrator saves clinic data on the page.
import { env, resourceField } from "./common.ts";

const LIQUID_NOW = (tz: string) => `{{"now" | date: "%A, %B %d, %Y, %I:%M %p", "${tz}"}}`;
const flat = (rules: Record<string, any>) => Object.values(rules || {}).flatMap((v) => (Array.isArray(v) ? v : [v]));

export function agentPrompt(config: any, schedule: any, channel: "phone" | "chat", nowText?: string): string {
  const c = config.clinic || config.business;
  const now = nowText ?? LIQUID_NOW(c.timezone);
  const intro = (channel === "chat" ? config.prompts.chat || config.prompts.agent : config.prompts.agent)
    .replaceAll("{clinic.name}", c.name).replaceAll("{business.name}", c.name).replaceAll("{{now}}", now);
  const h = config.handoff;
  const labels = config.labels || {};
  const say = (s: any) => (channel === "chat" && s.chat_say) || s.say || s.goal;
  const lines = [
    intro,
    channel === "chat"
      ? "You are writing in a web chat: short messages, one question at a time, no markdown."
      : "Be warm, brief and clear: one question at a time, short sentences, no lists or markdown.",
    `Current date and time: ${now}.`,
    channel === "phone" ? "Caller phone number (caller ID): {{customer.number}}." : "There is no caller ID in the chat: ask for the phone number.",
    "",
    "## Rules",
    ...flat(config.rules).map((r) => `- ${r}`),
    "- Use only the knowledge base and the services list below. Never invent prices, names or slots.",
    "- Always get slots from get_free_slots and book only slots it returned. Dates are YYYY-MM-DD, times HH:MM, local time.",
    "- If a tool returns an error, follow what the error says.",
    "",
    "## Handoff",
    "Hand over when:",
    ...h.triggers.map((t: any) => `- ${t.description} (handoff_reason: ${t.id})`),
    ...(h.urgent_case_steps || h.handoff_steps || []).map((s: string) => `- ${s}`),
    `Before the handoff, call update_call_state with stage handoff and the handoff_reason, then say: "${h.say_before_transfer}"`,
    channel === "phone" ? "and call transferCall." : "and call transfer_to_admin.",
    ...(h.admin_busy_or_offline ? [`If the handoff is not possible: ${h.admin_busy_or_offline}`] : []),
    "",
    "## Funnel stages (id: label)",
    ...config.funnel_stages.map((s: any) => `- ${s.id}: ${s.label}`),
    "",
    "## Script (step id / stage: what to say or do)",
    ...config.script.map((s: any) => `- ${s.step} / ${s.stage}${s.when ? ` (when ${s.when})` : ""}: ${say(s)}`),
    "",
    "## Fields for update_call_state and book_slot (field id: label)",
    ...config.appointment_fields.map((f: any) =>
      `- ${f.id}: ${f.label}${f.required ? " (required)" : " (optional)"}${f.note ? ` - ${f.note}` : ""}`),
    "",
    `## Services (service_id: name, price in ${c.currency}, duration)`,
    ...config.services.map((s: any) =>
      `- ${s.id}: ${s.name}, ${s.price_min}-${s.price_max}${s.price_note ? ` (${s.price_note})` : ""}, about ${s.duration_min} min` +
      `${s.speciality ? `, ${s.speciality}` : ""}${s.urgent ? ", urgent" : ""}`),
    "",
    `## ${labels.resources || "Doctors"} (${resourceField(config)} id: name, speciality)`,
    ...schedule.doctors.map((d: any) => `- ${d.id}: ${d.name}, ${d.speciality_label || ""} (${d.speciality})`),
  ];
  const menu = config.knowledge_base.menu;
  if (menu?.length) {
    lines.push("", `## Menu (prices in ${c.currency})`,
      ...menu.map((m: any) => `- ${m.name}, ${m.price}${m.description ? ` - ${m.description}` : ""}`));
  }
  lines.push("", "## Knowledge base", ...config.knowledge_base.faq.map((f: any) => `Q: ${f.q}\nA: ${f.a}`));
  return lines.join("\n");
}

// Tools for the LLM: agent-config.json "tools" (transfer_to_admin becomes Vapi's own transferCall on the phone).
export const llmTools = (config: any, channel: "phone" | "chat") =>
  config.tools.filter((t: any) => channel === "chat" || t.name !== "transfer_to_admin")
    .map((t: any) => ({ type: "function", function: t }));

async function vapi(method: string, path: string, body?: unknown) {
  const r = await fetch(`https://api.vapi.ai${path}`, {
    method,
    headers: { Authorization: `Bearer ${env("VAPI_API_KEY")}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Vapi ${method} ${path}: HTTP ${r.status} ${await r.text()}`);
  return r.json();
}

// Update the prompt, tools, greeting and key terms of the assistant whose server URL carries ?biz=<business>.
// Without VAPI_API_KEY the push is skipped (run scripts/deploy_vapi_assistant.py instead).
export async function pushToVapi(business: string, config: any, schedule: any): Promise<string> {
  if (!Deno.env.get("VAPI_API_KEY")) return "skipped: VAPI_API_KEY is not set";
  const list = await vapi("GET", "/assistant?limit=100");
  const a = list.find((x: any) => String(x.server?.url || "").endsWith(`biz=${business}`));
  if (!a) return `skipped: no Vapi assistant for ${business} (run scripts/deploy_vapi_assistant.py --business ${business})`;
  const transfer = (a.model?.tools || []).filter((t: any) => t.type === "transferCall");
  const greet = config.script.find((s: any) => s.step === "greet")?.say;
  await vapi("PATCH", `/assistant/${a.id}`, {
    ...(greet ? { firstMessage: greet } : {}),
    model: {
      ...a.model,
      messages: [{ role: "system", content: agentPrompt(config, schedule, "phone") }],
      tools: [...llmTools(config, "phone"), ...transfer],
    },
    transcriber: { ...a.transcriber, keyterm: config.speech_to_text?.keyterms || a.transcriber?.keyterm },
  });
  return `updated assistant ${a.id}`;
}

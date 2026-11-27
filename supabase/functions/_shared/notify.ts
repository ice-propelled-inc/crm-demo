// deno-lint-ignore-file no-explicit-any
// Patient notifications (booked, rescheduled, cancelled, reminder), sent only when turned on in the settings.
// SMS goes through Twilio (TWILIO_SMS_FROM), email through Resend (RESEND_API_KEY, EMAIL_FROM).
// Without a provider the message is logged with status "simulated", so the demo shows it on the page.
import { db, loadConfig, loadSettings } from "./common.ts";
import { findService, label } from "./schedule.ts";

export type NotifyEvent = "booked" | "rescheduled" | "cancelled" | "reminder";

export function fillTemplate(template: string, values: Record<string, string>) {
  return template.replace(/\{([\w.]+)\}/g, (all, k) => values[k] ?? all);
}

async function sendSms(to: string, text: string): Promise<"sent" | "simulated"> {
  const sid = Deno.env.get("TWILIO_ACCOUNT_SID"), token = Deno.env.get("TWILIO_AUTH_TOKEN"), from = Deno.env.get("TWILIO_SMS_FROM");
  if (!sid || !token || !from) return "simulated";
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: { Authorization: `Basic ${btoa(`${sid}:${token}`)}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ To: to, From: from, Body: text }),
  });
  if (!r.ok) throw new Error(`Twilio SMS: HTTP ${r.status} ${await r.text()}`);
  return "sent";
}

async function sendEmail(to: string, subject: string, text: string): Promise<"sent" | "simulated"> {
  const key = Deno.env.get("RESEND_API_KEY"), from = Deno.env.get("EMAIL_FROM");
  if (!key || !from) return "simulated";
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, subject, text }),
  });
  if (!r.ok) throw new Error(`Email: HTTP ${r.status} ${await r.text()}`);
  return "sent";
}

// Returns true when the event is turned on, so the caller can be told about the message.
export async function notificationEnabled(business: string, event: NotifyEvent) {
  const n = (await loadSettings(business)).notifications;
  return n.channel !== "off" && Boolean(n.events?.[event]?.enabled);
}

export async function notify(business: string, appt: any, event: NotifyEvent) {
  const settings = await loadSettings(business);
  const n = settings.notifications;
  const ev = n.events?.[event];
  if (!appt || n.channel === "off" || !ev?.enabled || !ev.template) return null;
  const { config, schedule } = await loadConfig(business);
  const start = appt.start ? String(appt.start).slice(0, 16) : "";
  const when = start ? label(start) : "";
  const values: Record<string, string> = {
    name: appt.name || "", service: findService(config, appt.service_id)?.name || "",
    doctor: schedule.doctors.find((d: any) => d.id === appt.doctor_id)?.name || "",
    date: when.split(", ").slice(0, 2).join(", "), time: when.split(", ").slice(2).join(", "),
    "clinic.name": config.clinic.name,
  };
  const text = fillTemplate(ev.template, values);
  const recipient = n.channel === "sms" ? appt.phone : appt.details?.email;
  let status = "simulated", error: string | null = null;
  try {
    if (!recipient) throw new Error(n.channel === "sms" ? "No phone number" : "No email address");
    status = n.channel === "sms" ? await sendSms(recipient, text) : await sendEmail(recipient, `${config.clinic.name}: ${event}`, text);
  } catch (e) {
    status = "failed"; error = (e as Error).message;
  }
  const { data } = await db.from("notifications").insert({
    business, appointment_id: appt.id, event, channel: n.channel, recipient, text, status, error,
  }).select().single();
  return data;
}

// Reminders for visits starting within hours_before (run by the admin function, e.g. from pg_cron every 15 min).
export async function sendDueReminders(business: string) {
  const n = (await loadSettings(business)).notifications;
  const ev = n.events?.reminder;
  if (n.channel === "off" || !ev?.enabled) return 0;
  const { config } = await loadConfig(business);
  const tz = config.clinic.timezone;
  const local = (d: Date) => new Intl.DateTimeFormat("sv-SE", { timeZone: tz, dateStyle: "short", timeStyle: "short" })
    .format(d).replace(" ", "T");
  const from = local(new Date()), to = local(new Date(Date.now() + (ev.hours_before || 24) * 3_600_000));
  const { data: appts } = await db.from("appointments").select("*").eq("business", business).eq("status", "filled")
    .gte("start", `${from}:00`).lte("start", `${to}:00`);
  const { data: done } = await db.from("notifications").select("appointment_id").eq("business", business).eq("event", "reminder");
  const sent = new Set((done || []).map((d: any) => d.appointment_id));
  let count = 0;
  for (const a of appts || []) if (!sent.has(a.id)) { await notify(business, a, "reminder"); count++; }
  return count;
}

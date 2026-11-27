// deno-lint-ignore-file no-explicit-any
// Agent tools (agent-config.json "tools") and the call-state / appointment logic shared with the UC2 observer.
// Every call belongs to a business set (calls.business); config, schedule and bookings are taken for that set.
import { callBusiness, db, digits, loadConfig, loadSettings, resourceField, systemMessage } from "./common.ts";
import { notificationEnabled, notify } from "./notify.ts";
import {
  addDays, candidateDoctors, findService, findSlots, fmtMin, isFree, label, loadBookings, normStart, nowInTz, toMin,
} from "./schedule.ts";

// Appointment columns filled from fields of the same name; other fields go to appointments.details.
const COLUMNS = ["name", "phone", "complaint", "insurance_company", "insurance_member_id"];
const INSURANCE_TYPES = ["none", "private", "cdcp"];
// Tool arguments that are not appointment fields.
const NOT_FIELDS = ["service_id", "start", "doctor_id", "technician_id", "resource_id", "appointment_id", "limit", "date", "time"];

async function context(business: string) {
  const { config, schedule } = await loadConfig(business);
  return { business, config, schedule, now: nowInTz(config.clinic.timezone) };
}

async function appointmentForCall(callId: string) {
  const { data, error } = await db.from("appointments").select("*").eq("call_id", callId)
    .neq("status", "cancelled").order("created_at", { ascending: false }).limit(1);
  if (error) throw new Error(error.message);
  return data?.[0] ?? null;
}

// Fields (call state or tool arguments) -> appointment columns and details.
function toAppointment(config: any, schedule: any, f: Record<string, any>) {
  const row: Record<string, any> = {};
  const details: Record<string, any> = {};
  const resField = resourceField(config);
  const svc = findService(config, f.service ?? f.service_id);
  if (svc) row.service_id = svc.id;
  const res = f[resField] ?? f.doctor_id ?? f.technician_id ?? f.resource_id;
  const doc = schedule.doctors.find((d: any) => d.id === res || d.name === res);
  if (doc) row.doctor_id = doc.id;
  for (const [k, v] of Object.entries(f)) {
    if (v === null || v === undefined || v === "") continue;
    if (COLUMNS.includes(k)) row[k] = String(v);
    else if (k === "patient_type") { if (v === "new" || v === "returning") row.patient_type = v; }
    else if (k === "insurance_type") { const t = String(v).toLowerCase(); if (INSURANCE_TYPES.includes(t)) row.insurance_type = t; }
    else if (!["service", "datetime", resField, ...NOT_FIELDS].includes(k)) details[k] = v;
  }
  if (Object.keys(details).length) row.details = details;
  return row;
}

// Keep a Draft appointment in sync with the collected fields while the call goes on.
async function syncDraft(callId: string, fields: Record<string, any>) {
  const business = await callBusiness(callId);
  const { config, schedule } = await loadConfig(business);
  const row = toAppointment(config, schedule, fields);
  const appt = await appointmentForCall(callId);
  if (!appt) {
    if (!row.service_id) return null;
    const { data, error } = await db.from("appointments")
      .insert({ ...row, business, call_id: callId, status: "draft" }).select().single();
    if (error) throw new Error(error.message);
    return data;
  }
  if (appt.status !== "draft") return appt;
  if (row.details) row.details = { ...(appt.details || {}), ...row.details };
  const { data, error } = await db.from("appointments").update(row).eq("id", appt.id).select().single();
  if (error) throw new Error(error.message);
  return data;
}

export async function updateCallState(callId: string, args: any) {
  const { data: prev } = await db.from("call_state").select("fields,handoff_reason").eq("call_id", callId).maybeSingle();
  const clean = Object.fromEntries(Object.entries(args.fields || {}).filter(([, v]) => v !== null && v !== undefined && v !== ""));
  const fields = { ...(prev?.fields || {}), ...clean };
  const row: Record<string, any> = { call_id: callId, fields, updated_at: new Date().toISOString() };
  if (args.stage) row.stage = args.stage;
  if (args.script_step) row.script_step = args.script_step;
  if (args.handoff_reason) row.handoff_reason = args.handoff_reason;
  const { error } = await db.from("call_state").upsert(row);
  if (error) throw new Error(error.message);
  if (args.handoff_reason) await db.from("calls").update({ handoff_reason: args.handoff_reason }).eq("id", callId);
  // Tell the administrator on the page that the AI wants to hand the conversation over, and why.
  if (args.handoff_reason && args.handoff_reason !== prev?.handoff_reason) {
    const { config } = await loadConfig(await callBusiness(callId));
    const trigger = config.handoff.triggers.find((t: any) => t.id === args.handoff_reason);
    await systemMessage(callId, `AI assistant asks for a handoff: ${trigger?.description || args.handoff_reason}`);
  }
  await syncDraft(callId, fields);
  return fields;
}

// Required fields of the business set (agent-config.json appointment_fields).
export const missingRequired = (config: any, fields: Record<string, any>) =>
  config.appointment_fields.filter((f: any) => f.required && !fields[f.id]).map((f: any) => f.id as string);

const resourceArg = (args: any) => args.doctor_id ?? args.technician_id ?? args.resource_id ?? undefined;

/* ---------- Tasks ---------- */

export async function createTask(business: string, t: {
  type: string; name?: string | null; phone?: string | null; reason?: string | null;
  call_id?: string | null; appointment_id?: string | null;
}) {
  if (!["callback", "urgent_callback", "coverage_check"].includes(t.type)) return { error: `Unknown task type "${t.type}"` };
  // One open task of a type per conversation or appointment.
  let q = db.from("tasks").select("id").eq("type", t.type).in("status", ["pending", "acknowledged"]);
  if (t.appointment_id) q = q.eq("appointment_id", t.appointment_id);
  else if (t.call_id) q = q.eq("call_id", t.call_id);
  else q = q.eq("id", "00000000-0000-0000-0000-000000000000");
  const { data: open } = await q.limit(1);
  if (open?.length) return { task_id: open[0].id, existing: true };
  const due = new Date(Date.now() + (t.type === "urgent_callback" ? 15 : t.type === "callback" ? 120 : 24 * 60) * 60_000);
  const { data, error } = await db.from("tasks").insert({
    business, type: t.type, name: t.name || null, phone: t.phone || null, reason: t.reason || null,
    call_id: t.call_id || null, appointment_id: t.appointment_id || null, due_at: due.toISOString(),
  }).select().single();
  if (error) throw new Error(error.message);
  if (t.call_id) await db.from("call_messages").insert({ call_id: t.call_id, speaker: "system", text: `Task created: ${t.type.replace("_", " ")}` });
  return { task_id: data.id, type: data.type, status: "Pending" };
}

// The administrator could not take over: callback task (urgent callback for an urgent case) from what was collected.
export async function callbackTask(callId: string) {
  const { data: call } = await db.from("calls").select("phone,business,handoff_reason").eq("id", callId).maybeSingle();
  const fields = await stateFields(callId);
  const { config } = await loadConfig(call?.business || "dental");
  // Handoff triggers marked urgent in agent-config.json (urgent case, emergency, lockout) make an urgent callback.
  const urgent = Boolean(config.handoff.triggers.find((t: any) => t.id === call?.handoff_reason)?.urgent);
  const appt = await appointmentForCall(callId);
  return createTask(call?.business || "dental", {
    type: urgent ? "urgent_callback" : "callback", name: fields.name, phone: fields.phone || call?.phone,
    reason: fields.complaint || call?.handoff_reason || "Call back", call_id: callId, appointment_id: appt?.id,
  });
}

async function coverageTask(business: string, appt: any) {
  if (appt.insurance_type !== "private" && appt.insurance_type !== "cdcp") return;
  const who = appt.insurance_type === "cdcp" ? "CDCP" : appt.insurance_company || "private plan";
  await createTask(business, {
    type: "coverage_check", name: appt.name, phone: appt.phone, call_id: appt.call_id, appointment_id: appt.id,
    reason: `${who}${appt.insurance_member_id ? ` · member ID ${appt.insurance_member_id}` : ""}`,
  });
}

export async function bookSlot(args: any, callId: string | null, byAdmin = false) {
  const { business, config, schedule, now } = await context(await callBusiness(callId));
  // Copilot mode: the AI takes a message when the administrator did not answer; it does not book.
  if (!byAdmin && (await loadSettings(business)).operation_mode === "copilot") {
    return { error: "Copilot mode: do not book. Take a message (name, phone, reason) and call create_task with type callback." };
  }
  const svc = findService(config, args.service_id);
  if (!svc) return { error: `Unknown service_id "${args.service_id}"` };
  const start = normStart(args.start);
  const date = start.slice(0, 10);
  const m = toMin(start.slice(11, 16));
  const existing = callId ? await appointmentForCall(callId) : null;
  const bookings = await loadBookings(date, date, business);
  const buf = schedule.travel_buffer_min || 0;
  const doc = candidateDoctors(schedule, svc.speciality, resourceArg(args), args.party_size)
    .find((d: any) => isFree(d, date, m, svc.duration_min, bookings, now, existing?.id, buf));
  if (!doc) {
    const nearest = findSlots(schedule, config,
      { service_id: svc.id, doctor_id: resourceArg(args), party_size: args.party_size, date, limit: 3 },
      await loadBookings(date, addDays(date, schedule.booking_horizon_days), business), now);
    return { error: "This slot is not free", nearest };
  }
  const fields = toAppointment(config, schedule, args);
  const row: Record<string, any> = {
    ...fields, business, call_id: callId, service_id: svc.id, doctor_id: doc.id, status: "filled",
    start: `${start}:00`, end: `${date}T${fmtMin(m + svc.duration_min)}:00`,
  };
  if (existing && fields.details) row.details = { ...(existing.details || {}), ...fields.details };
  const q = existing
    ? db.from("appointments").update(row).eq("id", existing.id)
    : db.from("appointments").insert(row);
  const { data, error } = await q.select().single();
  if (error) throw new Error(error.message);
  if (callId) {
    await db.from("call_state")
      .update({ fields: { ...(await stateFields(callId)), datetime: start, [resourceField(config)]: doc.id } })
      .eq("call_id", callId);
  }
  await coverageTask(business, data);
  await notify(business, data, existing?.status === "filled" ? "rescheduled" : "booked");
  return {
    appointment_id: data.id, assigned_to: doc.name, when: label(start), status: "Filled",
    confirmation_message: await notificationEnabled(business, "booked") ? "will be sent" : "none (do not mention one)",
  };
}

async function stateFields(callId: string) {
  const { data } = await db.from("call_state").select("fields").eq("call_id", callId).maybeSingle();
  return data?.fields || {};
}

export async function runTool(name: string, args: any, callId: string) {
  const { business, config, schedule, now } = await context(await callBusiness(callId));
  switch (name) {
    case "get_free_slots": {
      const from = args.date && args.date >= now.date ? args.date : now.date;
      const bookings = await loadBookings(from, addDays(from, schedule.booking_horizon_days), business);
      return { slots: findSlots(schedule, config, { ...args, doctor_id: resourceArg(args) }, bookings, now) };
    }
    case "book_slot":
      return bookSlot(args, callId);
    case "find_appointments": {
      const phone = digits(args.phone);
      let q = db.from("appointments").select("*").eq("business", business)
        .in("status", ["draft", "filled"]).gte("start", `${now.date}T00:00:00`);
      if (args.date) q = q.gte("start", `${args.date}T00:00:00`).lte("start", `${args.date}T23:59:59`);
      const { data, error } = await q.order("start");
      if (error) throw new Error(error.message);
      const name = (args.name || "").toLowerCase();
      const found = (data || []).filter((a: any) =>
        (!phone || digits(a.phone) === phone) && (!name || (a.name || "").toLowerCase().includes(name)));
      return {
        appointments: found.map((a: any) => ({
          appointment_id: a.id, name: a.name, service: findService(config, a.service_id)?.name,
          assigned_to: schedule.doctors.find((d: any) => d.id === a.doctor_id)?.name ?? null,
          when: a.start ? label(a.start.slice(0, 16)) : null, status: a.status, details: a.details,
        })),
      };
    }
    case "reschedule": {
      const { data: appt } = await db.from("appointments").select("*").eq("id", args.appointment_id).maybeSingle();
      if (!appt) return { error: "Appointment not found" };
      const svc = findService(config, appt.service_id);
      const start = normStart(args.start);
      const date = start.slice(0, 10);
      const m = toMin(start.slice(11, 16));
      const bookings = await loadBookings(date, date, business);
      const doc = candidateDoctors(schedule, svc.speciality, resourceArg(args) ?? appt.doctor_id ?? undefined, appt.details?.party_size)
        .find((d: any) => isFree(d, date, m, svc.duration_min, bookings, now, appt.id, schedule.travel_buffer_min || 0));
      if (!doc) return { error: "This slot is not free" };
      const { error } = await db.from("appointments").update({
        doctor_id: doc.id, status: "filled", start: `${start}:00`, end: `${date}T${fmtMin(m + svc.duration_min)}:00`,
      }).eq("id", appt.id);
      if (error) throw new Error(error.message);
      await db.from("calls").update({ outcome: "rescheduled" }).eq("id", callId);
      await notify(business, { ...appt, doctor_id: doc.id, start: `${start}:00` }, "rescheduled");
      return { appointment_id: appt.id, assigned_to: doc.name, when: label(start) };
    }
    case "cancel": {
      const { data, error } = await db.from("appointments").update({ status: "cancelled" })
        .eq("id", args.appointment_id).select();
      if (error) throw new Error(error.message);
      if (!data?.length) return { error: "Appointment not found" };
      await db.from("calls").update({ outcome: "cancelled" }).eq("id", callId);
      await notify(business, data[0], "cancelled");
      return { appointment_id: args.appointment_id, status: "Cancelled" };
    }
    case "create_task": {
      const fields = await stateFields(callId);
      const { data: call } = await db.from("calls").select("phone").eq("id", callId).maybeSingle();
      const appt = await appointmentForCall(callId);
      if (args.type === "callback" || args.type === "urgent_callback") await ensureDraft(callId);
      return createTask(business, {
        type: args.type, name: args.name || fields.name, phone: args.phone || fields.phone || call?.phone,
        reason: args.reason, call_id: callId, appointment_id: args.appointment_id || appt?.id,
      });
    }
    case "update_call_state": {
      const fields = await updateCallState(callId, args);
      return { ok: true, missing_required: missingRequired(config, fields) };
    }
    default:
      return { error: `Unknown tool "${name}"` };
  }
}

// Make sure a call that ends without an answer from the administrator keeps a Draft with what was collected.
export async function ensureDraft(callId: string) {
  const appt = await appointmentForCall(callId);
  if (appt) return;
  const { data: call } = await db.from("calls").select("phone,business").eq("id", callId).maybeSingle();
  const { config, schedule } = await loadConfig(call?.business);
  const row = toAppointment(config, schedule, await stateFields(callId));
  await db.from("appointments")
    .insert({ phone: call?.phone, ...row, business: call?.business || "dental", call_id: callId, status: "draft" });
}

// deno-lint-ignore-file no-explicit-any
// Agent tools (agent-config.json "tools") and the call-state / appointment logic shared with the UC2 observer.
import { db, digits, loadConfig } from "./common.ts";
import {
  addDays, candidateDoctors, findService, findSlots, fmtMin, isFree, label, loadBookings, normStart, nowInTz, toMin,
} from "./schedule.ts";

const REQUIRED = ["name", "phone", "service", "datetime", "patient_type", "complaint"];

async function context() {
  const { config, schedule } = await loadConfig();
  return { config, schedule, now: nowInTz(config.clinic.timezone) };
}

async function appointmentForCall(callId: string) {
  const { data, error } = await db.from("appointments").select("*").eq("call_id", callId)
    .neq("status", "cancelled").order("created_at", { ascending: false }).limit(1);
  if (error) throw new Error(error.message);
  return data?.[0] ?? null;
}

// Call-state fields -> appointment columns.
function toAppointment(config: any, schedule: any, f: Record<string, any>) {
  const row: Record<string, any> = {};
  const svc = findService(config, f.service);
  if (svc) row.service_id = svc.id;
  const doc = schedule.doctors.find((d: any) => d.id === f.doctor || d.name === f.doctor);
  if (doc) row.doctor_id = doc.id;
  for (const k of ["name", "phone", "complaint", "insurance_number"]) if (f[k]) row[k] = String(f[k]);
  if (f.patient_type === "new" || f.patient_type === "returning") row.patient_type = f.patient_type;
  return row;
}

// Keep a Draft appointment in sync with the collected fields while the call goes on.
async function syncDraft(callId: string, fields: Record<string, any>) {
  const { config, schedule } = await loadConfig();
  const row = toAppointment(config, schedule, fields);
  const appt = await appointmentForCall(callId);
  if (!appt) {
    if (!row.service_id) return null;
    const { data, error } = await db.from("appointments").insert({ ...row, call_id: callId, status: "draft" }).select().single();
    if (error) throw new Error(error.message);
    return data;
  }
  if (appt.status !== "draft") return appt;
  const { data, error } = await db.from("appointments").update(row).eq("id", appt.id).select().single();
  if (error) throw new Error(error.message);
  return data;
}

export async function updateCallState(callId: string, args: any) {
  const { data: prev } = await db.from("call_state").select("fields").eq("call_id", callId).maybeSingle();
  const clean = Object.fromEntries(Object.entries(args.fields || {}).filter(([, v]) => v !== null && v !== undefined && v !== ""));
  const fields = { ...(prev?.fields || {}), ...clean };
  const row: Record<string, any> = { call_id: callId, fields, updated_at: new Date().toISOString() };
  if (args.stage) row.stage = args.stage;
  if (args.script_step) row.script_step = args.script_step;
  if (args.handoff_reason) row.handoff_reason = args.handoff_reason;
  const { error } = await db.from("call_state").upsert(row);
  if (error) throw new Error(error.message);
  if (args.handoff_reason) await db.from("calls").update({ handoff_reason: args.handoff_reason }).eq("id", callId);
  await syncDraft(callId, fields);
  return fields;
}

export const missingRequired = (fields: Record<string, any>) => REQUIRED.filter((k) => !fields[k]);

export async function bookSlot(args: any, callId: string | null) {
  const { config, schedule, now } = await context();
  const svc = findService(config, args.service_id);
  if (!svc) return { error: `Unknown service_id "${args.service_id}"` };
  const start = normStart(args.start);
  const date = start.slice(0, 10);
  const m = toMin(start.slice(11, 16));
  const existing = callId ? await appointmentForCall(callId) : null;
  const bookings = await loadBookings(date, date);
  const doc = candidateDoctors(schedule, svc.speciality, args.doctor_id)
    .find((d: any) => isFree(d, date, m, svc.duration_min, bookings, now, existing?.id));
  if (!doc) {
    const nearest = findSlots(schedule, config, { service_id: svc.id, doctor_id: args.doctor_id, date, limit: 3 },
      await loadBookings(date, addDays(date, schedule.booking_horizon_days)), now);
    return { error: "This slot is not free", nearest };
  }
  const row: Record<string, any> = {
    call_id: callId, service_id: svc.id, doctor_id: doc.id, status: "filled",
    start: `${start}:00`, end: `${date}T${fmtMin(m + svc.duration_min)}:00`,
  };
  for (const k of ["name", "phone", "patient_type", "complaint", "insurance_number"]) if (args[k]) row[k] = args[k];
  const q = existing
    ? db.from("appointments").update(row).eq("id", existing.id)
    : db.from("appointments").insert(row);
  const { data, error } = await q.select().single();
  if (error) throw new Error(error.message);
  if (callId) await db.from("call_state").update({ fields: { ...(await stateFields(callId)), datetime: start, doctor: doc.id } }).eq("call_id", callId);
  return { appointment_id: data.id, doctor: doc.name, when: label(start), status: "Filled" };
}

async function stateFields(callId: string) {
  const { data } = await db.from("call_state").select("fields").eq("call_id", callId).maybeSingle();
  return data?.fields || {};
}

export async function runTool(name: string, args: any, callId: string) {
  const { config, schedule, now } = await context();
  switch (name) {
    case "get_free_slots": {
      const from = args.date && args.date >= now.date ? args.date : now.date;
      const bookings = await loadBookings(from, addDays(from, schedule.booking_horizon_days));
      return { slots: findSlots(schedule, config, args, bookings, now) };
    }
    case "book_slot":
      return bookSlot(args, callId);
    case "find_appointments": {
      const phone = digits(args.phone);
      let q = db.from("appointments").select("*").in("status", ["draft", "filled"]).gte("start", `${now.date}T00:00:00`);
      if (args.date) q = q.gte("start", `${args.date}T00:00:00`).lte("start", `${args.date}T23:59:59`);
      const { data, error } = await q.order("start");
      if (error) throw new Error(error.message);
      const name = (args.name || "").toLowerCase();
      const found = (data || []).filter((a: any) =>
        (!phone || digits(a.phone) === phone) && (!name || (a.name || "").toLowerCase().includes(name)));
      return {
        appointments: found.map((a: any) => ({
          appointment_id: a.id, name: a.name, service: findService(config, a.service_id)?.name,
          doctor: schedule.doctors.find((d: any) => d.id === a.doctor_id)?.name ?? null,
          when: a.start ? label(a.start.slice(0, 16)) : null, status: a.status,
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
      const bookings = await loadBookings(date, date);
      const doc = candidateDoctors(schedule, svc.speciality, args.doctor_id ?? appt.doctor_id ?? undefined)
        .find((d: any) => isFree(d, date, m, svc.duration_min, bookings, now, appt.id));
      if (!doc) return { error: "This slot is not free" };
      const { error } = await db.from("appointments").update({
        doctor_id: doc.id, status: "filled", start: `${start}:00`, end: `${date}T${fmtMin(m + svc.duration_min)}:00`,
      }).eq("id", appt.id);
      if (error) throw new Error(error.message);
      await db.from("calls").update({ outcome: "rescheduled" }).eq("id", callId);
      return { appointment_id: appt.id, doctor: doc.name, when: label(start) };
    }
    case "cancel": {
      const { data, error } = await db.from("appointments").update({ status: "cancelled" })
        .eq("id", args.appointment_id).select("id");
      if (error) throw new Error(error.message);
      if (!data?.length) return { error: "Appointment not found" };
      await db.from("calls").update({ outcome: "cancelled" }).eq("id", callId);
      return { appointment_id: args.appointment_id, status: "Cancelled" };
    }
    case "update_call_state": {
      const fields = await updateCallState(callId, args);
      return { ok: true, missing_required: missingRequired(fields) };
    }
    default:
      return { error: `Unknown tool "${name}"` };
  }
}

// Make sure a call that ends without an answer from the administrator keeps a Draft with what was collected.
export async function ensureDraft(callId: string) {
  const appt = await appointmentForCall(callId);
  if (appt) return;
  const { data: call } = await db.from("calls").select("phone").eq("id", callId).maybeSingle();
  const { config, schedule } = await loadConfig();
  const row = toAppointment(config, schedule, await stateFields(callId));
  await db.from("appointments").insert({ phone: call?.phone, ...row, call_id: callId, status: "draft" });
}

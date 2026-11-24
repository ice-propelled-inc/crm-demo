// deno-lint-ignore-file no-explicit-any
// Slot logic for schedule.json. Dates are "YYYY-MM-DD" and times are minutes, both in clinic local time.
// "doctors" are the schedule resources of any business set (doctors, technicians, couriers, tables).
import { db } from "./common.ts";

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const pad = (n: number) => String(n).padStart(2, "0");

export const toMin = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};
export const fmtMin = (m: number) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const utc = (date: string) => new Date(`${date}T00:00:00Z`);
export const dayKey = (date: string) => DAYS[utc(date).getUTCDay()];
export function addDays(date: string, n: number): string {
  const d = utc(date);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export type Now = { date: string; minutes: number; weekday: string };
export function nowInTz(tz: string): Now {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date());
  const g = (t: string) => parts.find((p) => p.type === t)!.value;
  const date = `${g("year")}-${g("month")}-${g("day")}`;
  return { date, minutes: Number(g("hour")) * 60 + Number(g("minute")), weekday: utc(date).toLocaleDateString("en-CA", { weekday: "long", timeZone: "UTC" }) };
}

// "YYYY-MM-DDTHH:MM" from any ISO-like input.
export function normStart(s: string): string {
  const v = String(s).trim().replace(" ", "T");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) throw new Error(`Bad date-time "${s}", expected YYYY-MM-DDTHH:MM`);
  return v.slice(0, 16);
}

export function label(start: string): string {
  const day = utc(start.slice(0, 10)).toLocaleDateString("en-CA", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
  let h = Number(start.slice(11, 13));
  const m = start.slice(14, 16);
  const ap = h >= 12 ? "pm" : "am";
  h = h % 12 || 12;
  return `${day}, ${h}${m === "00" ? "" : ":" + m} ${ap}`;
}

export type Booking = { id: string; doctor_id: string | null; start: string | null; end: string | null; status: string };

export async function loadBookings(fromDate: string, toDate: string, business = "dental"): Promise<Booking[]> {
  const { data, error } = await db.from("appointments").select("id,doctor_id,start,end,status")
    .eq("business", business).gte("start", `${fromDate}T00:00:00`).lte("start", `${toDate}T23:59:59`).neq("status", "cancelled");
  if (error) throw new Error(error.message);
  return data as Booking[];
}

// buf: travel_buffer_min of field services, kept free before and after every job and busy block.
export function isFree(
  doc: any, date: string, from: number, dur: number, bookings: Booking[], now: Now, ignoreId?: string, buf = 0,
): boolean {
  const w = doc.working_hours[dayKey(date)];
  if (!w || from < toMin(w[0]) || from + dur > toMin(w[1])) return false;
  if (date < now.date || (date === now.date && from <= now.minutes)) return false;
  const k = dayKey(date);
  const busy = doc.busy.filter((b: any) => b.days.includes(k)).map((b: any) => [toMin(b.from), toMin(b.to)]);
  const booked = bookings
    .filter((b) => b.id !== ignoreId && b.doctor_id === doc.id && b.start && b.end && b.start.slice(0, 10) === date)
    .map((b) => [toMin(b.start!.slice(11, 16)), toMin(b.end!.slice(11, 16))]);
  return ![...busy, ...booked].some(([a, z]) => from < z + buf && from + dur + buf > a);
}

export function freeSlots(schedule: any, doc: any, date: string, dur: number, bookings: Booking[], now: Now): number[] {
  const w = doc.working_hours[dayKey(date)];
  if (!w) return [];
  const out: number[] = [];
  for (let m = toMin(w[0]); m + dur <= toMin(w[1]); m += schedule.slot_step_min) {
    if (isFree(doc, date, m, dur, bookings, now, undefined, schedule.travel_buffer_min || 0)) out.push(m);
  }
  return out;
}

export function findService(config: any, idOrName?: string) {
  if (!idOrName) return undefined;
  const v = String(idOrName).toLowerCase();
  return config.services.find((s: any) => s.id === idOrName || s.name.toLowerCase() === v);
}

// Resources with the service speciality. With partySize: only tables that fit, smallest first.
export function candidateDoctors(schedule: any, speciality: string, doctorId?: string, partySize?: number) {
  const size = Number(partySize) || 0;
  return schedule.doctors
    .filter((d: any) => d.speciality === speciality && (!doctorId || d.id === doctorId))
    .filter((d: any) => !size || d.capacity == null || d.capacity >= size)
    .sort((a: any, b: any) => (size ? (a.capacity ?? 0) - (b.capacity ?? 0) : 0));
}

export type Slot = { doctor_id: string; doctor: string; start: string; label: string };

// Free slots for a service: one date, one time across dates, or the nearest ones within the booking horizon.
export function findSlots(
  schedule: any, config: any,
  opts: { service_id: string; doctor_id?: string; date?: string; time?: string; limit?: number; party_size?: number },
  bookings: Booking[], now: Now,
): Slot[] {
  const svc = findService(config, opts.service_id);
  if (!svc) throw new Error(`Unknown service_id "${opts.service_id}"`);
  const docs = candidateDoctors(schedule, svc.speciality, opts.doctor_id, opts.party_size);
  if (!docs.length) throw new Error("No resource for this service");
  const from = opts.date && opts.date >= now.date ? opts.date : now.date;
  const days = opts.date && !opts.time ? 1 : schedule.booking_horizon_days;
  const time = opts.time ? toMin(opts.time) : null;
  const out: { date: string; m: number; doc: any }[] = [];
  for (let i = 0; i < days; i++) {
    const date = addDays(from, i);
    for (const doc of docs) {
      for (const m of freeSlots(schedule, doc, date, svc.duration_min, bookings, now)) {
        if (time === null || m === time) out.push({ date, m, doc });
      }
    }
  }
  out.sort((a, b) => a.date.localeCompare(b.date) || a.m - b.m);
  return out.slice(0, opts.limit || 5).map((s) => {
    const start = `${s.date}T${fmtMin(s.m)}`;
    return { doctor_id: s.doc.id, doctor: s.doc.name, start, label: label(start) };
  });
}

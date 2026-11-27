'use strict';

/*
 * Call Desk admin page (docs/demo-process.md). Two data sources:
 *   Replay  scripted conversations (replay.js) and in-memory settings, tasks and clinic data;
 *   Live    Supabase tables over Realtime, the admin softphone (Twilio or Telnyx), Deepgram for UC2,
 *           and the admin Edge Function for settings, clinic data, tasks and chat replies.
 * data.js renders the AI assistant settings and the clinic data editor.
 */

/* ---------- State ---------- */

const CFG = window.DEMO_CONFIG || {};

const App = {
  config: null,          // agent-config.json (or the business_data row in Live mode)
  schedule: null,        // schedule.json
  seed: null,            // { config, schedule } as published with the page
  settings: null,        // { operation_mode, admin_availability, notifications }
  calls: new Map(),      // phone calls and chats
  messages: new Map(),   // call_id -> [message]
  states: new Map(),     // call_id -> call state
  appointments: new Map(),
  tasks: new Map(),
  notifications: [],
  activeCallId: null,
  view: 'live',
  date: null,            // schedule view date
  mode: 'replay',
  incoming: null,        // { phone, label, ringUntil, canAnswer, onAnswer, onDecline }
  filters: { appt: 'upcoming', apptQ: '', taskStatus: 'open', taskQ: '', convChannel: 'all', convActor: 'all', convQ: '' },
  openConv: null,
  business: null,        // entry of businesses/index.json
  replay: null,          // replay.json of the business (scripted conversations); null -> built-in dental scenarios
};

/* ---------- Helpers ---------- */

const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = id => `<svg class="i"><use href="#i-${id}"/></svg>`;
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const pad = n => String(n).padStart(2, '0');
const toMin = hhmm => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const fmtMin = m => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const dateKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseDate = s => { const [y, m, d] = s.slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d); };
const startOfDay = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const addDays = (d, n) => { const x = startOfDay(d); x.setDate(x.getDate() + n); return x; };
const fmtDate = d => d.toLocaleDateString('en-CA', { weekday: 'long', month: 'long', day: 'numeric' });
const fmtShortDate = d => d.toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric' });
const weekday = d => d.toLocaleDateString('en-CA', { weekday: 'long' });
const fmtTime12 = m => {
  let h = Math.floor(m / 60); const mm = m % 60; const ap = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12; return `${h}${mm ? ':' + pad(mm) : ''} ${ap}`;
};
const localIso = (d, min) => `${dateKey(d)}T${fmtMin(min)}`;
const fmtDateTime = s => s ? `${fmtDate(parseDate(s))}, ${fmtTime12(toMin(s.slice(11, 16)))}` : '';
const fmtClock = iso => iso ? new Date(iso).toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit' }) : '';
const fmtStamp = iso => iso ? new Date(iso).toLocaleString('en-CA', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
const fmtDuration = ms => { const s = Math.max(0, Math.floor(ms / 1000)); return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`; };
const nowMin = () => { const n = new Date(); return n.getHours() * 60 + n.getMinutes(); };
const clone = o => JSON.parse(JSON.stringify(o));
const uid = p => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

// Wording that differs per business (agent-config.json "labels"); defaults are the dental ones.
const LABEL_DEFAULTS = {
  business: 'Clinic', resource: 'Doctor', resources: 'Doctors', customer: 'Patient',
  booking: 'Appointment', bookings: 'Appointments', admin: 'Administrator', logo: 'BS',
  resource_field: 'doctor', closed: 'The clinic is closed on this day.',
};
const L = k => App.config?.labels?.[k] ?? LABEL_DEFAULTS[k];

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.add('hidden'), 4500);
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('Cannot load ' + src));
    document.head.appendChild(s);
  });
}

// The page code uses the dental key names; the other sets use generic ones.
function normalizeData(config, schedule) {
  config.clinic = config.clinic || config.business;
  schedule.doctors = schedule.doctors || schedule.resources;
  schedule.clinic_hours = schedule.clinic_hours || schedule.business_hours;
  return { config, schedule };
}

/* ---------- Settings: operation mode and administrator availability ---------- */

function defaultSettings(config) {
  const s = config.settings || {};
  return {
    operation_mode: s.operation_mode || 'overflow',
    admin_availability: s.admin_availability || 'available',
    notifications: clone(s.notifications || { channel: 'off', events: {} }),
  };
}

// Same rules as the backend (_shared/common.ts): who takes a new conversation first, and whether a handoff can ring.
const firstResponder = (s = App.settings) =>
  s.operation_mode === 'autonomous' || (s.operation_mode === 'overflow' && s.admin_availability !== 'available') ? 'ai' : 'admin';
const canHandOff = (s = App.settings) => s.admin_availability === 'available';
const notifyOn = event => {
  const n = App.settings.notifications;
  return n.channel !== 'off' && Boolean(n.events?.[event]?.enabled);
};
const MODE_NAMES = { copilot: 'Copilot', overflow: 'Overflow', autonomous: 'Autonomous' };
const AVAIL_NAMES = { available: 'Available', busy: 'Busy', offline: 'Offline' };

async function saveSettings(patch) {
  const prev = clone(App.settings);
  Object.assign(App.settings, patch);
  render();
  if (App.mode !== 'live') return true;
  try {
    await Live.fn('admin', { action: 'settings', business: Live.biz(), ...patch });
    return true;
  } catch (e) {
    App.settings = prev; render(); toast('Cannot save settings: ' + e.message);
    return false;
  }
}

/* ---------- Schedule logic ---------- */

const doctorById = id => App.schedule.doctors.find(d => d.id === id);
const serviceById = id => App.config.services.find(s => s.id === id);
const doctorsFor = speciality => App.schedule.doctors.filter(d => d.speciality === speciality);
const columnName = id => App.schedule.columns?.find(c => c.idOptCol === id)?.name || `Column ${id}`;

function workRange(doc, date) {
  const r = doc.working_hours?.[DAYS[date.getDay()]];
  return r ? [toMin(r[0]), toMin(r[1])] : null;
}

function busyBlocks(doc, date) {
  const k = DAYS[date.getDay()];
  return (doc.busy || []).filter(b => b.days.includes(k)).map(b => ({ from: toMin(b.from), to: toMin(b.to), label: b.label }));
}

function bookedBlocks(docId, date) {
  const k = dateKey(date);
  return [...App.appointments.values()]
    .filter(a => a.doctor_id === docId && a.start && a.end && a.start.slice(0, 10) === k && a.status !== 'cancelled')
    .map(a => ({ from: toMin(a.start.slice(11, 16)), to: toMin(a.end.slice(11, 16)), appt: a }));
}

function isFree(doc, date, from, dur) {
  const w = workRange(doc, date);
  if (!w || from < w[0] || from + dur > w[1]) return false;
  if (dateKey(date) === dateKey(new Date()) && from <= nowMin()) return false;
  if (startOfDay(date) < startOfDay(new Date())) return false;
  // Field services keep travel_buffer_min free before and after every job and busy block.
  const buf = App.schedule.travel_buffer_min || 0;
  return ![...busyBlocks(doc, date), ...bookedBlocks(doc.id, date)].some(b => from < b.to + buf && from + dur + buf > b.from);
}

function freeSlots(doc, date, dur) {
  const w = workRange(doc, date);
  if (!w) return [];
  const out = [];
  for (let m = w[0]; m + dur <= w[1]; m += App.schedule.slot_step_min) if (isFree(doc, date, m, dur)) out.push(m);
  return out;
}

// Nearest free slots of a service (for one doctor or any doctor with the service speciality).
function nearestSlots(svc, docId, limit = 3, fromDay = 0) {
  const docs = docId ? [doctorById(docId)].filter(Boolean) : doctorsFor(svc.speciality);
  const out = [];
  for (let i = fromDay; i < fromDay + 21 && out.length < limit; i++) {
    const d = addDays(new Date(), i);
    const day = docs.flatMap(doc => freeSlots(doc, d, svc.duration_min).map(m => ({ d, m, doc }))).sort((a, b) => a.m - b.m);
    out.push(...day.slice(0, limit - out.length));
  }
  return out;
}

/* ---------- Store (one entry point for Live and Replay events) ---------- */

let renderQueued = false;
function render() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; renderNow(); });
}

const Store = {
  reset() {
    App.calls.clear(); App.messages.clear(); App.states.clear(); App.appointments.clear(); App.tasks.clear();
    App.notifications = [];
    App.activeCallId = null; App.incoming = null; App.openConv = null;
    render();
  },
  upsertCall(c) {
    const prev = App.calls.get(c.id);
    const next = { channel: 'phone', ...(prev || {}), ...c };
    App.calls.set(c.id, next);
    if (prev && next.handoff_reason && !prev.handoff_reason && next.status !== 'ended') {
      toast(`AI assistant asks for a handoff: ${reasonLabel(next.handoff_reason)}`);
    }
    const active = App.calls.get(App.activeCallId);
    if (next.status !== 'ended' && (!active || active.status === 'ended')) App.activeCallId = next.id;
    render();
  },
  addMessage(m) {
    const list = App.messages.get(m.call_id) || [];
    if (m.id && list.some(x => x.id === m.id)) return;
    list.push({ created_at: new Date().toISOString(), ...m });
    App.messages.set(m.call_id, list);
    render();
  },
  setState(s) {
    const prev = App.states.get(s.call_id) || { fields: {}, visitedStages: [], visitedSteps: [], suggestions: {} };
    const next = { ...prev, ...s, fields: { ...prev.fields, ...(s.fields || {}) }, suggestions: { ...prev.suggestions, ...(s.suggestions || {}) } };
    next.visitedStages = [...new Set([...prev.visitedStages, s.stage].filter(Boolean))];
    next.visitedSteps = [...new Set([...prev.visitedSteps, s.script_step].filter(Boolean))];
    App.states.set(s.call_id, next);
    render();
  },
  upsertAppointment(a) {
    // Live rows keep fields without their own column (address, order items...) in details.
    const { details, ...cols } = a;
    App.appointments.set(a.id, { ...(App.appointments.get(a.id) || {}), ...(details || {}), ...cols });
    render();
  },
  upsertTask(t) {
    App.tasks.set(t.id, { ...(App.tasks.get(t.id) || {}), ...t });
    render();
  },
  addNotification(n) {
    if (n.id && App.notifications.some(x => x.id === n.id)) return;
    App.notifications.unshift({ created_at: new Date().toISOString(), ...n });
    render();
  },
};

async function setAppointmentStatus(id, status) {
  if (App.mode === 'live' && Live.sb) {
    const { error } = await Live.sb.from('appointments').update({ status }).eq('id', id);
    if (error) { toast('Cannot update status: ' + error.message); return; }
  }
  Store.upsertAppointment({ id, status });
}

async function setTaskStatus(id, status) {
  if (App.mode === 'live') {
    try { await Live.fn('admin', { action: 'task', id, status }); } catch (e) { toast('Cannot update task: ' + e.message); return; }
  }
  Store.upsertTask({ id, status });
}

/* ---------- Labels ---------- */

const SPEAKER = { ai: 'AI assistant', caller: 'Caller', admin: 'Administrator', system: '' };
const MODE_LABEL = {
  ringing: ['Ringing', 'amber'],
  ai: ['AI assistant is talking', 'green'],
  admin: ['Administrator is talking', 'violet'],
  transferring: ['Handing off to the administrator', 'red'],
};
const CHAT_MODE_LABEL = {
  ringing: ['Waiting for the administrator', 'amber'],
  ai: ['AI assistant is replying', 'green'],
  admin: ['Administrator is replying', 'violet'],
  transferring: ['Administrator invited', 'red'],
};
const STATUS_CLASS = { draft: 'amber', filled: 'teal', completed: 'green', cancelled: 'red', missed: 'red' };
const TASK_CLASS = { pending: 'amber', acknowledged: 'violet', resolved: 'green', declined: '' };
const TASK_TYPE_CLASS = { urgent_callback: 'red', callback: 'amber', coverage_check: 'violet' };
const OUTCOME = { booked: 'Booked', handoff: 'Handed off', callback: 'Callback task', rescheduled: 'Rescheduled', cancelled: 'Cancelled', message: 'Message taken' };
const statusLabel = id => App.config.appointment_statuses.find(s => s.id === id)?.label || id || '';
const reasonLabel = id => App.config.handoff.triggers.find(t => t.id === id)?.description || id;
const taskTypes = () => App.config.task_types || [
  { id: 'callback', label: 'Callback' }, { id: 'urgent_callback', label: 'Urgent callback' }, { id: 'coverage_check', label: 'Coverage check' }];
const taskStatuses = () => App.config.task_statuses || ['pending', 'acknowledged', 'resolved', 'declined'].map(id => ({ id, label: id[0].toUpperCase() + id.slice(1) }));
const taskTypeLabel = id => taskTypes().find(t => t.id === id)?.label || id;
const speakerName = sp => sp === 'admin' ? L('admin') : SPEAKER[sp] || sp;
const isChat = c => c?.channel === 'chat';
const actorOf = c => (App.messages.get(c.id) || []).some(m => m.speaker === 'admin') ? 'staff' : 'ai';

function fieldValue(id, v) {
  if (v == null || v === '') return '';
  if (id === 'service') return serviceById(v)?.name || v;
  if (id === L('resource_field')) return doctorById(v)?.name || v;
  if (id === 'datetime') return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) ? fmtDateTime(v) : v;
  if (id === 'patient_type') return v === 'new' ? 'New' : v === 'returning' ? 'Returning' : v;
  if (id === 'insurance_type') return { none: 'None', private: 'Private plan', cdcp: 'CDCP' }[v] || v;
  return v;
}

/* ---------- Views ---------- */

function renderNow() {
  document.querySelectorAll('#side a[data-view]').forEach(a => a.classList.toggle('active', a.dataset.view === App.view));
  $('#replayBar').classList.toggle('hidden', App.mode !== 'replay');
  document.querySelectorAll('#modeSwitch button').forEach(b => b.classList.toggle('active', b.dataset.mode === App.mode));
  $('#availSelect').value = App.settings.admin_availability;
  $('#availText').textContent = `${AVAIL_NAMES[App.settings.admin_availability]} · ${MODE_NAMES[App.settings.operation_mode]}`;
  const open = [...App.tasks.values()].filter(t => t.status === 'pending' || t.status === 'acknowledged');
  const cnt = $('#cntTasks');
  cnt.textContent = open.length; cnt.classList.toggle('hidden', !open.length);
  cnt.classList.toggle('hot', open.some(t => t.type === 'urgent_callback'));
  const live = [...App.calls.values()].filter(c => c.status !== 'ended').length;
  $('#cntLive').textContent = live; $('#cntLive').classList.toggle('hidden', !live);
  renderIncoming();

  // Keep focus and the draft text of the chat composer across renders.
  const comp = $('#composer');
  const draft = comp?.value || '';
  const focused = document.activeElement === comp;
  const views = {
    live: viewLive, conversations: viewConversations, tasks: viewTasks, appointments: viewAppointments,
    schedule: viewSchedule, assistant: viewAssistant, data: viewData,
  };
  const view = $('#view');
  if (App.view === 'data' && view.dataset.view === 'data' && DataEditor.keep) return; // do not wipe inputs while editing
  view.dataset.view = App.view;
  view.innerHTML = (views[App.view] || viewLive)();
  const box = $('.live .messages', view);
  if (box) box.scrollTop = box.scrollHeight;
  const comp2 = $('#composer');
  if (comp2) { comp2.value = draft; if (focused) comp2.focus(); }
}

function renderIncoming() {
  const el = $('#incoming');
  const inc = App.incoming;
  if (!inc) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  const left = inc.ringUntil ? Math.max(0, Math.ceil((inc.ringUntil - Date.now()) / 1000)) : null;
  el.classList.remove('hidden');
  el.innerHTML = `
    <span class="ring-dot"></span>
    <span class="title">${esc(inc.label)}</span>
    <span>${esc(inc.phone || '')}</span>
    ${left !== null ? `<span class="small">${esc(inc.timeoutText || 'AI assistant answers')} in ${left} s</span>` : ''}
    <span class="grow"></span>
    ${inc.canAnswer ? `<button class="btn primary" data-act="answer">${icon('phone')}Answer</button><button class="btn danger" data-act="decline">Decline</button>` : ''}`;
}

function pageHead(title, sub, actions = '') {
  return `<div class="page-head"><div><h1>${esc(title)}</h1>${sub ? `<p>${sub}</p>` : ''}</div><div class="toolbar">${actions}</div></div>`;
}

function messagesHtml(callId) {
  const list = App.messages.get(callId) || [];
  if (!list.length) return '<div class="muted small">No messages yet.</div>';
  return list.map(m => m.speaker === 'system'
    ? `<div class="sysmsg">${esc(m.text)}</div>`
    : `<div class="turn ${esc(m.speaker)}"><div class="by">${esc(speakerName(m.speaker))} · ${fmtClock(m.created_at)}</div>${esc(m.text)}</div>`
  ).join('');
}

const stepText = (s, call) => ((isChat(call) && s.chat_say) || s.say || s.goal).replace('{caller_phone}', call.phone || 'this number');

// Suggestions for the administrator: the next question, matching free slots, the knowledge-base answer, a handoff warning.
function suggestionsFor(call, st) {
  const cfg = App.config;
  const f = st.fields;
  const missing = cfg.appointment_fields.filter(x => x.required && !f[x.id]).map(x => x.id);
  const booked = [...App.appointments.values()].some(a => a.call_id === call.id && a.status === 'filled');
  let next = booked || call.status === 'ended' ? '' : st.suggestions?.next_question;
  if (!next && !booked && call.status !== 'ended') {
    const step = cfg.script.find(s => (s.collects || []).some(id => missing.includes(id)));
    next = step ? stepText(step, call) : missing.length ? '' : `All required fields are collected: confirm the ${L('booking').toLowerCase()}.`;
  }
  const svc = serviceById(f.service);
  const slots = svc && !f.datetime && !booked && call.status !== 'ended' ? nearestSlots(svc, f[L('resource_field')], 3, 0) : [];
  const warn = st.handoff_reason || call.handoff_reason || st.suggestions?.handoff_warning;
  return { next, slots, kb: st.suggestions?.kb_answer, warn, missing };
}

function viewLive() {
  const call = App.calls.get(App.activeCallId);
  const sub = 'Follow the conversation as it happens: intake, script and suggestions.';
  if (!call) {
    return pageHead('Live conversation', sub) + `<div class="panel"><div class="empty">
      <div class="tile">${icon('wave')}</div><b>No active conversation</b>
      <div>${App.mode === 'replay'
        ? 'Start a scenario from the Replay bar above.'
        : 'Waiting for calls and chats. This page opens automatically.'}</div></div></div>`;
  }
  const st = App.states.get(call.id) || { fields: {}, visitedStages: [], visitedSteps: [], suggestions: {} };
  const cfg = App.config;
  const labels = isChat(call) ? CHAT_MODE_LABEL : MODE_LABEL;
  const [modeText, modeCls] = call.status === 'ended' ? [isChat(call) ? 'Chat ended' : 'Call ended', ''] : (labels[call.mode] || [call.mode, '']);
  const end = call.ended_at ? new Date(call.ended_at) : new Date();
  const appt = [...App.appointments.values()].find(a => a.call_id === call.id);
  const sg = suggestionsFor(call, st);
  const tasks = [...App.tasks.values()].filter(t => t.call_id === call.id);

  const stages = cfg.funnel_stages.filter(s => s.id !== 'handoff').map(s => {
    const cls = s.id === st.stage ? 'current' : st.visitedStages.includes(s.id) ? 'done' : '';
    return `<span class="stage ${cls}">${esc(s.label)}</span>`;
  }).join('');

  const fields = cfg.appointment_fields.map(f => {
    const v = fieldValue(f.id, st.fields[f.id]);
    const cls = v ? 'filled' : f.required ? 'missing' : 'optional';
    const mark = v ? '✓' : f.required ? '!' : '–';
    return `<div class="field-row ${cls}"><span class="mark">${mark}</span><span class="lbl">${esc(f.label)}</span><span class="val">${esc(v || (f.required ? 'Missing' : 'Optional'))}</span></div>`;
  }).join('');

  const script = cfg.script.map(s => {
    const cls = s.step === st.script_step ? 'current' : st.visitedSteps.includes(s.step) ? 'done' : '';
    const stageLabel = cfg.funnel_stages.find(x => x.id === s.stage)?.label || s.stage;
    return `<li class="${cls}"><div class="st">${esc(stageLabel)}${s.when ? ` · when ${esc(s.when)}` : ''}</div>${esc(stepText(s, call))}</li>`;
  }).join('');

  const suggestions = `
    ${sg.warn ? `<div class="sg warn"><div class="eyebrow">${icon('alert')}Handoff trigger</div>${esc(reasonLabel(sg.warn))}</div>` : ''}
    ${sg.next ? `<div class="sg"><div class="eyebrow">${icon('spark')}Next question</div>${esc(sg.next)}</div>` : ''}
    ${sg.slots.length ? `<div class="sg"><div class="eyebrow">${icon('cal')}Matching free slots</div><div class="slots">
        ${sg.slots.map(s => `<span class="slot" title="${esc(s.doc.name)}">${esc(fmtShortDate(s.d))} ${esc(fmtTime12(s.m))} · ${esc(s.doc.name.replace(/^Dr\. /, ''))}</span>`).join('')}</div></div>` : ''}
    ${sg.kb ? `<div class="sg"><div class="eyebrow">${icon('book')}Knowledge base</div>${esc(sg.kb)}</div>` : ''}
    ${tasks.map(t => `<div class="sg"><div class="eyebrow">${icon('check')}Task created</div>${esc(taskTypeLabel(t.type))}${t.reason ? ` · ${esc(t.reason)}` : ''}</div>`).join('')}`;

  // Web chat in Live mode: the administrator joins and writes here.
  let chatBox = '';
  if (isChat(call) && call.status !== 'ended') {
    if (App.mode !== 'live') chatBox = '<div class="muted small" style="margin-top:.6rem">Replies from this page work in Live mode.</div>';
    else if (call.mode === 'admin') chatBox = `<form class="composer" data-form="chat"><input id="composer" placeholder="Write to the visitor…" autocomplete="off"><button class="btn primary" aria-label="Send">${icon('send')}</button></form>`;
    else chatBox = '<div class="muted small" style="margin-top:.6rem">Press Take over to reply. The AI stops replying; it keeps intake and suggestions.</div>';
  }

  // Handoff: the AI asked for it (trigger), or is ringing the administrator now.
  const reason = call.handoff_reason || st.handoff_reason;
  const handingOff = call.status !== 'ended' && call.mode !== 'admin' && (reason || call.mode === 'transferring');
  const handoffBanner = handingOff ? `<div class="handoff-alert">${icon('alert')}<div>
      <b>${call.mode === 'transferring'
        ? (isChat(call) ? 'The AI assistant is inviting you to the chat' : `The AI assistant is transferring the call to you`)
        : 'The AI assistant asks for a handoff'}</b>
      ${reason ? `<div>${esc(reasonLabel(reason))}</div>` : ''}</div></div>` : '';
  // Take over: while the AI leads (and, for a chat, while it waits for the administrator).
  const canTake = call.status !== 'ended' && (call.mode === 'ai' || (isChat(call) && (call.mode === 'ringing' || call.mode === 'transferring')));
  const takeBtn = canTake ? `<button class="btn primary sm" data-act="takeover">${icon(isChat(call) ? 'chat' : 'phone')}Take over</button>` : '';

  const others = [...App.calls.values()].filter(c => c.status !== 'ended' && c.id !== call.id);
  return pageHead('Live conversation', sub, others.length ? `<label class="compact-label">Switch
      <select data-act="switchCall"><option value="${esc(call.id)}">${esc(call.phone || 'Chat visitor')}</option>
      ${others.map(c => `<option value="${esc(c.id)}">${esc(c.phone || 'Chat visitor')} · ${isChat(c) ? 'chat' : 'call'}</option>`).join('')}</select></label>` : '') + `
    <div class="live">
      <div class="panel" style="margin-bottom:12px">
        <div class="call-head">
          <span class="tile ${isChat(call) ? 'purple' : 'teal'}">${icon(isChat(call) ? 'chat' : 'phone')}</span>
          <span class="who">${esc(call.phone || st.fields.name || 'Chat visitor')}</span>
          <span class="badge">${isChat(call) ? 'Web chat' : 'Phone call'}</span>
          <span class="badge ${modeCls}">${esc(modeText)}</span>
          <span class="timer">${fmtDuration(end - new Date(call.started_at))}</span>
          ${appt ? `<span class="badge ${STATUS_CLASS[appt.status] || ''}">${esc(L('booking'))}: ${esc(statusLabel(appt.status))}</span>` : ''}
          <span class="grow" style="flex:1"></span>
          <span class="badge violet">${esc(MODE_NAMES[App.settings.operation_mode])} · ${esc(AVAIL_NAMES[App.settings.admin_availability])}</span>
          ${takeBtn}
        </div>
        ${handoffBanner}
      </div>
      <div class="live-grid">
        <div class="stack">
          <div class="panel"><h3>Funnel stage</h3><div class="stages">${stages}</div></div>
          <div class="panel"><div class="panel-head"><h2>Intake</h2><span class="badge ${sg.missing.length ? 'amber' : 'green'}">${sg.missing.length ? `${sg.missing.length} missing` : 'Complete'}</span></div><div class="fields">${fields}</div></div>
        </div>
        <div class="panel transcript"><div class="panel-head"><h2>${isChat(call) ? 'Chat' : 'Transcript'}</h2><span class="badge">${isChat(call) ? 'Messages' : 'Speech to text'}</span></div>
          <div class="messages">${messagesHtml(call.id)}</div>${chatBox}</div>
        <div class="stack col-right">
          <div class="panel"><div class="panel-head"><h2>Suggestions</h2><span class="badge green">AI assist</span></div><div class="suggest">${suggestions || '<div class="muted small">Suggestions appear as the conversation goes on.</div>'}</div></div>
          <div class="panel"><h3>Script</h3><ul class="script">${script}</ul></div>
        </div>
      </div>
    </div>`;
}

function viewConversations() {
  const f = App.filters;
  const q = f.convQ.toLowerCase();
  let calls = [...App.calls.values()].sort((a, b) => (b.started_at || '').localeCompare(a.started_at || ''));
  if (f.convChannel !== 'all') calls = calls.filter(c => (c.channel || 'phone') === f.convChannel);
  if (f.convActor !== 'all') calls = calls.filter(c => actorOf(c) === f.convActor);
  if (q) calls = calls.filter(c => [c.phone, App.states.get(c.id)?.fields?.name].some(v => String(v || '').toLowerCase().includes(q)));
  const rows = calls.map(c => {
    const appt = [...App.appointments.values()].find(a => a.call_id === c.id);
    const name = App.states.get(c.id)?.fields?.name;
    const open = App.openConv === c.id;
    return `<tr class="${open ? 'row-open' : ''}">
      <td><span class="badge ${isChat(c) ? 'violet' : ''}">${icon(isChat(c) ? 'chat' : 'phone')}${isChat(c) ? 'Chat' : 'Call'}</span></td>
      <td><b>${esc(name || c.phone || 'Chat visitor')}</b>${name && c.phone ? `<div class="muted nw">${esc(c.phone)}</div>` : ''}</td>
      <td class="nw">${actorOf(c) === 'staff' ? 'Staff-led' : 'AI-led'}</td>
      <td class="nw">${c.status === 'ended' ? `Ended · ${fmtDuration(new Date(c.ended_at) - new Date(c.started_at))}` : '<span class="badge amber">Active</span>'}</td>
      <td>${c.outcome ? esc(OUTCOME[c.outcome] || c.outcome) : '—'}${c.handoff_reason ? `<div class="muted">${esc(reasonLabel(c.handoff_reason))}</div>` : ''}</td>
      <td>${appt ? `<span class="badge ${STATUS_CLASS[appt.status] || ''}">${esc(statusLabel(appt.status))}</span>` : '—'}</td>
      <td>${esc(fmtStamp(c.started_at))}</td>
      <td style="white-space:nowrap"><button class="textbtn" data-act="toggleConv" data-id="${esc(c.id)}">${open ? 'Hide' : 'Transcript'}</button>
        · <button class="textbtn" data-act="open" data-id="${esc(c.id)}">Live page</button></td>
    </tr>${open ? `<tr class="row-open"><td colspan="8">
      ${c.recording_url ? `<audio controls preload="none" src="${esc(c.recording_url)}"></audio>` : ''}
      <div class="messages" style="max-height:360px">${messagesHtml(c.id)}</div></td></tr>` : ''}`;
  }).join('');
  const notif = App.notifications.map(n => {
    const a = App.appointments.get(n.appointment_id);
    return `<tr><td>${esc(n.event[0].toUpperCase() + n.event.slice(1))}<div class="muted">${esc(n.text)}</div></td>
      <td>${esc(a?.name || '—')}<div class="muted">${esc(a?.start ? fmtDateTime(a.start) : '')}</div></td>
      <td>${esc(n.channel.toUpperCase())} · ${esc(n.recipient || '—')}</td>
      <td><span class="badge ${n.status === 'sent' ? 'green' : n.status === 'failed' ? 'red' : 'violet'}">${esc(n.status)}</span>${n.error ? `<div class="muted">${esc(n.error)}</div>` : ''}</td>
      <td>${esc(fmtStamp(n.created_at))}</td></tr>`;
  }).join('');
  return pageHead('Conversations', 'Call recordings, transcripts, chat histories and notifications.', `
      <span class="search">${icon('chat')}<input type="search" data-filter="convQ" placeholder="Search conversations" value="${esc(f.convQ)}"></span>
      <label class="compact-label">Channel <select data-filter="convChannel">
        ${[['all', 'All'], ['phone', 'Calls'], ['chat', 'Chats']].map(([v, l]) => `<option value="${v}" ${f.convChannel === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="compact-label">Actor <select data-filter="convActor">
        ${[['all', 'All'], ['ai', 'AI-led'], ['staff', 'Staff-led']].map(([v, l]) => `<option value="${v}" ${f.convActor === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`) + `
    <div class="panel"><div class="panel-head"><h2>Conversation history</h2><span class="badge">${calls.length}</span></div>
      <div class="table-scroll"><table>
        <tr><th>Channel</th><th>${esc(L('customer'))}</th><th>Actor</th><th>Status</th><th>Outcome</th><th>${esc(L('booking'))}</th><th>Time</th><th></th></tr>
        ${rows || '<tr><td colspan="8" class="empty-row">No conversations yet.</td></tr>'}
      </table></div></div>
    <div class="panel"><div class="panel-head"><h2>Notifications</h2>
        <span class="badge ${App.settings.notifications.channel === 'off' ? '' : 'green'}">${App.settings.notifications.channel === 'off' ? 'Turned off' : App.settings.notifications.channel.toUpperCase()}</span></div>
      <div class="table-scroll"><table>
        <tr><th>Notification</th><th>${esc(L('booking'))}</th><th>Channel</th><th>Status</th><th>Time</th></tr>
        ${notif || '<tr><td colspan="5" class="empty-row">No notifications. Turn them on in AI assistant settings.</td></tr>'}
      </table></div></div>`;
}

function viewTasks() {
  const f = App.filters;
  const q = f.taskQ.toLowerCase();
  const rank = t => (t.status === 'pending' || t.status === 'acknowledged' ? 0 : 2) + (t.type === 'urgent_callback' ? 0 : 1);
  let list = [...App.tasks.values()].sort((a, b) => rank(a) - rank(b) || (b.created_at || '').localeCompare(a.created_at || ''));
  if (f.taskStatus === 'open') list = list.filter(t => t.status === 'pending' || t.status === 'acknowledged');
  else if (f.taskStatus !== 'all') list = list.filter(t => t.status === f.taskStatus);
  if (q) list = list.filter(t => [t.name, t.phone, t.reason].some(v => String(v || '').toLowerCase().includes(q)));
  const rows = list.map(t => {
    const appt = App.appointments.get(t.appointment_id);
    const due = t.due_at ? new Date(t.due_at) : null;
    const late = due && due < new Date() && (t.status === 'pending' || t.status === 'acknowledged');
    return `<tr>
      <td><span class="badge ${TASK_TYPE_CLASS[t.type] || ''}">${esc(taskTypeLabel(t.type))}</span><div class="muted">${esc(t.reason || '')}</div></td>
      <td><b>${esc(t.name || '—')}</b><div class="muted">${esc(t.phone || '')}</div></td>
      <td>${appt ? `${esc(serviceById(appt.service_id)?.name || '')}<div class="muted">${esc(appt.start ? fmtDateTime(appt.start) : statusLabel(appt.status))}</div>` : '—'}</td>
      <td class="${late ? '' : ''}">${due ? `${late ? '<span class="badge red">Overdue</span> ' : ''}${esc(fmtStamp(t.due_at))}` : '—'}</td>
      <td><select data-act="taskStatus" data-id="${esc(t.id)}">${taskStatuses().map(s => `<option value="${esc(s.id)}" ${s.id === t.status ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}</select></td>
      <td>${t.call_id && App.calls.has(t.call_id) ? `<button class="textbtn" data-act="openConv" data-id="${esc(t.call_id)}">Conversation</button>` : ''}</td>
    </tr>`;
  }).join('');
  const coverage = App.config.appointment_fields.some(x => x.id === 'insurance_type');
  return pageHead('Tasks', 'Callbacks, urgent callbacks' + (coverage ? ' and coverage checks.' : '.'), `
      <span class="search">${icon('check')}<input type="search" data-filter="taskQ" placeholder="Search tasks" value="${esc(f.taskQ)}"></span>
      <label class="compact-label">Status <select data-filter="taskStatus">
        ${[['open', 'Open'], ['all', 'All'], ...taskStatuses().map(s => [s.id, s.label])].map(([v, l]) => `<option value="${esc(v)}" ${f.taskStatus === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`) + `
    <div class="panel"><div class="panel-head"><h2>Work queue</h2><span class="badge">${list.length}</span></div>
      <div class="table-scroll"><table>
        <tr><th>Task</th><th>${esc(L('customer'))}</th><th>${esc(L('booking'))}</th><th>Due</th><th>Status</th><th></th></tr>
        ${rows || '<tr><td colspan="6" class="empty-row">No tasks.</td></tr>'}
      </table></div></div>
    ${coverage ? `<div class="panel"><div class="panel-head"><h2>Coverage check steps</h2><span class="badge violet">Canadian rules</span></div>
      <div class="grid-2">
        <div class="notice">${icon('book')}<div><b>CDCP</b> · Check eligibility and the co-payment level with Sun Life before every treatment.
          Request preauthorization for services that need it. Tell the patient about the co-payment and any amount above the CDCP fee.</div></div>
        <div class="notice">${icon('book')}<div><b>Private plan</b> · Get the patient's consent to send their data to the plan,
          request a predetermination for larger treatments, and tell the patient their share of the cost.</div></div>
      </div><div class="muted small" style="margin-top:.6rem">The demo contacts no insurer and submits no claims.</div></div>` : ''}`;
}

function viewSchedule() {
  if (!App.date) App.date = startOfDay(new Date());
  const d = App.date;
  const hours = App.schedule.clinic_hours[DAYS[d.getDay()]];
  const actions = `
    <button class="btn sm" data-act="day" data-delta="-1">‹</button>
    <b style="min-width:13rem;text-align:center">${esc(fmtDate(d))}</b>
    <button class="btn sm" data-act="day" data-delta="1">›</button>
    <button class="btn sm ghost" data-act="today">Today</button>`;
  const legend = `<div class="legend">
      <span style="--c: #fff">Free</span><span style="--c: #eef4f9">Booked</span><span style="--c: #fff2dc">Draft</span>
      <span style="--c: #f3f0fa">Busy</span><span style="--c: #eef1f0">Not working</span></div>`;
  const head = pageHead('Schedule', `${esc(L('business'))} schedule and each ${esc(L('resource').toLowerCase())}'s day · ${esc(App.config.clinic.timezone)}`, actions);
  if (!hours) return head + `<div class="panel"><div class="empty"><div class="tile">${icon('cal')}</div><b>Closed</b>${esc(L('closed'))}</div></div>`;

  const docs = App.schedule.doctors;
  const step = App.schedule.slot_step_min;
  const [open, close] = hours.map(toMin);
  const th = `<tr><th>Time</th>${docs.map(doc => `<th>${esc(doc.name)}<div class="muted" style="font-weight:500">${esc([doc.speciality_label, (doc.idOptCols || []).map(columnName).join(', ')].filter(Boolean).join(' · '))}</div></th>`).join('')}</tr>`;
  const blocks = docs.map(doc => ({ doc, w: workRange(doc, d), busy: busyBlocks(doc, d), booked: bookedBlocks(doc.id, d) }));
  let rows = '';
  for (let m = open; m < close; m += step) {
    rows += `<tr><td class="time">${m % 60 === 0 ? fmtMin(m) : ''}</td>`;
    for (const b of blocks) {
      const inside = blk => m >= blk.from && m < blk.to;
      const booked = b.booked.find(inside);
      const busy = b.busy.find(inside);
      if (!b.w || m < b.w[0] || m >= b.w[1]) rows += '<td class="off"></td>';
      else if (booked) {
        const a = booked.appt;
        const label = booked.from === m ? `${a.name || L('customer')} · ${serviceById(a.service_id)?.name || ''}` : '';
        rows += `<td class="booked ${a.status === 'draft' ? 'draft' : ''}" title="${esc(label)}">${esc(label)}</td>`;
      } else if (busy) rows += `<td class="busy">${busy.from === m ? esc(busy.label) : ''}</td>`;
      else rows += '<td class="free"></td>';
    }
    rows += '</tr>';
  }
  return head + `<div class="panel"><div class="panel-head"><h2>Day view</h2>${legend}</div>
    <div class="table-scroll"><table class="sched">${th}${rows}</table></div></div>`;
}

// Booking fields without their own column, e.g. complaint, insurance, address, order items.
function detailsHtml(a) {
  const own = ['name', 'phone', 'service', 'datetime', L('resource_field')];
  const rows = App.config.appointment_fields.filter(f => !own.includes(f.id) && a[f.id] != null && a[f.id] !== '')
    .map(f => `<div><span class="muted">${esc(f.label)}:</span> ${esc(fieldValue(f.id, a[f.id]))}</div>`);
  return rows.join('') || '—';
}

function viewAppointments() {
  const f = App.filters;
  const today = dateKey(new Date());
  const q = f.apptQ.toLowerCase();
  let list = [...App.appointments.values()];
  if (f.appt === 'upcoming') list = list.filter(a => !a.start || a.start.slice(0, 10) >= today);
  else if (f.appt !== 'all') list = list.filter(a => a.status === f.appt);
  if (q) list = list.filter(a => [a.name, a.phone].some(v => String(v || '').toLowerCase().includes(q)));
  list.sort((a, b) => (a.start || '9999').localeCompare(b.start || '9999'));
  const opts = App.config.appointment_statuses;
  const rows = list.map(a => `
    <tr>
      <td>${esc(a.start ? fmtDateTime(a.start) : '—')}</td>
      <td><b>${esc(a.name || '—')}</b><div class="muted">${esc(a.phone || '')}</div></td>
      <td>${esc(serviceById(a.service_id)?.name || a.service_id || '—')}</td>
      <td>${esc(doctorById(a.doctor_id)?.name || (a.doctor_id ? a.doctor_id : 'Assigned later'))}</td>
      <td class="small">${detailsHtml(a)}</td>
      <td><select data-act="status" data-id="${esc(a.id)}">
          ${opts.map(o => `<option value="${o.id}" ${o.id === a.status ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
        </select></td>
    </tr>`).join('');
  return pageHead(L('bookings'), `Booked by the AI assistant or the ${esc(L('admin').toLowerCase())} · ${esc(App.config.clinic.timezone)}`, `
      <span class="search">${icon('user')}<input type="search" data-filter="apptQ" placeholder="Search by name or phone" value="${esc(f.apptQ)}"></span>
      <label class="compact-label">Show <select data-filter="appt">
        ${[['upcoming', 'Upcoming'], ['all', 'All'], ...opts.map(o => [o.id, o.label])].map(([v, l]) => `<option value="${esc(v)}" ${f.appt === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}
      </select></label>`) + `
    <div class="panel"><div class="panel-head"><h2>${esc(L('booking'))} list</h2><span class="badge">${list.length}</span></div>
      <div class="table-scroll"><table>
        <tr><th>Date and time</th><th>${esc(L('customer'))}</th><th>Service</th><th>${esc(L('resource'))}</th><th>Details</th><th>Status</th></tr>
        ${rows || `<tr><td colspan="6" class="empty-row">No ${esc(L('bookings').toLowerCase())} yet.</td></tr>`}
      </table></div></div>`;
}

/* ---------- Live mode: Supabase Realtime, softphone, Deepgram ---------- */

const isLiveConfigured = () => Boolean(CFG.supabaseUrl && CFG.supabaseAnonKey);

function setLiveStatus(text, cls = '') {
  const el = $('#liveStatus');
  el.textContent = text;
  el.className = 'badge ' + cls;
  el.classList.toggle('hidden', !text);
}

// Admin softphone. Twilio: incoming calls carry call_id / transfer parameters.
// Telnyx: the SDK registers as the SIP user of a credential connection; the call has no custom parameters,
// so the page takes the call id from the newest ringing / transferring row of the calls table.
const Softphones = {
  twilio: {
    async init(live) {
      if (!window.Twilio?.Device) await loadScript('https://cdn.jsdelivr.net/npm/@twilio/voice-sdk@2.11.2/dist/twilio.min.js');
      const { token } = await live.fn('twilio-token', { identity: 'admin' });
      const device = new window.Twilio.Device(token, { codecPreferences: ['opus', 'pcmu'] });
      device.on('incoming', call => {
        const callId = call.customParameters.get('call_id');
        const transfer = call.customParameters.get('transfer') === '1';
        live.ringing(call.parameters.From, callId, transfer, () => {
          call.on('accept', () => live.startTranscription(call.getLocalStream(), call.getRemoteStream(), callId).catch(e => { console.error(e); toast('Transcription: ' + e.message); }));
          call.accept();
        }, () => call.reject());
        const clear = () => { App.incoming = null; render(); };
        call.on('cancel', clear);   // timeout: Twilio routes the call to the AI assistant
        call.on('disconnect', () => { clear(); live.stopTranscription(); });
      });
      device.on('tokenWillExpire', async () => device.updateToken((await live.fn('twilio-token', { identity: 'admin' })).token));
      device.on('error', e => toast('Softphone error: ' + e.message));
      await device.register();
      toast('Softphone is ready');
      return { destroy: () => device.destroy() };
    },
  },
  telnyx: {
    async init(live) {
      if (!window.TelnyxWebRTC?.TelnyxRTC) await loadScript('https://unpkg.com/@telnyx/webrtc@2.27.10/lib/bundle.js');
      if (!$('#remoteAudio')) document.body.insertAdjacentHTML('beforeend', '<audio id="remoteAudio" autoplay></audio>');
      const { token } = await live.fn('telnyx-token', {});
      const client = new window.TelnyxWebRTC.TelnyxRTC({ login_token: token });
      client.remoteElement = 'remoteAudio';
      let active = null;
      const clear = () => { App.incoming = null; render(); };
      client.on('telnyx.ready', () => toast('Softphone is ready'));
      client.on('telnyx.error', e => toast('Softphone error: ' + (e?.error?.message || e?.message || 'unknown')));
      client.on('telnyx.notification', n => {
        if (n.type !== 'callUpdate') return;
        const call = n.call;
        if (call.state === 'ringing' && call.direction === 'inbound') {
          const row = [...App.calls.values()]
            .filter(c => c.status !== 'ended' && c.channel !== 'chat' && (c.mode === 'ringing' || c.mode === 'transferring'))
            .sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)))[0];
          live.ringing(call.options.remoteCallerNumber || row?.phone, row?.id, row?.mode === 'transferring',
            () => { active = { call, callId: row?.id }; call.answer(); }, () => call.hangup());
        } else if (call.state === 'active' && active?.call === call && !live.stt) {
          live.startTranscription(call.localStream, call.remoteStream, active.callId).catch(e => { console.error(e); toast('Transcription: ' + e.message); });
        } else if (call.state === 'hangup' || call.state === 'destroy') {
          // Timeout: TeXML routes the call to the AI assistant. Or the call ended.
          if (active?.call === call) { active = null; live.stopTranscription(); }
          clear();
        }
      });
      client.connect();
      return { destroy: () => client.disconnect() };
    },
  },
};

const Live = {
  sb: null, channel: null, device: null, stt: null, fake: null, fakeRing: null, fakeCall: null, takeover: null,

  async start() {
    if (!isLiveConfigured()) { setLiveStatus('Not configured', 'amber'); return; }
    this.sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey);
    setLiveStatus('Connecting…', 'amber');
    try {
      await this.loadInitial();
      this.subscribe();
    } catch (e) {
      console.error(e); setLiveStatus('Error', 'red'); toast(e.message); return;
    }
    if (CFG.enableFakeCall && typeof FakeCall !== 'undefined') {
      this.fake = FakeCall.join(this.sb, (ev, p) => this.onFake(ev, p).catch(e => { console.error(e); toast('Fake call: ' + e.message); }));
    }
    if (CFG.enableSoftphone) {
      const sp = Softphones[CFG.softphone || 'twilio'];
      sp.init(this).then(d => { this.device = d; }).catch(e => { console.error(e); toast('Softphone: ' + e.message); });
    }
  },

  biz: () => App.business?.id || 'dental',

  async loadInitial() {
    const sb = this.sb;
    const biz = this.biz();
    const [data, settings, calls, states, appts, tasks, notes] = await Promise.all([
      sb.from('business_data').select('*').eq('business', biz).maybeSingle(),
      sb.from('business_settings').select('*').eq('business', biz).maybeSingle(),
      sb.from('calls').select('*').eq('business', biz).order('started_at', { ascending: false }).limit(50),
      sb.from('call_state').select('*, calls!inner(business)').eq('calls.business', biz),
      sb.from('appointments').select('*').eq('business', biz).order('start'),
      sb.from('tasks').select('*').eq('business', biz).order('created_at', { ascending: false }).limit(200),
      sb.from('notifications').select('*').eq('business', biz).order('created_at', { ascending: false }).limit(100),
    ]);
    for (const r of [data, settings, calls, states, appts, tasks, notes]) if (r.error) throw new Error(r.error.message);
    this.applyData(data.data);
    this.applySettings(settings.data);
    states.data.forEach(s => delete s.calls);
    calls.data.forEach(c => Store.upsertCall(c));
    states.data.forEach(s => Store.setState(s));
    appts.data.forEach(a => Store.upsertAppointment(a));
    tasks.data.forEach(t => Store.upsertTask(t));
    notes.data.reverse().forEach(n => Store.addNotification(n));
    const ids = calls.data.map(c => c.id);
    if (ids.length) {
      const msgs = await sb.from('call_messages').select('*').in('call_id', ids).order('created_at');
      if (msgs.error) throw new Error(msgs.error.message);
      msgs.data.forEach(m => Store.addMessage(m));
    }
  },

  // Clinic data edited on the page lives in business_data; without a row, the seed files are used.
  applyData(row) {
    const src = row ? { config: row.config, schedule: row.schedule } : clone(App.seed);
    const { config, schedule } = normalizeData(src.config, src.schedule);
    App.config = config; App.schedule = schedule;
    applyBranding();
  },

  applySettings(row) {
    const d = defaultSettings(App.config);
    if (row) {
      d.operation_mode = row.operation_mode; d.admin_availability = row.admin_availability;
      const n = row.notifications || {};
      d.notifications = { ...d.notifications, ...n, events: { ...d.notifications.events, ...(n.events || {}) } };
    }
    App.settings = d;
    render();
  },

  subscribe() {
    // Business rows are filtered by business; messages and states only for conversations shown on this page.
    const on = (table, event, fn, filter) => ['postgres_changes', { event, schema: 'public', table, ...(filter ? { filter } : {}) }, p => p.new && fn(p.new)];
    const mine = fn => r => { if (App.calls.has(r.call_id)) fn(r); };
    const biz = `business=eq.${this.biz()}`;
    this.channel = this.sb.channel('call-desk')
      .on(...on('calls', '*', c => Store.upsertCall(c), biz))
      .on(...on('call_messages', 'INSERT', mine(m => Store.addMessage(m))))
      .on(...on('call_state', '*', mine(s => Store.setState(s))))
      .on(...on('appointments', '*', a => Store.upsertAppointment(a), biz))
      .on(...on('tasks', '*', t => Store.upsertTask(t), biz))
      .on(...on('notifications', 'INSERT', n => Store.addNotification(n), biz))
      .on(...on('business_settings', '*', s => this.applySettings(s), biz))
      .on(...on('business_data', '*', d => { if (!DataEditor.keep) { this.applyData(d); render(); } }, biz))
      .subscribe(status => setLiveStatus(status === 'SUBSCRIBED' ? 'Live' : status, status === 'SUBSCRIBED' ? 'green' : 'amber'));
  },

  async stop() {
    this.stopTranscription();
    if (this.device) { this.device.destroy(); this.device = null; }
    this.endFake();
    if (this.fake) { await this.sb.removeChannel(this.fake); this.fake = null; }
    if (this.channel) { await this.sb.removeChannel(this.channel); this.channel = null; }
    this.sb = null;
    setLiveStatus('');
  },

  async fn(name, body, retried = false) {
    const base = CFG.functionsUrl || `${CFG.supabaseUrl}/functions/v1`;
    let pin = '';
    try { pin = localStorage.getItem('adminPin') || ''; } catch (_) { /* storage unavailable */ }
    const r = await fetch(`${base}/${name}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', Authorization: `Bearer ${CFG.supabaseAnonKey}`,
        apikey: CFG.supabaseAnonKey, 'x-admin-pin': pin,
      },
      body: JSON.stringify(body || {}),
    });
    if (r.status === 401 && !retried) {
      const entered = prompt('Admin PIN');
      if (entered) {
        try { localStorage.setItem('adminPin', entered); } catch (_) { /* storage unavailable */ }
        return this.fn(name, body, true);
      }
    }
    const out = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(out.error || `${name}: HTTP ${r.status}`);
    return out;
  },

  // A call rings the softphone (or the fake caller rings the page).
  ringing(phone, callId, transfer, accept, decline) {
    App.incoming = {
      phone, label: transfer ? 'Handoff from the AI assistant' : 'Incoming call',
      ringUntil: transfer ? null : Date.now() + App.config.clinic.admin_ring_timeout_sec * 1000,
      timeoutText: App.settings.operation_mode === 'copilot' ? 'AI assistant takes a message' : 'AI assistant answers',
      canAnswer: true,
      onAnswer: () => {
        accept(); App.incoming = null;
        if (callId) App.activeCallId = callId;
        go('live');
      },
      onDecline: () => { decline(); App.incoming = null; render(); },
    };
    // The administrator pressed Take over: answer the ring at once.
    if (transfer && callId && callId === this.takeover) {
      this.takeover = null;
      App.incoming.onAnswer();
      return;
    }
    render();
  },

  async startTranscription(localStream, remoteStream, callId) {
    const { key, scheme } = await this.fn('deepgram-token', {});
    const stt = App.config.speech_to_text;
    const params = new URLSearchParams({
      model: stt.model, language: stt.language, encoding: 'linear16', sample_rate: '16000',
      channels: '2', multichannel: 'true', smart_format: 'true', punctuate: 'true',
    });
    stt.keyterms.forEach(k => params.append('keyterm', k));
    const ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, [scheme || 'token', key]);

    const ctx = new AudioContext({ sampleRate: 16000 });
    const merger = ctx.createChannelMerger(2);
    ctx.createMediaStreamSource(localStream).connect(merger, 0, 0);   // channel 0: administrator
    ctx.createMediaStreamSource(remoteStream).connect(merger, 0, 1);  // channel 1: caller
    const proc = ctx.createScriptProcessor(4096, 2, 2);
    merger.connect(proc);
    proc.connect(ctx.destination); // output stays silent; needed to keep the processor running
    proc.onaudioprocess = e => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const l = e.inputBuffer.getChannelData(0), r = e.inputBuffer.getChannelData(1);
      const out = new Int16Array(l.length * 2);
      for (let i = 0; i < l.length; i++) {
        out[2 * i] = Math.max(-1, Math.min(1, l[i])) * 0x7fff;
        out[2 * i + 1] = Math.max(-1, Math.min(1, r[i])) * 0x7fff;
      }
      ws.send(out.buffer);
    };
    ws.onmessage = ev => {
      const d = JSON.parse(ev.data);
      if (d.type !== 'Results' || !d.is_final) return;
      const text = d.channel?.alternatives?.[0]?.transcript;
      if (!text) return;
      const speaker = d.channel_index?.[0] === 0 ? 'admin' : 'caller';
      // The observe function stores the message, the call state and the suggestions; Realtime brings them back.
      this.fn('observe', { call_id: callId, speaker, text }).catch(e => console.error(e));
    };
    const keep = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: 'KeepAlive' })), 8000);
    this.stt = { ws, ctx, keep };
  },

  /* Fake page-to-page call from caller.html (see fakecall.js). The caller page always rings this page;
     the page declines at once when the operation mode lets the AI answer first or no handoff is possible. */
  async onFake(ev, p) {
    const fake = (event, payload = {}) => FakeCall.send(this.fake, event, { call_id: p.call_id, ...payload });
    if (ev === 'ring' && !this.fakeCall && (p.business || 'dental') === this.biz()) {
      const takingOver = p.transfer && p.call_id === this.takeover;
      if (!takingOver && (p.transfer ? !canHandOff() : firstResponder() === 'ai')) {
        fake('decline');
        toast(p.transfer ? `Administrator is ${AVAIL_NAMES[App.settings.admin_availability]}: handoff becomes a callback task`
          : `${MODE_NAMES[App.settings.operation_mode]} · ${AVAIL_NAMES[App.settings.admin_availability]}: the AI assistant answers`);
        return;
      }
      this.fakeRing = p.call_id;
      this.ringing(p.phone, p.call_id, p.transfer,
        () => this.fakeAnswer(p.call_id).catch(e => { console.error(e); toast('Fake call: ' + e.message); }),
        () => { fake('decline'); this.fakeRing = null; });
    } else if (ev === 'cancel' && this.fakeRing === p.call_id) {
      // Timeout: the caller page switches to the AI assistant.
      this.fakeRing = null; App.incoming = null; render();
    } else if (ev === 'offer' && this.fakeCall?.callId === p.call_id) {
      const fc = this.fakeCall;
      fc.pc = FakeCall.peer(fc.mic, remote => {
        FakeCall.play(remote);
        if (!this.stt) this.startTranscription(fc.mic, remote, fc.callId).catch(e => { console.error(e); toast('Transcription: ' + e.message); });
      });
      fake('answer', { sdp: await FakeCall.answer(fc.pc, p.sdp) });
    } else if (ev === 'hangup' && this.fakeCall?.callId === p.call_id) {
      this.endFake();
    }
  },

  async fakeAnswer(callId) {
    const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    this.fakeCall = { callId, mic, pc: null };
    this.fakeRing = null;
    FakeCall.send(this.fake, 'accept', { call_id: callId });
    await this.fn('fake-call', { action: 'answered', call_id: callId });
  },

  endFake() {
    if (!this.fakeCall) return;
    this.stopTranscription();
    FakeCall.close(this.fakeCall.pc, this.fakeCall.mic);
    this.fakeCall = null;
  },

  stopTranscription() {
    if (!this.stt) return;
    const { ws, ctx, keep } = this.stt;
    clearInterval(keep);
    try { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'CloseStream' })); ws.close(); } catch (_) { /* ignore */ }
    ctx.close().catch(() => {});
    this.stt = null;
  },
};

/* ---------- Navigation, mode switching and events ---------- */

function go(view) {
  if (location.hash !== `#/${view}`) location.hash = `#/${view}`;
  else { App.view = view; render(); }
}

function applyBranding() {
  $('#clinicName').textContent = App.config.clinic.name;
  $('#logo').textContent = L('logo');
  $('#navBookings').textContent = L('bookings');
  $('#navData').textContent = `${L('business')} data`;
  $('#grpPractice').textContent = L('business');
  $('#adminName').textContent = L('admin');
  $('#avatar').textContent = L('admin').replace(/[^A-Za-z ]/g, '').split(' ').filter(Boolean).map(w => w[0]).join('').slice(0, 2).toUpperCase() || 'AD';
  document.title = `${App.config.clinic.name} · Call Desk`;
}

async function switchMode(mode) {
  if (mode === App.mode && (mode === 'replay' || Live.sb)) return;
  if (mode === 'live' && !isLiveConfigured()) { toast('Live mode needs supabaseUrl and supabaseAnonKey in config.js'); return; }
  if (typeof Replay !== 'undefined') Replay.stop();
  await Live.stop();
  DataEditor.reset();
  App.mode = mode;
  Store.reset();
  // Replay starts from the seed files; Live loads the database rows.
  const { config, schedule } = normalizeData(...Object.values(clone(App.seed)));
  App.config = config; App.schedule = schedule;
  App.settings = defaultSettings(config);
  applyBranding();
  if (mode === 'live') await Live.start();
  render();
}

// Take over button. Live: the admin function moves the call to the softphone (answered automatically) or joins
// the chat. Replay: the scenario stops and the administrator leads the conversation.
async function takeOver(callId) {
  if (!App.calls.get(callId)) return;
  if (App.mode !== 'live') { Replay.takeover(callId); return; }
  Live.takeover = callId;
  try {
    toast((await Live.fn('admin', { action: 'takeover', call_id: callId })).message || 'Taking over');
  } catch (e) {
    Live.takeover = null;
    toast(e.message);
  }
}

function bindEvents() {
  window.addEventListener('hashchange', () => {
    App.view = location.hash.replace(/^#\/?/, '') || 'live';
    document.body.classList.remove('menu-open');
    render();
  });
  $('#menuBtn').addEventListener('click', () => document.body.classList.toggle('menu-open'));
  $('#modeSwitch').addEventListener('click', e => { const b = e.target.closest('button[data-mode]'); if (b) switchMode(b.dataset.mode); });
  $('#availSelect').addEventListener('change', e => saveSettings({ admin_availability: e.target.value }));
  $('#incoming').addEventListener('click', e => {
    const act = e.target.closest('button')?.dataset.act;
    if (act === 'answer') App.incoming?.onAnswer?.();
    if (act === 'decline') App.incoming?.onDecline?.();
  });
  const view = $('#view');
  view.addEventListener('click', e => {
    const b = e.target.closest('[data-act]');
    if (!b || b.tagName === 'SELECT') return;
    const act = b.dataset.act;
    if (act === 'day') { App.date = addDays(App.date, Number(b.dataset.delta)); render(); }
    if (act === 'today') { App.date = startOfDay(new Date()); render(); }
    if (act === 'open') { App.activeCallId = b.dataset.id; go('live'); }
    if (act === 'toggleConv') { App.openConv = App.openConv === b.dataset.id ? null : b.dataset.id; render(); }
    if (act === 'openConv') { App.openConv = b.dataset.id; go('conversations'); }
    if (act === 'takeover') takeOver(App.activeCallId);
    if (typeof DataEditor !== 'undefined') DataEditor.onClick(b, e);
  });
  view.addEventListener('change', e => {
    const t = e.target;
    if (t.dataset.act === 'status') setAppointmentStatus(t.dataset.id, t.value);
    if (t.dataset.act === 'taskStatus') setTaskStatus(t.dataset.id, t.value);
    if (t.dataset.act === 'switchCall') { App.activeCallId = t.value; render(); }
    if (t.dataset.filter && t.tagName === 'SELECT') { App.filters[t.dataset.filter] = t.value; render(); }
    if (typeof DataEditor !== 'undefined') DataEditor.onChange(t, e);
  });
  view.addEventListener('input', e => {
    const t = e.target;
    if (t.dataset.filter && t.tagName === 'INPUT') {
      App.filters[t.dataset.filter] = t.value;
      clearTimeout(bindEvents.t);
      bindEvents.t = setTimeout(() => { render(); requestAnimationFrame(() => { const el = $(`[data-filter="${t.dataset.filter}"]`); if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }); }, 250);
    }
    if (typeof DataEditor !== 'undefined') DataEditor.onInput(t, e);
  });
  view.addEventListener('submit', e => {
    e.preventDefault();
    if (e.target.dataset.form !== 'chat') return;
    const input = $('#composer');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    Live.fn('admin', { action: 'chat-reply', call_id: App.activeCallId, text }).catch(err => toast(err.message));
  });
  // Refresh timers and ring countdowns once a second.
  setInterval(() => {
    const call = App.calls.get(App.activeCallId);
    if (App.incoming || (App.view === 'live' && call && call.status !== 'ended')) render();
  }, 1000);
}

// Business sets: businesses/index.json lists them; ?biz=<id> picks one (dental by default).
async function loadBusiness() {
  let list = [{ id: 'dental', label: 'Dental clinic', path: '.' }];
  if (CFG.businessSets) list = await fetch('businesses/index.json').then(r => r.json());
  const want = new URLSearchParams(location.search).get('biz') || 'dental';
  const biz = list.find(b => b.id === want) || list[0];
  const get = f => fetch(`${biz.path}/${f}`).then(r => { if (!r.ok) throw new Error(f); return r.json(); });
  const [config, schedule, replay] = await Promise.all([
    get('agent-config.json'), get('schedule.json'), biz.replay ? get('replay.json') : null,
  ]);
  App.seed = { config, schedule };
  Object.assign(App, { business: biz, replay });

  $('#bizWrap').classList.toggle('hidden', list.length < 2);
  const sel = $('#bizSelect');
  sel.innerHTML = list.map(b => `<option value="${esc(b.id)}" ${b.id === biz.id ? 'selected' : ''}>${esc(b.label)}</option>`).join('');
  sel.addEventListener('change', () => {
    const q = new URLSearchParams(location.search);
    q.set('biz', sel.value);
    location.search = q.toString();
  });
}

async function init() {
  try {
    await loadBusiness();
  } catch (e) {
    $('#view').innerHTML = `<div class="panel"><div class="empty"><b>Cannot load agent-config.json or schedule.json</b>Serve the folder over HTTP (GitHub Pages or a local web server).</div></div>`;
    return;
  }
  const q = `?biz=${encodeURIComponent(App.business.id)}`;
  $('#callerLink').href = `caller.html${q}`;
  $('#chatLink').href = `chat.html${q}`;
  $('#callerLink').classList.toggle('hidden', !(CFG.enableFakeCall && typeof FakeCall !== 'undefined'));
  App.view = location.hash.replace(/^#\/?/, '') || 'live';
  bindEvents();
  App.mode = null;
  await switchMode(CFG.defaultMode === 'live' && isLiveConfigured() ? 'live' : 'replay');
  if (typeof Replay !== 'undefined') Replay.setupBar();
}

document.addEventListener('DOMContentLoaded', init);

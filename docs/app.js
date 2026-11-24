'use strict';

/* ---------- State ---------- */

const CFG = window.DEMO_CONFIG || {};

const App = {
  config: null,          // agent-config.json
  schedule: null,        // schedule.json
  calls: new Map(),
  messages: new Map(),   // call_id -> [message]
  states: new Map(),     // call_id -> call state
  appointments: new Map(),
  activeCallId: null,
  view: 'calls',
  date: null,            // schedule view date
  mode: 'replay',
  incoming: null,        // { phone, label, ringUntil, canAnswer, onAnswer, onDecline }
  apptFilter: 'upcoming',
};

/* ---------- Helpers ---------- */

const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const pad = n => String(n).padStart(2, '0');
const toMin = hhmm => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const fmtMin = m => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const dateKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseDate = s => { const [y, m, d] = s.slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d); };
const startOfDay = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const addDays = (d, n) => { const x = startOfDay(d); x.setDate(x.getDate() + n); return x; };
const fmtDate = d => d.toLocaleDateString('en-CA', { weekday: 'long', month: 'long', day: 'numeric' });
const weekday = d => d.toLocaleDateString('en-CA', { weekday: 'long' });
const fmtTime12 = m => {
  let h = Math.floor(m / 60); const mm = m % 60; const ap = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12; return `${h}${mm ? ':' + pad(mm) : ''} ${ap}`;
};
const localIso = (d, min) => `${dateKey(d)}T${fmtMin(min)}`;
const fmtDateTime = s => s ? `${fmtDate(parseDate(s))}, ${fmtTime12(toMin(s.slice(11, 16)))}` : '';
const fmtClock = iso => iso ? new Date(iso).toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit' }) : '';
const fmtDuration = ms => { const s = Math.max(0, Math.floor(ms / 1000)); return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`; };
const nowMin = () => { const n = new Date(); return n.getHours() * 60 + n.getMinutes(); };

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.add('hidden'), 4000);
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('Cannot load ' + src));
    document.head.appendChild(s);
  });
}

/* ---------- Schedule logic ---------- */

const doctorById = id => App.schedule.doctors.find(d => d.id === id);
const serviceById = id => App.config.services.find(s => s.id === id);
const doctorsFor = speciality => App.schedule.doctors.filter(d => d.speciality === speciality);
const columnName = id => App.schedule.columns.find(c => c.idOptCol === id)?.name || `Column ${id}`;

function workRange(doc, date) {
  const r = doc.working_hours[DAYS[date.getDay()]];
  return r ? [toMin(r[0]), toMin(r[1])] : null;
}

function busyBlocks(doc, date) {
  const k = DAYS[date.getDay()];
  return doc.busy.filter(b => b.days.includes(k)).map(b => ({ from: toMin(b.from), to: toMin(b.to), label: b.label }));
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
  return ![...busyBlocks(doc, date), ...bookedBlocks(doc.id, date)].some(b => from < b.to && from + dur > b.from);
}

function freeSlots(doc, date, dur) {
  const w = workRange(doc, date);
  if (!w) return [];
  const out = [];
  for (let m = w[0]; m + dur <= w[1]; m += App.schedule.slot_step_min) if (isFree(doc, date, m, dur)) out.push(m);
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
    App.calls.clear(); App.messages.clear(); App.states.clear(); App.appointments.clear();
    App.activeCallId = null; App.incoming = null;
    render();
  },
  upsertCall(c) {
    const next = { ...(App.calls.get(c.id) || {}), ...c };
    App.calls.set(c.id, next);
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
    const prev = App.states.get(s.call_id) || { fields: {}, visitedStages: [], visitedSteps: [] };
    const next = { ...prev, ...s, fields: { ...prev.fields, ...(s.fields || {}) } };
    next.visitedStages = [...new Set([...prev.visitedStages, s.stage].filter(Boolean))];
    next.visitedSteps = [...new Set([...prev.visitedSteps, s.script_step].filter(Boolean))];
    App.states.set(s.call_id, next);
    render();
  },
  upsertAppointment(a) {
    App.appointments.set(a.id, { ...(App.appointments.get(a.id) || {}), ...a });
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

/* ---------- Views ---------- */

function renderNow() {
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.view === App.view));
  $('#replayBar').classList.toggle('hidden', App.mode !== 'replay');
  renderIncoming();
  const view = $('#view');
  const views = { calls: viewCalls, schedule: viewSchedule, appointments: viewAppointments, history: viewHistory, settings: viewSettings };
  view.innerHTML = views[App.view]();
  if (App.view === 'calls') {
    const box = $('.messages', view);
    if (box) box.scrollTop = box.scrollHeight;
  }
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
    <span>${esc(inc.phone)}</span>
    ${left !== null ? `<span class="muted">AI assistant answers in ${left} s</span>` : ''}
    <span class="spacer"></span>
    ${inc.canAnswer ? `<button class="primary" data-act="answer">Answer</button><button class="danger" data-act="decline">Decline</button>` : ''}`;
}

const SPEAKER = { ai: 'AI Assistant', caller: 'Caller', admin: 'Administrator', system: '' };
const MODE_LABEL = {
  ringing: ['Ringing', 'warn'],
  ai: ['AI assistant is talking', 'accent'],
  admin: ['Administrator is talking', 'ok'],
  transferring: ['Transferring to administrator', 'bad'],
};
const STATUS_CLASS = { draft: 'warn', filled: 'accent', completed: 'ok', cancelled: 'bad', missed: 'bad' };
const statusLabel = id => App.config.appointment_statuses.find(s => s.id === id)?.label || id || '';
const reasonLabel = id => App.config.handoff.triggers.find(t => t.id === id)?.description || id;

function fieldValue(id, v) {
  if (v == null || v === '') return '';
  if (id === 'service') return serviceById(v)?.name || v;
  if (id === 'doctor') return doctorById(v)?.name || v;
  if (id === 'datetime') return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) ? fmtDateTime(v) : v;
  if (id === 'patient_type') return v === 'new' ? 'New patient' : v === 'returning' ? 'Returning patient' : v;
  return v;
}

function messagesHtml(callId) {
  const list = App.messages.get(callId) || [];
  if (!list.length) return '<div class="muted">No messages yet.</div>';
  return list.map(m => m.speaker === 'system'
    ? `<div class="msg system">${esc(m.text)}</div>`
    : `<div class="msg ${esc(m.speaker)}"><div class="who">${esc(SPEAKER[m.speaker] || m.speaker)}</div>${esc(m.text)}</div>`
  ).join('');
}

function viewCalls() {
  const call = App.calls.get(App.activeCallId);
  if (!call) {
    return `<div class="empty">
      <h2>No active call</h2>
      <div>${App.mode === 'replay'
        ? 'Start a scripted call from the Replay bar above.'
        : 'Waiting for incoming calls. The live call page opens automatically.'}</div>
    </div>`;
  }
  const st = App.states.get(call.id) || { fields: {}, visitedStages: [], visitedSteps: [] };
  const cfg = App.config;
  const [modeText, modeCls] = call.status === 'ended' ? ['Call ended', ''] : (MODE_LABEL[call.mode] || [call.mode, '']);
  const end = call.ended_at ? new Date(call.ended_at) : new Date();
  const appt = [...App.appointments.values()].find(a => a.call_id === call.id);
  const reason = st.handoff_reason || call.handoff_reason;

  const stages = cfg.funnel_stages.filter(s => s.id !== 'handoff').map(s => {
    const cls = s.id === st.stage ? 'current' : st.visitedStages.includes(s.id) ? 'done' : '';
    return `<span class="stage ${cls}">${esc(s.label)}</span>`;
  }).join('');

  const fields = cfg.appointment_fields.map(f => {
    const v = fieldValue(f.id, st.fields[f.id]);
    const cls = v ? 'filled' : f.required ? 'missing' : 'optional';
    const mark = v ? '✓' : f.required ? '!' : '–';
    const shown = v || (f.required ? 'missing' : 'optional');
    return `<div class="field ${cls}"><span class="mark">${mark}</span><span class="label">${esc(f.label)}</span><span class="value">${esc(shown)}</span></div>`;
  }).join('');

  const script = cfg.script.map(s => {
    const cls = s.step === st.script_step ? 'current' : st.visitedSteps.includes(s.step) ? 'done' : '';
    const stageLabel = cfg.funnel_stages.find(x => x.id === s.stage)?.label || s.stage;
    const text = (s.say || s.goal).replace('{caller_phone}', call.phone);
    return `<li class="${cls}"><div class="step-stage">${esc(stageLabel)}</div>${esc(text)}</li>`;
  }).join('');

  return `
    <div class="call-head">
      <span class="phone">${esc(call.phone)}</span>
      <span class="pill ${modeCls}">${esc(modeText)}</span>
      <span class="timer">${fmtDuration(end - new Date(call.started_at))}</span>
      ${appt ? `<span class="pill ${STATUS_CLASS[appt.status] || ''}">Appointment: ${esc(statusLabel(appt.status))}</span>` : ''}
    </div>
    ${reason ? `<div class="banner"><b>Handoff:</b> ${esc(reasonLabel(reason))}</div>` : ''}
    <div class="call-grid">
      <div class="call-side">
        <div class="panel"><h3>Funnel stage</h3><div class="stages">${stages}</div></div>
        <div class="panel"><h3>Appointment fields</h3><div class="fields">${fields}</div></div>
        <div class="panel"><h3>Script</h3><ul class="script">${script}</ul></div>
      </div>
      <div class="panel transcript"><h3>Conversation</h3><div class="messages">${messagesHtml(call.id)}</div></div>
    </div>`;
}

function viewSchedule() {
  if (!App.date) App.date = startOfDay(new Date());
  const d = App.date;
  const hours = App.schedule.clinic_hours[DAYS[d.getDay()]];
  const toolbar = `
    <div class="toolbar">
      <button data-act="day" data-delta="-1">‹</button>
      <span class="date">${esc(fmtDate(d))}</span>
      <button data-act="day" data-delta="1">›</button>
      <button data-act="today" class="ghost">Today</button>
      <div class="legend">
        <span style="--c: var(--surface)">Free</span>
        <span style="--c: var(--accent-soft)">Booked</span>
        <span style="--c: var(--warn-soft)">Busy</span>
        <span style="--c: var(--surface-2)">Not working</span>
      </div>
    </div>`;
  if (!hours) return `<h2>Schedule</h2>${toolbar}<div class="empty">The clinic is closed on this day.</div>`;

  const docs = App.schedule.doctors;
  const step = App.schedule.slot_step_min;
  const [open, close] = hours.map(toMin);
  const head = `<tr><th>Time</th>${docs.map(doc => `<th>${esc(doc.name)}<div class="muted">${esc(doc.speciality_label)} · ${esc(doc.idOptCols.map(columnName).join(', '))}</div></th>`).join('')}</tr>`;
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
        const label = booked.from === m ? `${a.name || 'Patient'} · ${serviceById(a.service_id)?.name || ''}${a.status === 'draft' ? ' (draft)' : ''}` : '';
        rows += `<td class="booked" title="${esc(label)}">${esc(label)}</td>`;
      } else if (busy) rows += `<td class="busy">${busy.from === m ? esc(busy.label) : ''}</td>`;
      else rows += '<td class="free"></td>';
    }
    rows += '</tr>';
  }
  return `<h2>Schedule</h2>${toolbar}<div class="panel grid-wrap"><table class="sched">${head}${rows}</table></div>`;
}

function viewAppointments() {
  const today = dateKey(new Date());
  let list = [...App.appointments.values()];
  if (App.apptFilter === 'upcoming') list = list.filter(a => !a.start || a.start.slice(0, 10) >= today);
  list.sort((a, b) => (a.start || '9999').localeCompare(b.start || '9999'));
  const opts = App.config.appointment_statuses;
  const rows = list.map(a => `
    <tr>
      <td>${esc(a.start ? fmtDateTime(a.start) : '—')}</td>
      <td>${esc(a.name || '—')}<div class="muted">${esc(a.phone || '')}</div></td>
      <td>${esc(serviceById(a.service_id)?.name || a.service_id || '—')}<div class="muted">${esc(a.complaint || '')}</div></td>
      <td>${esc(doctorById(a.doctor_id)?.name || (a.doctor_id ? a.doctor_id : 'Assigned later'))}</td>
      <td>${esc(a.patient_type === 'new' ? 'New' : a.patient_type === 'returning' ? 'Returning' : '—')}${a.insurance_number ? `<div class="muted">Ins. ${esc(a.insurance_number)}</div>` : ''}</td>
      <td>
        <select class="status" data-act="status" data-id="${esc(a.id)}">
          ${opts.map(o => `<option value="${o.id}" ${o.id === a.status ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
        </select>
      </td>
    </tr>`).join('');
  return `
    <h2>Appointments</h2>
    <div class="toolbar">
      <select data-act="apptFilter">
        <option value="upcoming" ${App.apptFilter === 'upcoming' ? 'selected' : ''}>Upcoming</option>
        <option value="all" ${App.apptFilter === 'all' ? 'selected' : ''}>All</option>
      </select>
    </div>
    ${list.length ? `<div class="panel grid-wrap"><table class="list">
      <tr><th>Date and time</th><th>Patient</th><th>Service</th><th>Doctor</th><th>Patient type</th><th>Status</th></tr>${rows}
    </table></div>` : '<div class="empty">No appointments yet.</div>'}`;
}

function viewHistory() {
  const calls = [...App.calls.values()].sort((a, b) => (b.started_at || '').localeCompare(a.started_at || ''));
  if (!calls.length) return '<h2>Call history</h2><div class="empty">No calls yet.</div>';
  const OUTCOME = { booked: 'Appointment booked', handoff: 'Handed off', callback: 'Call-back promised', rescheduled: 'Rescheduled', cancelled: 'Cancelled' };
  const items = calls.map(c => {
    const appt = [...App.appointments.values()].find(a => a.call_id === c.id);
    return `<div class="panel item">
      <div class="row">
        <b>${esc(c.phone)}</b>
        <span class="muted">${esc(c.started_at ? new Date(c.started_at).toLocaleString('en-CA') : '')}</span>
        ${c.ended_at ? `<span class="muted">${fmtDuration(new Date(c.ended_at) - new Date(c.started_at))}</span>` : '<span class="pill warn">In progress</span>'}
        ${c.outcome ? `<span class="pill">${esc(OUTCOME[c.outcome] || c.outcome)}</span>` : ''}
        ${c.handoff_reason ? `<span class="pill bad">${esc(reasonLabel(c.handoff_reason))}</span>` : ''}
        ${appt ? `<span class="pill ${STATUS_CLASS[appt.status] || ''}">${esc(statusLabel(appt.status))}</span>` : ''}
        <span class="spacer" style="flex:1"></span>
        <button data-act="open" data-id="${esc(c.id)}">Open call page</button>
      </div>
      ${c.recording_url ? `<audio controls preload="none" src="${esc(c.recording_url)}"></audio>` : ''}
      <details><summary>Transcript</summary><div class="messages">${messagesHtml(c.id)}</div></details>
    </div>`;
  }).join('');
  return `<h2>Call history</h2><div class="history">${items}</div>`;
}

function viewSettings() {
  const c = App.config;
  const faq = c.knowledge_base.faq.map(f => `<dt>${esc(f.q)}</dt><dd>${esc(f.a)}</dd>`).join('');
  const services = c.services.map(s => `<tr>
    <td>${esc(s.name)}</td><td>${s.urgent ? '<span class="pill bad">Urgent</span>' : 'No'}</td>
    <td>${esc(c.clinic.currency)} ${s.price_min}–${s.price_max}</td><td>${s.duration_min} min</td><td>${esc(s.speciality)}</td></tr>`).join('');
  const doctors = App.schedule.doctors.map(d => `<tr>
    <td>${esc(d.name)}</td><td>${esc(d.speciality_label)}</td><td>${esc(d.idOptCols.map(columnName).join(', '))}</td>
    <td>${esc(Object.entries(d.working_hours).map(([k, v]) => `${k} ${v[0]}–${v[1]}`).join(', '))}</td></tr>`).join('');
  const rules = c.rules;
  return `
    <h2>AI assistant settings</h2>
    <p class="muted">Read-only view. The settings are edited in agent-config.json and schedule.json in the repository; a deploy script pushes them to Vapi.</p>
    <div class="settings">
      <div class="panel"><h3>Clinic</h3>
        <div>${esc(c.clinic.name)}</div>
        <div class="muted">Language: ${esc(c.clinic.language)} · Time zone: ${esc(c.clinic.timezone)} · Admin ring timeout: ${c.clinic.admin_ring_timeout_sec} s</div>
      </div>
      <div class="panel"><h3>Handoff triggers</h3>
        <ul class="plain">${c.handoff.triggers.map(t => `<li>${esc(t.description)}</li>`).join('')}</ul>
      </div>
      <div class="panel wide"><h3>Services</h3><div class="grid-wrap"><table class="list">
        <tr><th>Name</th><th>Urgent</th><th>Price range</th><th>Duration</th><th>Speciality</th></tr>${services}</table></div></div>
      <div class="panel wide"><h3>Doctors</h3><div class="grid-wrap"><table class="list">
        <tr><th>Doctor</th><th>Speciality</th><th>Columns</th><th>Working hours</th></tr>${doctors}</table></div></div>
      <div class="panel"><h3>Knowledge base · FAQ</h3><dl class="faq">${faq}</dl></div>
      <div class="panel"><h3>Rules</h3><ul class="plain">
        <li>${esc(rules.no_medical_advice)}</li>
        ${rules.slot_selection.map(r => `<li>${esc(r)}</li>`).join('')}
        <li>${esc(rules.doctor_choice)}</li>
        <li>${esc(rules.booking)}</li>
      </ul></div>
    </div>`;
}

/* ---------- Live mode: Supabase Realtime, Twilio softphone, Deepgram ---------- */

const isLiveConfigured = () => Boolean(CFG.supabaseUrl && CFG.supabaseAnonKey);

function setLiveStatus(text, cls = '') {
  const el = $('#liveStatus');
  el.textContent = text;
  el.className = 'pill ' + cls;
}

const Live = {
  sb: null, channel: null, device: null, stt: null,

  async start() {
    if (!isLiveConfigured()) { setLiveStatus('Not configured', 'warn'); return; }
    this.sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey);
    setLiveStatus('Connecting…', 'warn');
    try {
      await this.loadInitial();
      this.subscribe();
    } catch (e) {
      console.error(e); setLiveStatus('Error', 'bad'); toast(e.message); return;
    }
    if (CFG.enableSoftphone) this.initSoftphone().catch(e => { console.error(e); toast('Softphone: ' + e.message); });
  },

  async loadInitial() {
    const sb = this.sb;
    const [calls, states, appts] = await Promise.all([
      sb.from('calls').select('*').order('started_at', { ascending: false }).limit(50),
      sb.from('call_state').select('*'),
      sb.from('appointments').select('*').order('start'),
    ]);
    for (const r of [calls, states, appts]) if (r.error) throw new Error(r.error.message);
    calls.data.forEach(c => Store.upsertCall(c));
    states.data.forEach(s => Store.setState(s));
    appts.data.forEach(a => Store.upsertAppointment(a));
    const ids = calls.data.map(c => c.id);
    if (ids.length) {
      const msgs = await sb.from('call_messages').select('*').in('call_id', ids).order('created_at');
      if (msgs.error) throw new Error(msgs.error.message);
      msgs.data.forEach(m => Store.addMessage(m));
    }
  },

  subscribe() {
    const on = (table, event, fn) => ['postgres_changes', { event, schema: 'public', table }, p => p.new && fn(p.new)];
    this.channel = this.sb.channel('call-desk')
      .on(...on('calls', '*', c => Store.upsertCall(c)))
      .on(...on('call_messages', 'INSERT', m => Store.addMessage(m)))
      .on(...on('call_state', '*', s => Store.setState(s)))
      .on(...on('appointments', '*', a => Store.upsertAppointment(a)))
      .subscribe(status => setLiveStatus(status === 'SUBSCRIBED' ? 'Live' : status, status === 'SUBSCRIBED' ? 'ok' : 'warn'));
  },

  async stop() {
    this.stopTranscription();
    if (this.device) { this.device.destroy(); this.device = null; }
    if (this.channel) { await this.sb.removeChannel(this.channel); this.channel = null; }
    this.sb = null;
    setLiveStatus('');
  },

  async fn(name, body) {
    const base = CFG.functionsUrl || `${CFG.supabaseUrl}/functions/v1`;
    const r = await fetch(`${base}/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CFG.supabaseAnonKey}`, apikey: CFG.supabaseAnonKey },
      body: JSON.stringify(body || {}),
    });
    if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
    return r.json();
  },

  async initSoftphone() {
    if (!window.Twilio?.Device) await loadScript('https://cdn.jsdelivr.net/npm/@twilio/voice-sdk@2.11.2/dist/twilio.min.js');
    const { token } = await this.fn('twilio-token', { identity: 'admin' });
    const device = new window.Twilio.Device(token, { codecPreferences: ['opus', 'pcmu'] });
    device.on('incoming', call => this.onIncoming(call));
    device.on('tokenWillExpire', async () => device.updateToken((await this.fn('twilio-token', { identity: 'admin' })).token));
    device.on('error', e => toast('Softphone error: ' + e.message));
    await device.register();
    this.device = device;
    toast('Softphone is ready');
  },

  onIncoming(call) {
    const callId = call.customParameters.get('call_id');
    const transfer = call.customParameters.get('transfer') === '1';
    App.incoming = {
      phone: call.parameters.From,
      label: transfer ? 'Transfer from AI assistant' : 'Incoming call',
      ringUntil: transfer ? null : Date.now() + App.config.clinic.admin_ring_timeout_sec * 1000,
      canAnswer: true,
      onAnswer: () => this.answer(call, callId),
      onDecline: () => { call.reject(); App.incoming = null; render(); },
    };
    const clear = () => { App.incoming = null; render(); };
    call.on('cancel', clear);   // timeout: Twilio routes the call to the AI assistant
    call.on('disconnect', () => { clear(); this.stopTranscription(); });
    render();
  },

  answer(call, callId) {
    call.on('accept', () => this.startTranscription(call, callId).catch(e => { console.error(e); toast('Transcription: ' + e.message); }));
    call.accept();
    App.incoming = null;
    if (callId) App.activeCallId = callId;
    App.view = 'calls';
    render();
  },

  async startTranscription(call, callId) {
    const { key } = await this.fn('deepgram-token', {});
    const stt = App.config.speech_to_text;
    const params = new URLSearchParams({
      model: stt.model, language: stt.language, encoding: 'linear16', sample_rate: '16000',
      channels: '2', multichannel: 'true', smart_format: 'true', punctuate: 'true',
    });
    stt.keyterms.forEach(k => params.append('keyterm', k));
    const ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, ['token', key]);

    const ctx = new AudioContext({ sampleRate: 16000 });
    const merger = ctx.createChannelMerger(2);
    ctx.createMediaStreamSource(call.getLocalStream()).connect(merger, 0, 0);   // channel 0: administrator
    ctx.createMediaStreamSource(call.getRemoteStream()).connect(merger, 0, 1);  // channel 1: caller
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
      // The observe function stores the message and the call state; Realtime brings both back to the page.
      this.fn('observe', { call_id: callId, speaker, text }).catch(e => console.error(e));
    };
    const keep = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: 'KeepAlive' })), 8000);
    this.stt = { ws, ctx, keep };
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

/* ---------- Mode switching and events ---------- */

async function switchMode(mode) {
  if (mode === 'live' && !isLiveConfigured()) {
    toast('Live mode needs supabaseUrl and supabaseAnonKey in config.js');
    $('#modeSelect').value = App.mode;
    return;
  }
  if (window.Replay) Replay.stop();
  await Live.stop();
  App.mode = mode;
  $('#modeSelect').value = mode;
  Store.reset();
  if (mode === 'live') await Live.start();
  render();
}

function bindEvents() {
  $('#tabs').addEventListener('click', e => {
    const b = e.target.closest('button[data-view]');
    if (b) { App.view = b.dataset.view; render(); }
  });
  $('#modeSelect').addEventListener('change', e => switchMode(e.target.value));
  $('#incoming').addEventListener('click', e => {
    const act = e.target.closest('button')?.dataset.act;
    if (act === 'answer') App.incoming?.onAnswer?.();
    if (act === 'decline') App.incoming?.onDecline?.();
  });
  $('#view').addEventListener('click', e => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    if (b.dataset.act === 'day') { App.date = addDays(App.date, Number(b.dataset.delta)); render(); }
    if (b.dataset.act === 'today') { App.date = startOfDay(new Date()); render(); }
    if (b.dataset.act === 'open') { App.activeCallId = b.dataset.id; App.view = 'calls'; render(); }
  });
  $('#view').addEventListener('change', e => {
    const t = e.target;
    if (t.dataset.act === 'status') setAppointmentStatus(t.dataset.id, t.value);
    if (t.dataset.act === 'apptFilter') { App.apptFilter = t.value; render(); }
  });
  // Refresh timers and ring countdowns once a second.
  setInterval(() => {
    const call = App.calls.get(App.activeCallId);
    if (App.incoming || (App.view === 'calls' && call && call.status !== 'ended')) render();
  }, 1000);
}

async function init() {
  try {
    const [config, schedule] = await Promise.all([
      fetch('agent-config.json').then(r => r.json()),
      fetch('schedule.json').then(r => r.json()),
    ]);
    App.config = config;
    App.schedule = schedule;
  } catch (e) {
    $('#view').innerHTML = `<div class="empty">Cannot load agent-config.json or schedule.json. Serve the folder over HTTP (GitHub Pages or a local web server).</div>`;
    return;
  }
  $('#clinicName').textContent = App.config.clinic.name;
  document.title = `${App.config.clinic.name} · Call Desk`;
  bindEvents();
  await switchMode(CFG.defaultMode === 'live' && isLiveConfigured() ? 'live' : 'replay');
}

document.addEventListener('DOMContentLoaded', init);

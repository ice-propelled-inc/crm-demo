'use strict';

/*
 * AI assistant settings (operation mode, availability, notifications) and the clinic data editor
 * (profile and hours, doctors, services, knowledge base). Replay mode keeps changes in memory;
 * Live mode saves them through the admin Edge Function, which also rebuilds the prompt and pushes it to Vapi.
 */

const MODE_TEXT = {
  copilot: { tag: 'Staff-led', text: 'Calls ring the administrator, who leads; the AI shows intake and suggestions. No answer: the AI takes a message and creates a callback task. It does not book.' },
  overflow: { tag: 'Availability-based', text: 'Available: the call rings the administrator first, then the AI answers. Busy or Offline: the AI answers at once.' },
  autonomous: { tag: 'AI-led', text: 'The AI answers every call and chat at once and books by itself. The administrator can watch the live page.' },
};
const EVENT_LABEL = { booked: 'Booked', rescheduled: 'Rescheduled', cancelled: 'Cancelled', reminder: 'Reminder' };

function routingText() {
  const s = App.settings;
  const ring = App.config.clinic.admin_ring_timeout_sec;
  const chat = App.config.clinic.chat_timeout_sec ?? 30;
  if (firstResponder() === 'ai') return `New calls and chats go to the AI assistant at once.${canHandOff() ? '' : ' Handoffs become callback tasks.'}`;
  if (s.operation_mode === 'copilot') return `Calls ring the ${L('admin').toLowerCase()} for ${ring} s, chats wait ${chat} s. With no answer the AI takes a message and creates a callback task.`;
  return `Calls ring the ${L('admin').toLowerCase()} for ${ring} s, chats wait ${chat} s; then the AI assistant answers and books.`;
}

function viewAssistant() {
  const s = App.settings;
  const n = DataEditor.notif || (DataEditor.notif = clone(s.notifications));
  const modes = (App.config.settings?.operation_modes || Object.keys(MODE_TEXT).map(id => ({ id, label: MODE_NAMES[id] }))).map(m => `
    <button class="mode-card ${s.operation_mode === m.id ? 'selected' : ''}" data-act="setMode" data-mode="${esc(m.id)}">
      <span class="radio"></span><b>${esc(m.label || MODE_NAMES[m.id])}</b>
      <span class="badge ${s.operation_mode === m.id ? 'teal' : ''}">${esc(MODE_TEXT[m.id]?.tag || '')}</span>
      <p>${esc(MODE_TEXT[m.id]?.text || m.call || '')}</p>
      ${m.chat ? `<p><b style="font-size:.78rem;color:var(--muted)">Chat:</b> ${esc(m.chat)}</p>` : ''}
    </button>`).join('');
  const events = Object.keys(EVENT_LABEL).map(ev => {
    const e = n.events?.[ev] || { enabled: false, template: '' };
    return `<div class="notif-row">
      <label class="checkline"><input type="checkbox" data-notif="${ev}.enabled" ${e.enabled ? 'checked' : ''}> ${EVENT_LABEL[ev]}</label>
      <div style="display:grid;gap:.35rem">
        <textarea data-notif="${ev}.template" rows="2">${esc(e.template || '')}</textarea>
        ${ev === 'reminder' ? `<label class="compact-label">Hours before the visit <input type="number" min="1" max="168" data-notif="reminder.hours_before" value="${esc(e.hours_before ?? 24)}" style="width:80px"></label>` : ''}
      </div></div>`;
  }).join('');
  const rules = Object.values(App.config.rules).flatMap(v => Array.isArray(v) ? v : [v]);
  return pageHead('AI assistant', 'How the assistant handles calls and chats, and what it tells the patient.') + `
    <div class="panel"><div class="panel-head"><h2>Operation mode</h2><span class="badge green">${esc(MODE_NAMES[s.operation_mode])}</span></div>
      <div class="mode-cards">${modes}</div></div>
    <div class="grid-2" style="margin-top:12px">
      <div class="stack">
        <div class="panel"><div class="panel-head"><h2>Routing</h2><span class="badge ${canHandOff() ? 'green' : 'amber'}">${esc(AVAIL_NAMES[s.admin_availability])}</span></div>
          <div class="form-grid">
            <label class="field"><span>${esc(L('admin'))} availability</span>
              <select data-act="avail">${Object.entries(AVAIL_NAMES).map(([v, l]) => `<option value="${v}" ${s.admin_availability === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
          </div>
          <dl class="facts" style="margin-top:.8rem">
            <dt>Ring timeout</dt><dd>${esc(App.config.clinic.admin_ring_timeout_sec)} s (calls)</dd>
            <dt>Chat timeout</dt><dd>${esc(App.config.clinic.chat_timeout_sec ?? 30)} s</dd>
          </dl>
          <div class="notice" style="margin-top:.8rem">${icon('wave')}<div>${esc(routingText())}</div></div>
        </div>
        <div class="panel"><div class="panel-head"><h2>Guardrails</h2><span class="badge violet">Read-only</span></div>
          <h3>Handoff triggers</h3><ul class="plain">${App.config.handoff.triggers.map(t => `<li>${esc(t.description)}</li>`).join('')}</ul>
          <h3 style="margin-top:.8rem">Rules</h3><ul class="plain">${rules.map(r => `<li>${esc(r)}</li>`).join('')}</ul></div>
      </div>
      <div class="panel"><div class="panel-head"><h2>Notifications</h2><span class="badge ${n.channel === 'off' ? '' : 'green'}">${n.channel === 'off' ? 'Off' : n.channel.toUpperCase()}</span></div>
        <label class="field" style="max-width:220px"><span>Channel</span>
          <select data-notif="channel">${['off', 'sms', 'email'].map(c => `<option value="${c}" ${n.channel === c ? 'selected' : ''}>${c === 'off' ? 'Off' : c.toUpperCase()}</option>`).join('')}</select></label>
        <div class="muted small" style="margin:.5rem 0 .3rem">Template fields: {name}, {service}, {doctor}, {date}, {time}, {clinic.name}. Email needs an email address in the ${esc(L('booking').toLowerCase())} details.</div>
        ${events}
        <div class="toolbar" style="justify-content:flex-end;margin-top:.6rem">
          <button class="btn ghost" data-act="resetNotif">Discard</button>
          <button class="btn primary" data-act="saveNotif">Save notifications</button>
        </div>
      </div>
    </div>`;
}

/* ---------- Clinic data editor ---------- */

const DataEditor = {
  draft: null,     // { config, schedule } being edited
  keep: false,     // true while there are unsaved changes: renders do not replace the inputs
  tab: 'profile',
  notif: null,     // notifications being edited on the AI assistant page

  reset() { this.draft = null; this.keep = false; this.notif = null; },
  start() { if (!this.draft) this.draft = clone({ config: App.config, schedule: App.schedule }); return this.draft; },
  rerender() { const v = $('#view'); v.innerHTML = viewData(); },

  set(path, value) {
    const d = this.start();
    const keys = path.split('.');
    let o = d;
    keys.slice(0, -1).forEach((k, i) => { if (o[k] == null) o[k] = /^\d+$/.test(keys[i + 1]) ? [] : {}; o = o[k]; });
    o[keys.at(-1)] = value;
    this.keep = true;
    $('#dirty')?.classList.remove('hidden');
  },

  read(t) {
    if (t.dataset.type === 'number') return t.value === '' ? null : Number(t.value);
    if (t.dataset.type === 'bool') return t.checked;
    if (t.dataset.type === 'hours') return parseHours(t.value);
    return t.value;
  },

  onInput(t) { if (t.dataset.path && t.type !== 'checkbox' && t.tagName !== 'SELECT') this.set(t.dataset.path, this.read(t)); },

  onChange(t) {
    if (t.dataset.path && (t.type === 'checkbox' || t.tagName === 'SELECT')) this.set(t.dataset.path, this.read(t));
    if (t.dataset.act === 'avail') saveSettings({ admin_availability: t.value });
    if (t.dataset.notif) {
      const n = this.notif || (this.notif = clone(App.settings.notifications));
      const [ev, key] = t.dataset.notif.split('.');
      if (!key) n.channel = t.value;
      else {
        n.events = n.events || {};
        n.events[ev] = n.events[ev] || { enabled: false, template: '' };
        n.events[ev][key] = t.type === 'checkbox' ? t.checked : t.type === 'number' ? Number(t.value) : t.value;
      }
      if (!key) render();
    }
  },

  async onClick(b) {
    const act = b.dataset.act;
    if (act === 'setMode') saveSettings({ operation_mode: b.dataset.mode });
    if (act === 'saveNotif') {
      // Textareas fire change only on blur; read them all before saving.
      document.querySelectorAll('[data-notif]').forEach(el => this.onChange(el));
      if (await saveSettings({ notifications: clone(this.notif) })) { this.notif = null; toast('Notifications saved'); render(); }
    }
    if (act === 'resetNotif') { this.notif = null; render(); }
    if (act === 'dataTab') { this.tab = b.dataset.tab; this.rerender(); }
    if (act === 'addRow') { addRow(this.start(), b.dataset.list); this.keep = true; this.rerender(); }
    if (act === 'delRow') { const d = this.start(); listAt(d, b.dataset.list).splice(Number(b.dataset.i), 1); this.keep = true; this.rerender(); }
    if (act === 'discardData') { this.reset(); render(); }
    if (act === 'saveData') await this.save();
    if (act === 'seedData') await this.resetToSeed();
  },

  async save() {
    const d = this.start();
    const err = finishDraft(d);
    if (err) { toast(err); return; }
    if (App.mode === 'live') {
      try {
        const out = await Live.fn('admin', { action: 'data', business: Live.biz(), config: d.config, schedule: d.schedule });
        toast(`Saved. Vapi: ${out.vapi}`);
      } catch (e) { toast('Cannot save: ' + e.message); return; }
    } else {
      toast('Saved for this replay session. In Live mode the prompt is rebuilt and pushed to Vapi.');
    }
    const { config, schedule } = normalizeData(d.config, d.schedule);
    App.config = config; App.schedule = schedule;
    applyBranding();
    this.reset();
    render();
  },

  async resetToSeed() {
    if (!confirm('Replace the clinic data with the seed files published with the page?')) return;
    if (App.mode === 'live') {
      try { const out = await Live.fn('admin', { action: 'reset-data', business: Live.biz() }); toast(`Reset. Vapi: ${out.vapi}`); }
      catch (e) { toast('Cannot reset: ' + e.message); return; }
    }
    const { config, schedule } = normalizeData(...Object.values(clone(App.seed)));
    App.config = config; App.schedule = schedule;
    applyBranding();
    this.reset();
    render();
  },
};

const listAt = (d, path) => path.split('.').reduce((o, k) => o[k], d);

function addRow(d, list) {
  const arr = listAt(d, list);
  if (list === 'config.services') arr.push({ id: '', name: '', urgent: false, price_min: 0, price_max: 0, duration_min: 30, speciality: d.schedule.doctors[0]?.speciality || 'general' });
  if (list === 'config.knowledge_base.faq') arr.push({ q: '', a: '' });
  if (list === 'schedule.doctors') arr.push({ id: '', name: '', speciality: 'general', speciality_label: 'General', working_hours: {}, busy: [] });
}

const slug = s => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);

// "mon 09:00-17:00; tue 09:00-17:00" <-> { mon: ["09:00", "17:00"], ... }
const fmtHours = wh => DAYS.slice(1).concat('sun').filter(d => wh?.[d]).map(d => `${d} ${wh[d][0]}-${wh[d][1]}`).join('; ');
function parseHours(text) {
  const out = {};
  for (const part of String(text).split(/[;,\n]/)) {
    const m = part.trim().toLowerCase().match(/^([a-z]{3})\w*\s+(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})$/);
    if (m && DAYS.includes(m[1])) out[m[1]] = [m[2].padStart(5, '0'), m[3].padStart(5, '0')];
  }
  return out;
}

// Check the draft and fill ids before saving. Returns an error text or null.
function finishDraft(d) {
  const c = d.config, s = d.schedule;
  if (!c.clinic.name?.trim()) return 'The name is required';
  for (const svc of c.services) {
    if (!svc.name?.trim()) return 'Every service needs a name';
    if (!svc.id) svc.id = slug(svc.name);
    if (!(svc.duration_min > 0)) return `Duration of "${svc.name}" must be more than 0`;
  }
  for (const doc of s.doctors) {
    if (!doc.name?.trim()) return `Every ${L('resource').toLowerCase()} needs a name`;
    if (!doc.id) doc.id = slug(doc.name);
  }
  c.knowledge_base.faq = c.knowledge_base.faq.filter(f => f.q?.trim() && f.a?.trim());
  for (const [day, v] of Object.entries(s.clinic_hours)) if (!v || !v[0] || !v[1]) delete s.clinic_hours[day];
  // Keep the generic key names of the non-dental sets in step with the dental ones the page edits.
  if (c.business) c.business = c.clinic;
  if (s.resources) s.resources = s.doctors;
  if (s.business_hours) s.business_hours = s.clinic_hours;
  return null;
}

const inp = (path, value, extra = '') => `<input type="text" data-path="${esc(path)}" value="${esc(value ?? '')}" ${extra}>`;
const num = (path, value, extra = '') => `<input type="number" data-type="number" data-path="${esc(path)}" value="${esc(value ?? '')}" ${extra}>`;

function viewData() {
  const d = DataEditor.draft || { config: App.config, schedule: App.schedule };
  const c = d.config, s = d.schedule;
  const tabs = [['profile', 'Profile and hours'], ['doctors', L('resources')], ['services', 'Services'], ['faq', 'Knowledge base']];
  let body = '';
  if (DataEditor.tab === 'profile') {
    body = `<div class="grid-2">
      <div class="panel"><div class="panel-head"><h2>${esc(L('business'))} profile</h2></div><div class="form-grid">
        <label class="field"><span>Name</span>${inp('config.clinic.name', c.clinic.name)}</label>
        <label class="field"><span>Time zone</span>${inp('config.clinic.timezone', c.clinic.timezone)}</label>
        <label class="field"><span>Currency</span>${inp('config.clinic.currency', c.clinic.currency)}</label>
        <label class="field"><span>Ring timeout, s</span>${num('config.clinic.admin_ring_timeout_sec', c.clinic.admin_ring_timeout_sec, 'min="1" max="60"')}</label>
        <label class="field"><span>Chat timeout, s</span>${num('config.clinic.chat_timeout_sec', c.clinic.chat_timeout_sec ?? 30, 'min="5" max="300"')}</label>
      </div><div class="muted small" style="margin-top:.7rem">The address, parking and payment answers are in the knowledge base.</div></div>
      <div class="panel"><div class="panel-head"><h2>Opening hours</h2><span class="badge">Empty = closed</span></div>
        <div class="hours-grid">${DAYS.slice(1).concat('sun').map(day => `
          <b>${day[0].toUpperCase() + day.slice(1)}</b>
          <input type="time" data-path="schedule.clinic_hours.${day}.0" value="${esc(s.clinic_hours[day]?.[0] || '')}">
          <input type="time" data-path="schedule.clinic_hours.${day}.1" value="${esc(s.clinic_hours[day]?.[1] || '')}">`).join('')}
        </div></div></div>`;
  } else if (DataEditor.tab === 'doctors') {
    body = `<div class="panel"><div class="panel-head"><h2>${esc(L('resources'))}</h2><button class="btn sm" data-act="addRow" data-list="schedule.doctors">+ Add</button></div>
      <div class="table-scroll"><table class="edit"><tr><th>Name</th><th>Speciality id</th><th>Speciality</th><th>Working hours (mon 09:00-17:00; tue …)</th><th></th></tr>
      ${s.doctors.map((doc, i) => `<tr>
        <td>${inp(`schedule.doctors.${i}.name`, doc.name)}</td>
        <td>${inp(`schedule.doctors.${i}.speciality`, doc.speciality)}</td>
        <td>${inp(`schedule.doctors.${i}.speciality_label`, doc.speciality_label)}</td>
        <td><input type="text" data-type="hours" data-path="schedule.doctors.${i}.working_hours" value="${esc(fmtHours(doc.working_hours))}" style="min-width:260px"></td>
        <td><button class="btn sm danger" data-act="delRow" data-list="schedule.doctors" data-i="${i}">Remove</button></td></tr>`).join('')}
      </table></div><div class="muted small" style="margin-top:.6rem">Busy blocks (lunch, admin time) stay as they are in the schedule.</div></div>`;
  } else if (DataEditor.tab === 'services') {
    body = `<div class="panel"><div class="panel-head"><h2>Services</h2><button class="btn sm" data-act="addRow" data-list="config.services">+ Add</button></div>
      <div class="table-scroll"><table class="edit"><tr><th>Name</th><th>Urgent</th><th>Price from</th><th>Price to</th><th>Minutes</th><th>Speciality id</th><th></th></tr>
      ${c.services.map((v, i) => `<tr>
        <td>${inp(`config.services.${i}.name`, v.name, 'style="min-width:200px"')}</td>
        <td><input type="checkbox" data-type="bool" data-path="config.services.${i}.urgent" ${v.urgent ? 'checked' : ''}></td>
        <td>${num(`config.services.${i}.price_min`, v.price_min)}</td>
        <td>${num(`config.services.${i}.price_max`, v.price_max)}</td>
        <td>${num(`config.services.${i}.duration_min`, v.duration_min)}</td>
        <td><select data-path="config.services.${i}.speciality">${[...new Set([...s.doctors.map(x => x.speciality), v.speciality])].map(sp => `<option ${sp === v.speciality ? 'selected' : ''}>${esc(sp)}</option>`).join('')}</select></td>
        <td><button class="btn sm danger" data-act="delRow" data-list="config.services" data-i="${i}">Remove</button></td></tr>`).join('')}
      </table></div><div class="muted small" style="margin-top:.6rem">Prices in ${esc(c.clinic.currency)}.</div></div>`;
  } else {
    body = `<div class="panel"><div class="panel-head"><h2>Knowledge base · FAQ</h2><button class="btn sm" data-act="addRow" data-list="config.knowledge_base.faq">+ Add</button></div>
      <div class="faq-edit">${c.knowledge_base.faq.map((f, i) => `<div class="faq-item">
        ${inp(`config.knowledge_base.faq.${i}.q`, f.q, 'placeholder="Question"')}
        <button class="btn sm danger" data-act="delRow" data-list="config.knowledge_base.faq" data-i="${i}">Remove</button>
        <textarea data-path="config.knowledge_base.faq.${i}.a" placeholder="Answer" style="grid-column:1/-1">${esc(f.a)}</textarea></div>`).join('')}
      </div></div>`;
  }
  return pageHead(`${L('business')} data`, `Edited here and kept in the database. Saving rebuilds the AI prompt${App.mode === 'live' ? ' and pushes it to Vapi' : ''}.`,
    `<button class="btn ghost" data-act="seedData">Reset to seed files</button>`) + `
    <div class="tabs-inline roles">${tabs.map(([id, l]) => `<button data-act="dataTab" data-tab="${id}" class="${DataEditor.tab === id ? 'active' : ''}">${esc(l)}</button>`).join('')}</div>
    ${body}
    <div class="savebar"><span id="dirty" class="badge amber ${DataEditor.keep ? '' : 'hidden'}">Unsaved changes</span>
      <button class="btn ghost" data-act="discardData">Discard</button><button class="btn primary" data-act="saveData">Save ${esc(L('business').toLowerCase())} data</button></div>`;
}

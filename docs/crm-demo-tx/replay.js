'use strict';

/*
 * Replay mode: scripted calls and chats that emit the same events as Live mode
 * (calls, call_messages, call_state, appointments, tasks, notifications) through the Store.
 * Every scenario first sets the operation mode and availability it demonstrates (in memory only).
 */

const DENTAL_SCENARIOS = [
  { id: 'uc1', label: 'AI books', needs: { operation_mode: 'overflow', admin_availability: 'available' } },
  { id: 'uc2', label: 'Admin answers', needs: { operation_mode: 'overflow', admin_availability: 'available' } },
  { id: 'uc3', label: 'Urgent handoff', needs: { operation_mode: 'overflow', admin_availability: 'available' } },
  { id: 'uc3noanswer', label: 'Urgent · no pickup', needs: { operation_mode: 'overflow', admin_availability: 'available' } },
  { id: 'cdcp', label: 'CDCP', needs: { operation_mode: 'autonomous', admin_availability: 'available' } },
  { id: 'busy', label: 'Busy · AI at once', needs: { operation_mode: 'overflow', admin_availability: 'busy' } },
  { id: 'copilot', label: 'Copilot · message', needs: { operation_mode: 'copilot', admin_availability: 'available' } },
  { id: 'chat', label: 'Chat booking', needs: { operation_mode: 'overflow', admin_availability: 'available' } },
];

const Replay = {
  run: 0,
  speed: 2,

  stop() {
    this.run++;
    App.incoming = null;
    const call = App.calls.get(App.activeCallId);
    if (call && call.status !== 'ended') {
      Store.upsertCall({ id: call.id, status: 'ended', ended_at: new Date().toISOString() });
      Store.addMessage({ call_id: call.id, speaker: 'system', text: 'Replay stopped' });
    }
    render();
  },

  scenarios: () => App.replay?.scenarios || DENTAL_SCENARIOS,

  setupBar() {
    document.getElementById('scenarioButtons').innerHTML = this.scenarios()
      .map(s => `<button class="btn" data-scenario="${esc(s.id)}">${esc(s.label)}</button>`).join(' ');
  },

  async start(id) {
    if (App.mode !== 'replay') return;
    this.stop();
    const run = this.run;
    const sc = this.scenarios().find(s => s.id === id);
    const needs = sc.needs || { operation_mode: 'overflow', admin_availability: 'available' };
    if (Object.entries(needs).some(([k, v]) => App.settings[k] !== v)) {
      Object.assign(App.settings, needs);
      toast(`Scenario setting: ${MODE_NAMES[App.settings.operation_mode]} · ${AVAIL_NAMES[App.settings.admin_availability]}`);
    }
    go('live');
    try {
      if (App.replay) await runScripted(sc, makeCtx(run, sc.channel));
      else await SCENARIOS[id](makeCtx(run, id === 'chat' ? 'chat' : 'phone'));
    } catch (e) {
      if (e.message !== 'replay-stopped') { console.error(e); toast('Replay error: ' + e.message); }
    }
  },
};

function makeCtx(run, channel = 'phone') {
  const callId = uid('rp');
  const apptId = uid('ap');
  let apptCreated = false;
  let phone = null;
  const chat = channel === 'chat';

  const check = () => { if (run !== Replay.run) throw new Error('replay-stopped'); };
  const wait = async ms => { await new Promise(r => setTimeout(r, ms / Replay.speed)); check(); };

  // Mirror collected fields into the appointment, as the backend does: Draft while collecting.
  const syncAppointment = fields => {
    const map = { service: 'service_id', [L('resource_field')]: 'doctor_id', datetime: null };
    const patch = {};
    for (const [k, v] of Object.entries(fields)) {
      const col = k in map ? map[k] : k;
      if (col) patch[col] = v;
    }
    if (!apptCreated && !patch.service_id) return;
    if (!apptCreated) { apptCreated = true; patch.status = 'draft'; patch.call_id = callId; patch.phone = patch.phone || phone; }
    Store.upsertAppointment({ id: apptId, ...patch });
  };
  const fields = () => App.states.get(callId)?.fields || {};
  const system = text => Store.addMessage({ call_id: callId, speaker: 'system', text });

  const c = {
    callId, apptId, wait, system, chat,
    mode(mode, extra = {}) { Store.upsertCall({ id: callId, status: 'active', mode, ...extra }); },

    // A new call or chat: the operation mode decides who answers. adminAnswers: the administrator picks up.
    async open(callerPhone, adminAnswers = false) {
      phone = chat ? null : callerPhone;
      Store.upsertCall({ id: callId, phone, channel, started_at: new Date().toISOString(), status: 'ringing', mode: 'ringing' });
      const s = App.settings;
      if (firstResponder() === 'ai') {
        c.mode('ai');
        system(s.operation_mode === 'autonomous' ? `Autonomous mode: the AI assistant ${chat ? 'replies' : 'answered at once'}`
          : `Administrator is ${AVAIL_NAMES[s.admin_availability]}: the AI assistant ${chat ? 'replies' : 'answered at once'}`);
        return 'ai';
      }
      const sec = chat ? (App.config.clinic.chat_timeout_sec ?? 30) : App.config.clinic.admin_ring_timeout_sec;
      const copilot = s.operation_mode === 'copilot';
      App.incoming = {
        phone: chat ? 'Web chat visitor' : callerPhone, label: chat ? 'New chat' : 'Incoming call',
        ringUntil: adminAnswers ? null : Date.now() + sec * 1000 / Replay.speed, canAnswer: false,
        timeoutText: copilot ? 'AI assistant takes a message' : chat ? 'AI assistant replies' : 'AI assistant answers',
      };
      if (chat) system(`Waiting ${sec} s for the administrator`);
      render();
      await wait(adminAnswers ? 2000 : sec * 1000);
      App.incoming = null;
      if (adminAnswers) {
        c.mode('admin');
        system(`${L('admin')} answered. The AI assistant is listening and transcribing.`);
        return 'admin';
      }
      c.mode('ai');
      system((chat ? `No reply in ${sec} s, the AI assistant replied` : `No answer in ${sec} s, the AI assistant answered`) + (copilot ? ' (Copilot: it takes a message)' : ''));
      return 'ai';
    },

    async say(speaker, text) {
      await wait(500 + text.length * (chat ? 18 : 30));
      Store.addMessage({ call_id: callId, speaker, text });
    },
    state(stage, script_step, f = {}, extra = {}) {
      Store.setState({ call_id: callId, stage, script_step, fields: f, ...extra });
      syncAppointment(f);
    },

    task(type, reason) {
      const f = fields();
      const appt = App.appointments.get(apptId);
      const minutes = type === 'urgent_callback' ? 15 : type === 'callback' ? 120 : 24 * 60;
      Store.upsertTask({
        id: uid('tk'), type, status: 'pending', name: f.name || null, phone: f.phone || phone, reason,
        call_id: callId, appointment_id: appt ? apptId : null, created_at: new Date().toISOString(),
        due_at: new Date(Date.now() + minutes * 60000).toISOString(),
      });
      system(`Task created: ${taskTypeLabel(type).toLowerCase()}`);
    },

    notify(event) {
      if (!notifyOn(event)) return false;
      const n = App.settings.notifications;
      const a = App.appointments.get(apptId);
      const start = a?.start;
      const text = (n.events[event].template || '').replace(/\{([\w.]+)\}/g, (all, k) => ({
        name: a?.name || '', service: serviceById(a?.service_id)?.name || '', doctor: doctorById(a?.doctor_id)?.name || '',
        date: start ? fmtDate(parseDate(start)) : '', time: start ? fmtTime12(toMin(start.slice(11, 16))) : '', 'clinic.name': App.config.clinic.name,
      })[k] ?? all);
      Store.addNotification({ id: uid('nt'), appointment_id: apptId, event, channel: n.channel, recipient: n.channel === 'sms' ? a?.phone : a?.email, text, status: 'simulated' });
      system(`${n.channel.toUpperCase()} ${event} message sent (simulated)`);
      return true;
    },

    // Book with status Filled; a coverage check task when the patient has insurance; the notification if turned on.
    book(doctorId, date, startMin, durMin) {
      Store.upsertAppointment({
        id: apptId, call_id: callId, doctor_id: doctorId, status: 'filled', phone: fields().phone || phone,
        start: localIso(date, startMin), end: localIso(date, startMin + durMin),
      });
      const a = App.appointments.get(apptId);
      if (a.insurance_type === 'private' || a.insurance_type === 'cdcp') {
        c.task('coverage_check', a.insurance_type === 'cdcp' ? `CDCP${a.insurance_member_id ? ' · member ID ' + a.insurance_member_id : ''}`
          : `${a.insurance_company || 'Private plan'}${a.insurance_member_id ? ' · member ID ' + a.insurance_member_id : ''}`);
      }
      return c.notify('booked');
    },
    // Keep a Draft with everything collected so far (as ensureDraft does in the backend).
    saveDraft() {
      if (!apptCreated) { apptCreated = true; Store.upsertAppointment({ id: apptId, call_id: callId, status: 'draft', phone: fields().phone || phone }); }
      syncAppointment(fields());
    },

    // Handoff to the administrator. Returns true when the administrator joined.
    async handoff(answers, label) {
      const cfg = App.config;
      if (!canHandOff()) {
        system(`${L('admin')} is ${AVAIL_NAMES[App.settings.admin_availability]}: no live ${chat ? 'invite' : 'transfer'}`);
        await c.say('ai', cfg.handoff.admin_no_answer.say);
        c.saveDraft();
        c.task(isUrgent(App.states.get(callId)?.handoff_reason) ? 'urgent_callback' : 'callback', fields().complaint || 'Call back');
        return false;
      }
      c.mode('transferring');
      system(chat ? 'Inviting the administrator to the chat' : `Transferring the call to the ${L('admin').toLowerCase()}`);
      App.incoming = { phone: phone || 'Web chat visitor', label: label || 'Handoff from the AI assistant', ringUntil: null, canAnswer: false };
      render();
      if (answers) {
        await wait(3000);
        App.incoming = null;
        c.mode('admin');
        system(`${L('admin')} joined. Collected data and transcript are on this page.`);
        return true;
      }
      await wait(8000);
      App.incoming = null;
      c.mode('ai');
      system(`The ${L('admin').toLowerCase()} did not pick up`);
      await c.say('ai', cfg.handoff.admin_no_answer.say);
      c.saveDraft();
      c.task(isUrgent(App.states.get(callId)?.handoff_reason) ? 'urgent_callback' : 'callback', fields().complaint || 'Call back');
      return false;
    },

    async end(outcome, extra = {}) {
      await wait(800);
      Store.upsertCall({ id: callId, status: 'ended', ended_at: new Date().toISOString(), outcome, ...extra });
      system(chat ? 'Chat ended' : 'Call ended');
    },
  };
  return c;
}

/* ---------- Slot planning from schedule.json ---------- */

function firstFree(doc, fromDay, dur, maxDays = 21) {
  for (let i = fromDay; i < fromDay + maxDays; i++) {
    const d = addDays(new Date(), i);
    const fs = freeSlots(doc, d, dur);
    if (fs.length) return { d, m: fs[0], all: fs };
  }
  return null;
}

// Preferred day, a rejected first time, then the three alternatives from rules.slot_selection.
function planSlotSelection(doc, dur) {
  let pref = null;
  for (let i = 3; i < 24 && !pref; i++) {
    const d = addDays(new Date(), i);
    const fs = freeSlots(doc, d, dur);
    if (fs.length >= 2) pref = { d, all: fs };
  }
  const t1 = pref.all[0];
  const t2 = pref.all.find(m => m >= t1 + 120) ?? pref.all[1];
  let sameTime = null;
  for (let i = 1; i < 21 && !sameTime; i++) {
    const d = addDays(pref.d, i);
    if (isFree(doc, d, t1, dur)) sameTime = { d, m: t1 };
  }
  const soon = [1, 2].flatMap(i => { const d = addDays(new Date(), i); return freeSlots(doc, d, dur).map(m => ({ d, m })); });
  const random = soon.length ? soon[Math.floor(Math.random() * soon.length)] : firstFree(doc, 1, dur);
  return { day: pref.d, first: t1, alternatives: [{ d: pref.d, m: t2 }, sameTime, random] };
}

const at = s => `${fmtDate(s.d)} at ${fmtTime12(s.m)}`;
// Handoff triggers marked urgent in agent-config.json (urgent case, emergency, lockout) make an urgent callback.
const isUrgent = reason => Boolean(App.config.handoff.triggers.find(t => t.id === reason)?.urgent);
const scriptSay = id => App.config.script.find(s => s.step === id)?.say || '';
const faq = q => App.config.knowledge_base.faq.find(f => f.q.toLowerCase().includes(q))?.a || '';
const confirmLine = sent => sent ? ' You will get a confirmation message shortly.' : '';

/* ---------- Dental scenarios ---------- */

const SCENARIOS = {
  // UC1: the administrator does not answer; the AI books. Private insurance -> coverage check task.
  async uc1(c) {
    const doc = doctorById('dr_carter');
    const svc = serviceById('checkup_cleaning');
    const phone = '+1 416 555 0142';
    const plan = planSlotSelection(doc, svc.duration_min);
    const chosen = plan.alternatives[1];

    await c.open(phone);
    c.state('greeting', 'greet');
    await c.say('ai', scriptSay('greet'));
    await c.say('caller', "Hi, I'd like to book a teeth cleaning, please.");
    c.state('intent', 'ask_intent');
    await c.say('ai', 'Sure, I can help with that. Is it a regular check-up, or do you have any discomfort?');
    c.state('service', 'ask_complaint');
    await c.say('caller', 'Just a regular check-up, no pain.');
    c.state('service', 'match_service', { complaint: 'Regular check-up, no pain', service: svc.id });
    await c.say('ai', `A check-up and cleaning takes about ${svc.duration_min} minutes and costs ${svc.price_min} to ${svc.price_max} dollars. Do you have a preferred doctor, or is any available doctor fine?`);
    c.state('service', 'ask_doctor');
    await c.say('caller', 'Dr. Carter, if possible.');
    c.state('patient_details', 'ask_name', { doctor: doc.id });
    await c.say('ai', 'Of course. May I have your full name, please?');
    await c.say('caller', 'Anna Baxter.');
    c.state('patient_details', 'confirm_phone', { name: 'Anna Baxter' });
    await c.say('ai', `Thank you, Anna. Is ${phone} the best number to reach you?`);
    await c.say('caller', "Yes, that's right.");
    c.state('patient_details', 'ask_patient_type', { phone });
    await c.say('ai', 'Have you visited our clinic before?');
    await c.say('caller', "No, it's my first time.");
    c.state('patient_details', 'ask_insurance', { patient_type: 'new' });
    await c.say('ai', scriptSay('ask_insurance'));
    await c.say('caller', 'Yes, through work. It is Manulife.');
    c.state('patient_details', 'ask_private_plan', { insurance_type: 'private', insurance_company: 'Manulife' });
    await c.say('ai', scriptSay('ask_private_plan'));
    await c.say('caller', "I'll bring the card.");
    await c.say('ai', 'Great. Our staff will check your coverage with Manulife before the visit and tell you about any cost you need to pay before we start.');
    c.state('slot_selection', 'ask_day');
    await c.say('ai', scriptSay('ask_day'));
    await c.say('caller', `${weekday(plan.day)} would be best.`);
    c.state('slot_selection', 'propose_time');
    await c.say('ai', `Dr. Carter is available on ${fmtDate(plan.day)} at ${fmtTime12(plan.first)}. Does that work for you?`);
    await c.say('caller', "Hmm, that time doesn't work for me, sorry.");
    const [a1, a2, a3] = plan.alternatives;
    await c.say('ai', `No problem. I can offer three options: ${at(a1)}; ${at(a2)}; or ${at(a3)}. Which one do you prefer?`);
    await c.say('caller', `The second one, ${weekday(chosen.d)} at ${fmtTime12(chosen.m)}.`);
    c.state('confirmation', 'confirm', { datetime: localIso(chosen.d, chosen.m) });
    const sent = c.book(doc.id, chosen.d, chosen.m, svc.duration_min);
    await c.say('ai', `Great. I've booked a check-up and cleaning with Dr. Carter on ${at(chosen)} for Anna Baxter.${confirmLine(sent)}`);
    c.state('closing', 'close');
    await c.say('ai', scriptSay('close'));
    await c.say('caller', 'Thank you, bye!');
    await c.end('booked');
  },

  // UC2: the administrator answers; the AI listens, fills the intake and shows suggestions.
  async uc2(c) {
    const svc = serviceById('filling');
    const phone = '+1 647 555 0198';
    const doc = doctorsFor(svc.speciality)[0];

    await c.open(phone, true);
    c.state('greeting', 'greet');
    await c.say('admin', `${App.config.clinic.name}, front desk. How can I help you?`);
    await c.say('caller', 'Hi, a filling fell out yesterday and I want to get it fixed.');
    c.state('service', 'ask_complaint', { complaint: 'Lost filling' });
    await c.say('admin', 'Sorry to hear that. Are you in any pain?');
    await c.say('caller', "No, it's just a bit sensitive. Is there parking at the clinic?");
    c.state('service', 'match_service', { complaint: 'Lost filling, slight sensitivity, no pain', service: svc.id }, { suggestions: { kb_answer: faq('parking') } });
    await c.say('admin', 'Yes, free parking behind the building. Do you have a preferred doctor?');
    await c.say('caller', 'No, anyone is fine.');
    c.state('service', 'ask_doctor', {}, { suggestions: { kb_answer: '' } });
    await c.say('admin', 'Can I have your full name, please?');
    await c.say('caller', 'Michael Brown.');
    c.state('patient_details', 'ask_name', { name: 'Michael Brown' });
    await c.say('admin', 'Is this number the best one to reach you?');
    await c.say('caller', 'Yes.');
    c.state('patient_details', 'confirm_phone', { phone });
    await c.say('admin', 'Have you been with us before?');
    await c.say('caller', 'Yes, last year.');
    c.state('patient_details', 'ask_patient_type', { patient_type: 'returning' });
    await c.say('admin', 'Do you have a dental plan through work?');
    await c.say('caller', "Yes, Canada Life, member ID 4482-119.");
    c.state('patient_details', 'ask_private_plan', { insurance_type: 'private', insurance_company: 'Canada Life', insurance_member_id: '4482-119' });
    await c.say('admin', 'Thanks. Would you like the nearest available day?');
    await c.say('caller', 'The nearest, please.');
    c.state('slot_selection', 'ask_day');
    const slot = firstFree(doc, 1, svc.duration_min);
    await c.wait(1500);
    await c.say('admin', `We have ${at(slot)}. Does that work?`);
    await c.say('caller', 'Perfect.');
    c.state('confirmation', 'confirm', { datetime: localIso(slot.d, slot.m), doctor: doc.id });
    const sent = c.book(doc.id, slot.d, slot.m, svc.duration_min);
    c.system(`Doctor assigned automatically: ${doc.name}`);
    await c.say('admin', `You're booked for a filling on ${at(slot)}. We'll check your Canada Life coverage before the visit.${confirmLine(sent)}`);
    c.state('closing', 'close');
    await c.say('caller', 'Thanks, bye.');
    await c.end('booked');
  },

  // UC3: urgent case, the AI hands the call over and the administrator picks up.
  async uc3(c) { await urgentHandoff(c, true); },

  // UC3 variant: the administrator does not pick up -> urgent callback task.
  async uc3noanswer(c) { await urgentHandoff(c, false); },

  // CDCP: the AI asks about a private plan first, never confirms coverage, books; coverage check task.
  async cdcp(c) {
    const svc = serviceById('checkup_cleaning');
    const doc = doctorsFor(svc.speciality)[1] || doctorsFor(svc.speciality)[0];
    const phone = '+1 289 555 0163';
    await c.open(phone);
    c.state('greeting', 'greet');
    await c.say('ai', scriptSay('greet'));
    await c.say('caller', 'Hello. Do you take the Canadian Dental Care Plan? I need a check-up.');
    c.state('intent', 'ask_intent', { complaint: 'Check-up', service: svc.id }, { suggestions: { kb_answer: faq('cdcp') } });
    await c.say('ai', faq('cdcp'));
    await c.say('caller', "No, I don't have any other dental plan. Only CDCP.");
    c.state('patient_details', 'ask_cdcp', { insurance_type: 'cdcp' });
    await c.say('ai', 'Thank you. May I have your full name, please?');
    await c.say('caller', 'Margaret Singh.');
    c.state('patient_details', 'confirm_phone', { name: 'Margaret Singh' });
    await c.say('ai', `Is ${phone} the best number to reach you?`);
    await c.say('caller', 'Yes it is.');
    c.state('patient_details', 'ask_patient_type', { phone });
    await c.say('ai', 'Have you visited our clinic before?');
    await c.say('caller', 'No, never.');
    c.state('patient_details', 'ask_cdcp', { patient_type: 'new' });
    await c.say('ai', scriptSay('ask_cdcp'));
    await c.say('caller', 'Yes, my member ID is C-5520-9931.');
    c.state('patient_details', 'ask_cdcp', { insurance_member_id: 'C-5520-9931' });
    await c.say('caller', 'Will CDCP cover all of it?');
    await c.say('ai', "I can't confirm coverage myself. Our staff will check your eligibility and co-payment with Sun Life before treatment and tell you about any cost first.");
    c.state('slot_selection', 'ask_day');
    const slot = firstFree(doc, 1, svc.duration_min);
    await c.say('ai', `The nearest time is ${at(slot)} with ${doc.name}. Does that work?`);
    await c.say('caller', 'Yes, thank you.');
    c.state('confirmation', 'confirm', { datetime: localIso(slot.d, slot.m), doctor: doc.id });
    const sent = c.book(doc.id, slot.d, slot.m, svc.duration_min);
    await c.say('ai', `You're booked for a check-up on ${at(slot)}. Please bring your CDCP member card and a photo ID.${confirmLine(sent)}`);
    c.state('closing', 'close');
    await c.say('caller', 'Thank you.');
    await c.end('booked');
  },

  // Overflow + Busy: the AI answers at once; a request for a person becomes a callback task.
  async busy(c) {
    const phone = '+1 905 555 0184';
    await c.open(phone);
    c.state('greeting', 'greet');
    await c.say('ai', scriptSay('greet'));
    await c.say('caller', 'Hi, can I speak to someone at the front desk about my bill?');
    c.state('handoff', 'ask_intent', { complaint: 'Question about a bill' }, { handoff_reason: 'human_requested' });
    Store.upsertCall({ id: c.callId, handoff_reason: 'human_requested' });
    await c.say('ai', 'Of course. May I have your name and the best number to call you back?');
    await c.say('caller', `Laura Chen, and ${phone} is fine.`);
    c.state('handoff', 'confirm_phone', { name: 'Laura Chen', phone });
    await c.handoff(false);
    await c.say('caller', 'Okay, thanks.');
    await c.end('callback');
  },

  // Copilot: nobody answers; the AI only takes a message (no booking): Draft + callback task.
  async copilot(c) {
    const phone = '+1 416 555 0177';
    const svc = serviceById('whitening');
    await c.open(phone);
    c.state('greeting', 'greet');
    await c.say('ai', `Hello, thank you for calling ${App.config.clinic.name}. Our team is busy right now. I can take a message and we will call you back. How can we help?`);
    await c.say('caller', "I'd like to book a teeth whitening.");
    c.state('service', 'match_service', { complaint: 'Wants teeth whitening', service: svc.id });
    await c.say('ai', 'Sure. May I have your full name?');
    await c.say('caller', 'Peter Novak.');
    c.state('patient_details', 'confirm_phone', { name: 'Peter Novak' });
    await c.say('ai', `Thank you, Peter. Is ${phone} the best number to reach you?`);
    await c.say('caller', 'Yes.');
    c.state('closing', 'close', { phone });
    c.saveDraft();
    c.task('callback', 'Wants to book teeth whitening');
    await c.say('ai', 'I have saved your request. Our administrator will call you back to book a time. Have a great day!');
    await c.end('message');
  },

  // Web chat: the administrator does not reply within the chat timeout; the AI books in the chat.
  async chat(c) {
    const doc = doctorById('dr_chen') || App.schedule.doctors[0];
    const svc = serviceById('extraction') || App.config.services[0];
    const phone = '+1 437 555 0109';
    await c.open(null);
    c.state('greeting', 'greet');
    await c.say('caller', 'Hi! Can I book an appointment here?');
    await c.say('ai', `Hello, this is the ${App.config.clinic.name} assistant. Yes, I can book it for you. What is the reason for your visit?`);
    await c.say('caller', 'My dentist said I need a tooth pulled.');
    c.state('service', 'match_service', { complaint: 'Needs a tooth extraction (referred)', service: svc.id });
    await c.say('ai', `A ${svc.name.toLowerCase()} takes about ${svc.duration_min} minutes and costs ${svc.price_min}–${svc.price_max} ${App.config.clinic.currency}. ${doc.name} does it. May I have your full name?`);
    await c.say('caller', 'Sofia Ramirez');
    c.state('patient_details', 'confirm_phone', { name: 'Sofia Ramirez', doctor: doc.id });
    await c.say('ai', App.config.script.find(s => s.step === 'confirm_phone')?.chat_say || 'What is the best phone number to reach you?');
    await c.say('caller', phone);
    c.state('patient_details', 'ask_patient_type', { phone });
    await c.say('ai', 'Thanks! Have you visited our clinic before?');
    await c.say('caller', 'No');
    c.state('patient_details', 'ask_insurance', { patient_type: 'new' });
    await c.say('ai', scriptSay('ask_insurance'));
    await c.say('caller', 'No insurance');
    c.state('patient_details', 'ask_cdcp', { insurance_type: 'none' });
    await c.say('ai', scriptSay('ask_cdcp'));
    await c.say('caller', 'No, not that either.');
    c.state('slot_selection', 'ask_day');
    const slot = firstFree(doc, 1, svc.duration_min);
    await c.say('ai', `The nearest time with ${doc.name} is ${at(slot)}. Does that work?`);
    await c.say('caller', 'Yes perfect');
    c.state('confirmation', 'confirm', { datetime: localIso(slot.d, slot.m) });
    const sent = c.book(doc.id, slot.d, slot.m, svc.duration_min);
    await c.say('ai', `Done! You're booked for ${at(slot)} with ${doc.name}.${confirmLine(sent)} Anything else?`);
    c.state('closing', 'close');
    await c.say('caller', 'No thanks!');
    await c.end('booked');
  },
};

async function urgentHandoff(c, adminAnswers) {
  const cfg = App.config;
  const svc = serviceById('emergency');
  const doc = doctorsFor(svc.speciality)[0];
  const phone = '+1 905 555 0117';
  const reason = 'urgent_case';

  await c.open(phone);
  c.state('greeting', 'greet');
  await c.say('ai', scriptSay('greet'));
  await c.say('caller', 'Hi, I have a really bad toothache and my cheek is swelling up.');
  c.state('handoff', 'ask_name', { complaint: 'Severe toothache, swollen cheek', service: svc.id }, { handoff_reason: reason });
  Store.upsertCall({ id: c.callId, handoff_reason: reason });
  await c.say('ai', "I'm sorry you're in pain. I'll connect you with our administrator right away. May I have your name first?");
  await c.say('caller', 'David Wilson.');
  c.state('handoff', 'confirm_phone', { name: 'David Wilson' });
  await c.say('ai', `Thank you, David. Is ${phone} the best number to reach you?`);
  await c.say('caller', 'Yes.');
  c.state('handoff', 'confirm_phone', { phone });
  await c.say('ai', cfg.handoff.say_before_transfer);

  if (!await c.handoff(adminAnswers, 'Handoff from the AI assistant · urgent case')) {
    await c.say('caller', 'Okay, please call me soon.');
    await c.end('callback');
    return;
  }
  await c.say('admin', "Hi David, this is the front desk. I see you have a bad toothache with swelling. Let's get you in as soon as possible.");
  const slot = firstFree(doc, 0, svc.duration_min) || firstFree(doc, 1, svc.duration_min);
  c.state('slot_selection', 'propose_time', { patient_type: 'returning' });
  await c.say('caller', "Thank you. I've been to your clinic before.");
  await c.say('admin', `${doc.name} can see you on ${at(slot)}. Can you make it?`);
  await c.say('caller', 'Yes, I will be there.');
  c.state('confirmation', 'confirm', { datetime: localIso(slot.d, slot.m), doctor: doc.id });
  c.book(doc.id, slot.d, slot.m, svc.duration_min);
  await c.say('admin', 'You are booked for an emergency visit. If the swelling gets worse, please go to the nearest emergency room.');
  c.state('closing', 'close');
  await c.say('caller', 'Thanks a lot.');
  await c.end('handoff');
}

/* ---------- Scripted scenarios from replay.json (non-dental business sets) ----------
 * A scenario is { id, label, phone, channel?: "phone" | "chat", needs?: { operation_mode, admin_availability }, steps: [...] }.
 * Steps:
 *   { "ring": "ai" }            the operation mode decides: ring for the ring timeout (chat: wait the chat timeout),
 *                               then the AI assistant answers; or the AI answers at once
 *   { "ring": "admin" }         ring briefly, then the administrator answers
 *   { "ai" | "caller" | "admin": "text" }   one utterance
 *   { "system": "text" }
 *   { "state": "stage/step", "fields": {...}, "handoff_reason": "..." }
 *   { "slot": { "name", "service", "resource"?, "from_day"?, "time"?, "asap_min"? } }
 *        nearest free slot of the service (for one resource or any resource with the service speciality);
 *        asap_min books today at now + asap_min, outside working hours too (24/7 emergencies)
 *   { "book": "<slot name>" }   book the slot with status Filled (notification if turned on)
 *   { "transfer": "answer" | "no_answer", "label": "..." }   handoff; no pickup or Busy/Offline -> callback task
 *   { "task": "callback" | "urgent_callback", "reason": "..." }
 *   { "end": "booked" | "handoff" | "callback" | ... }
 * Placeholders in texts and field values: {phone}, {script:<step id>}, {say_before_transfer},
 * {admin_no_answer}, {<slot>} (date and time), {<slot>.date}, {<slot>.time}, {<slot>.iso}, {<slot>.resource}.
 */

function findSlot(o) {
  const svc = serviceById(o.service);
  const docs = o.resource ? [doctorById(o.resource)] : doctorsFor(svc.speciality);
  if (o.asap_min != null) {
    const step = App.schedule.slot_step_min;
    const m = Math.ceil((nowMin() + o.asap_min) / step) * step;
    return { d: startOfDay(new Date()), m: Math.min(m, 24 * 60 - svc.duration_min), doc: docs[0], svc };
  }
  // With "time": the first day from from_day where that time is free.
  const atTime = (doc, from) => {
    for (let i = from; i < from + 21; i++) {
      const d = addDays(new Date(), i);
      if (isFree(doc, d, toMin(o.time), svc.duration_min)) return { d, m: toMin(o.time) };
    }
    return null;
  };
  let best = null;
  for (const doc of docs) {
    const s = o.time ? atTime(doc, o.from_day ?? 1) : firstFree(doc, o.from_day ?? 1, svc.duration_min);
    if (s && (!best || s.d < best.d || (+s.d === +best.d && s.m < best.m))) best = { ...s, doc, svc };
  }
  if (!best) throw new Error(`No free slot for ${o.service}`);
  return best;
}

async function runScripted(sc, c) {
  const cfg = App.config;
  const slots = {};
  const fill = v => typeof v !== 'string' ? v : v.replace(/\{([\w.:]+)\}/g, (all, key) => {
    if (key === 'phone') return sc.phone;
    if (key === 'say_before_transfer') return cfg.handoff.say_before_transfer;
    if (key === 'admin_no_answer') return cfg.handoff.admin_no_answer.say;
    if (key.startsWith('script:')) return (cfg.script.find(s => s.step === key.slice(7))?.say || '').replace('{caller_phone}', sc.phone);
    const [name, part] = key.split('.');
    const s = slots[name];
    if (!s) return all;
    if (!part) return at(s);
    return { date: fmtDate(s.d), time: fmtTime12(s.m), iso: localIso(s.d, s.m), resource: s.doc.name, resource_id: s.doc.id }[part] ?? all;
  });
  const fillObj = o => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k, fill(v)]));

  for (const st of sc.steps) {
    if (st.ring === 'ai') {
      await c.open(sc.phone);
    } else if (st.ring === 'admin') {
      await c.open(sc.phone, true);
    } else if (st.ai || st.caller || st.admin) {
      const speaker = st.ai ? 'ai' : st.caller ? 'caller' : 'admin';
      await c.say(speaker, fill(st[speaker]));
    } else if (st.system) {
      c.system(fill(st.system));
    } else if (st.state) {
      const [stage, step] = st.state.split('/');
      const extra = st.handoff_reason ? { handoff_reason: st.handoff_reason } : {};
      c.state(stage, step, fillObj(st.fields), extra);
      if (st.handoff_reason) Store.upsertCall({ id: c.callId, handoff_reason: st.handoff_reason });
    } else if (st.slot) {
      slots[st.slot.name] = findSlot(st.slot);
    } else if (st.book) {
      const s = slots[st.book];
      c.book(s.doc.id, s.d, s.m, s.svc.duration_min);
    } else if (st.transfer) {
      await c.handoff(st.transfer === 'answer', st.label);
    } else if (st.task) {
      c.saveDraft();
      c.task(st.task, fill(st.reason || ''));
    } else if (st.end) {
      await c.end(st.end);
    }
  }
}

/* ---------- Replay bar ---------- */

document.addEventListener('DOMContentLoaded', () => {
  const bar = document.getElementById('replayBar');
  bar.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.id === 'stopReplay') Replay.stop();
    else if (b.dataset.scenario) Replay.start(b.dataset.scenario);
  });
  const speed = document.getElementById('speedSelect');
  Replay.speed = Number(speed.value);
  speed.addEventListener('change', () => { Replay.speed = Number(speed.value); });
});

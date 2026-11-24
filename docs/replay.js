'use strict';

/*
 * Replay mode: scripted calls that emit the same events as Live mode
 * (calls, call_messages, call_state, appointments) through the Store.
 */

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

  async start(name) {
    this.stop();
    const run = this.run;
    App.view = 'calls';
    try {
      await SCENARIOS[name](makeCtx(run));
    } catch (e) {
      if (e.message !== 'replay-stopped') { console.error(e); toast('Replay error: ' + e.message); }
    }
  },
};

function makeCtx(run) {
  const callId = 'rp-' + Date.now();
  const apptId = 'ap-' + Date.now();
  let apptCreated = false;

  const check = () => { if (run !== Replay.run) throw new Error('replay-stopped'); };
  const wait = async ms => { await new Promise(r => setTimeout(r, ms / Replay.speed)); check(); };

  // Mirror collected fields into the appointment, as the backend does: Draft while collecting.
  const syncAppointment = fields => {
    const map = { service: 'service_id', doctor: 'doctor_id', name: 'name', phone: 'phone', patient_type: 'patient_type', complaint: 'complaint', insurance_number: 'insurance_number' };
    const patch = {};
    for (const [k, v] of Object.entries(fields)) if (map[k]) patch[map[k]] = v;
    if (!apptCreated && !patch.service_id) return;
    if (!apptCreated) { apptCreated = true; patch.status = 'draft'; patch.call_id = callId; }
    Store.upsertAppointment({ id: apptId, ...patch });
  };

  return {
    callId,
    wait,
    async ring(phone, seconds, label = 'Incoming call') {
      Store.upsertCall({ id: callId, phone, started_at: new Date().toISOString(), status: 'ringing', mode: 'ringing' });
      App.incoming = { phone, label, ringUntil: Date.now() + seconds * 1000 / Replay.speed, canAnswer: false };
      render();
      await wait(seconds * 1000);
      App.incoming = null;
    },
    mode(mode, extra = {}) { Store.upsertCall({ id: callId, status: 'active', mode, ...extra }); },
    system(text) { Store.addMessage({ call_id: callId, speaker: 'system', text }); },
    async say(speaker, text) {
      await wait(500 + text.length * 30);
      Store.addMessage({ call_id: callId, speaker, text });
    },
    state(stage, script_step, fields = {}, extra = {}) {
      Store.setState({ call_id: callId, stage, script_step, fields, ...extra });
      syncAppointment(fields);
    },
    book(doctorId, date, startMin, durMin, status = 'filled') {
      Store.upsertAppointment({
        id: apptId, call_id: callId, doctor_id: doctorId, status,
        start: localIso(date, startMin), end: localIso(date, startMin + durMin),
      });
    },
    saveDraft() { Store.upsertAppointment({ id: apptId, call_id: callId, status: 'draft' }); },
    end(outcome, extra = {}) {
      Store.upsertCall({ id: callId, status: 'ended', ended_at: new Date().toISOString(), outcome, ...extra });
      Store.addMessage({ call_id: callId, speaker: 'system', text: 'Call ended' });
    },
  };
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

/* ---------- Scenarios ---------- */

const SCENARIOS = {
  // UC1: the administrator does not answer; the AI books the appointment.
  async uc1(c) {
    const cfg = App.config;
    const doc = doctorById('dr_carter');
    const svc = serviceById('checkup_cleaning');
    const phone = '+1 416 555 0142';
    const plan = planSlotSelection(doc, svc.duration_min);
    const chosen = plan.alternatives[1];

    await c.ring(phone, cfg.clinic.admin_ring_timeout_sec);
    c.mode('ai');
    c.system(`No answer in ${cfg.clinic.admin_ring_timeout_sec} s, the AI assistant answered`);
    c.state('greeting', 'greet');
    await c.say('ai', cfg.script.find(s => s.step === 'greet').say);
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
    await c.say('ai', cfg.script.find(s => s.step === 'ask_insurance').say);
    await c.say('caller', "I'll bring the card to the visit.");
    c.state('slot_selection', 'ask_day');
    await c.say('ai', cfg.script.find(s => s.step === 'ask_day').say);
    await c.say('caller', `${weekday(plan.day)} would be best.`);
    c.state('slot_selection', 'propose_time');
    await c.say('ai', `Dr. Carter is available on ${fmtDate(plan.day)} at ${fmtTime12(plan.first)}. Does that work for you?`);
    await c.say('caller', "Hmm, that time doesn't work for me, sorry.");
    const [a1, a2, a3] = plan.alternatives;
    await c.say('ai', `No problem. I can offer three options: ${at(a1)}; ${at(a2)}; or ${at(a3)}. Which one do you prefer?`);
    await c.say('caller', `The second one, ${weekday(chosen.d)} at ${fmtTime12(chosen.m)}.`);
    c.state('confirmation', 'confirm', { datetime: localIso(chosen.d, chosen.m) });
    c.book(doc.id, chosen.d, chosen.m, svc.duration_min);
    await c.say('ai', `Great. I've booked a check-up and cleaning with Dr. Carter on ${at(chosen)} for Anna Baxter.`);
    c.state('closing', 'close');
    await c.say('ai', cfg.script.find(s => s.step === 'close').say);
    await c.say('caller', 'Thank you, bye!');
    await c.wait(800);
    c.end('booked');
  },

  // UC2: the administrator answers; the AI listens and fills the call page.
  async uc2(c) {
    const svc = serviceById('filling');
    const phone = '+1 647 555 0198';
    const doc = doctorsFor(svc.speciality)[0];

    Store.upsertCall({ id: c.callId, phone, started_at: new Date().toISOString(), status: 'ringing', mode: 'ringing' });
    App.incoming = { phone, label: 'Incoming call', ringUntil: Date.now() + App.config.clinic.admin_ring_timeout_sec * 1000 / Replay.speed, canAnswer: false };
    render();
    await c.wait(2000);
    App.incoming = null;
    c.mode('admin');
    c.system('Administrator answered. The AI assistant is listening and transcribing.');
    c.state('greeting', 'greet');
    await c.say('admin', 'Bright Smile Dental, front desk. How can I help you?');
    await c.say('caller', 'Hi, a filling fell out yesterday and I want to get it fixed.');
    c.state('service', 'ask_complaint', { complaint: 'Lost filling' });
    await c.say('admin', 'Sorry to hear that. Are you in any pain?');
    await c.say('caller', "No, it's just a bit sensitive.");
    c.state('service', 'match_service', { complaint: 'Lost filling, slight sensitivity, no pain', service: svc.id });
    await c.say('admin', 'Do you have a preferred doctor?');
    await c.say('caller', 'No, anyone is fine.');
    c.state('service', 'ask_doctor');
    await c.say('admin', 'Can I have your full name, please?');
    await c.say('caller', 'Michael Brown.');
    c.state('patient_details', 'ask_name', { name: 'Michael Brown' });
    await c.say('admin', 'Is this number the best one to reach you?');
    await c.say('caller', 'Yes.');
    c.state('patient_details', 'confirm_phone', { phone });
    await c.say('admin', 'Have you been with us before?');
    await c.say('caller', 'Yes, last year.');
    c.state('patient_details', 'ask_patient_type', { patient_type: 'returning' });
    await c.say('admin', 'Do you have dental insurance?');
    await c.say('caller', "Yes, it's SL-2231-884.");
    c.state('patient_details', 'ask_insurance', { insurance_number: 'SL-2231-884' });
    await c.say('admin', 'Would you like the nearest available day?');
    await c.say('caller', 'The nearest, please.');
    c.state('slot_selection', 'ask_day');
    const slot = firstFree(doc, 1, svc.duration_min);
    await c.say('admin', `We have ${at(slot)}. Does that work?`);
    await c.say('caller', 'Perfect.');
    c.state('confirmation', 'confirm', { datetime: localIso(slot.d, slot.m), doctor: doc.id });
    c.book(doc.id, slot.d, slot.m, svc.duration_min);
    c.system(`Doctor assigned automatically: ${doc.name}`);
    await c.say('admin', `You're booked for a filling on ${at(slot)}. See you then!`);
    c.state('closing', 'close');
    await c.say('caller', 'Thanks, bye.');
    await c.wait(800);
    c.end('booked');
  },

  // UC3: urgent case, the AI hands the call over and the administrator picks up.
  async uc3(c) { await urgentHandoff(c, true); },

  // UC3 variant: the administrator does not pick up the transfer.
  async uc3noanswer(c) { await urgentHandoff(c, false); },
};

async function urgentHandoff(c, adminAnswers) {
  const cfg = App.config;
  const svc = serviceById('emergency');
  const doc = doctorsFor(svc.speciality)[0];
  const phone = '+1 905 555 0117';
  const reason = 'urgent_case';

  await c.ring(phone, cfg.clinic.admin_ring_timeout_sec);
  c.mode('ai');
  c.system(`No answer in ${cfg.clinic.admin_ring_timeout_sec} s, the AI assistant answered`);
  c.state('greeting', 'greet');
  await c.say('ai', cfg.script.find(s => s.step === 'greet').say);
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

  c.mode('transferring');
  c.system('Transferring the call to the administrator');
  App.incoming = { phone, label: 'Transfer from AI assistant · urgent case', ringUntil: null, canAnswer: false };
  render();

  if (!adminAnswers) {
    await c.wait(8000);
    App.incoming = null;
    c.mode('ai');
    c.system('The administrator did not pick up');
    await c.say('ai', cfg.handoff.admin_no_answer.say);
    c.saveDraft();
    await c.say('caller', 'Okay, please call me soon.');
    await c.wait(800);
    c.end('callback');
    return;
  }

  await c.wait(3000);
  App.incoming = null;
  c.mode('admin');
  c.system('Administrator joined. Collected data and transcript are on this page.');
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
  await c.wait(800);
  c.end('handoff');
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

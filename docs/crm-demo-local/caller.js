/*
 * Fake caller page. Same call flow as a real phone call, without a phone line:
 *   1. Ring the administrator page (Realtime Broadcast) for admin_ring_timeout_sec.
 *   2. Answered -> WebRTC audio with the administrator page (UC2).
 *   3. Not answered -> Vapi web call with the clinic assistant (UC1).
 *   4. The assistant hands over -> stop the Vapi call, ring the administrator again (UC3);
 *      not answered in 20 s -> apology, Draft, call back later.
 * The fake-call Edge Function keeps the calls table in the same states as a real call.
 */
const CFG = window.DEMO_CONFIG;
const $ = s => document.querySelector(s);
const TRANSFER_RING_SEC = 20;
const VAPI_SDK = 'https://cdn.jsdelivr.net/npm/@vapi-ai/web@2.7.1/+esm';

const S = {
  sb: null, ch: null, config: null,
  phase: 'idle',            // idle | ringing | admin | ai | transfer-ring | ended
  callId: null, mic: null, pc: null, vapi: null, stateCh: null, timer: null,
  speaking: false, lastSpeechEnd: 0, transferPending: false,
};

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.add('hidden'), 4000);
}

function log(text) {
  const d = document.createElement('div');
  d.textContent = `${new Date().toLocaleTimeString('en-CA', { hour12: false })}  ${text}`;
  $('#callLog').appendChild(d);
  $('#callLog').scrollTop = $('#callLog').scrollHeight;
}

function setStatus(text, cls = '') {
  $('#callStatus').textContent = text;
  $('#callStatus').className = 'pill ' + cls;
  const busy = S.phase !== 'idle';
  $('#callBtn').disabled = busy;
  $('#hangupBtn').disabled = !busy;
  $('#phone').disabled = busy;
}

async function fn(name, body, retried = false) {
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
      return fn(name, body, true);
    }
  }
  if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
  return r.json();
}

const action = (name, extra) => fn('fake-call', { action: name, call_id: S.callId, ...extra });
const send = (event, payload) => FakeCall.send(S.ch, event, { call_id: S.callId, ...payload });

/* ---------- Ringing the administrator ---------- */

function ring(transfer) {
  S.phase = transfer ? 'transfer-ring' : 'ringing';
  send('ring', { phone: $('#phone').value.trim(), transfer });
  const sec = transfer ? TRANSFER_RING_SEC : S.config.clinic.admin_ring_timeout_sec;
  S.timer = setTimeout(transfer ? transferFailed : noAdmin, sec * 1000);
  setStatus(transfer ? 'Transferring to the administrator…' : 'Ringing…', 'warn');
  log(transfer ? `Ringing the administrator again (${sec} s)` : `Ringing the administrator (${sec} s)`);
}

async function onMessage(ev, p) {
  if (!S.callId || p.call_id !== S.callId) return;
  try {
    if (ev === 'accept' && (S.phase === 'ringing' || S.phase === 'transfer-ring')) {
      clearTimeout(S.timer);
      S.phase = 'admin';
      setStatus('Talking to the administrator', 'ok');
      log('The administrator answered');
      S.pc = FakeCall.peer(S.mic, FakeCall.play);
      send('offer', { sdp: await FakeCall.offer(S.pc) });
    } else if (ev === 'answer' && S.pc) {
      await S.pc.setRemoteDescription(p.sdp);
    } else if (ev === 'decline') {
      clearTimeout(S.timer);
      log('The administrator declined');
      if (S.phase === 'ringing') noAdmin();
      if (S.phase === 'transfer-ring') transferFailed();
    } else if (ev === 'hangup') {
      finish('The administrator hung up');
    }
  } catch (e) {
    console.error(e); toast(e.message);
  }
}

/* ---------- AI assistant (Vapi web call) ---------- */

async function noAdmin() {
  if (S.phase !== 'ringing') return;
  send('cancel', {});
  S.phase = 'ai';
  log('No answer, the AI assistant answers');
  setStatus('Talking to the AI assistant', 'accent');
  try {
    await action('ai');
    await startVapi();
  } catch (e) {
    console.error(e); toast(e.message); finish('Cannot start the AI assistant');
  }
}

async function startVapi() {
  if (!CFG.vapiPublicKey || !CFG.vapiAssistantId) throw new Error('Set vapiPublicKey and vapiAssistantId in config.js');
  const mod = await import(VAPI_SDK);
  const Vapi = mod.default?.default || mod.default;
  const vapi = new Vapi(CFG.vapiPublicKey);
  S.vapi = vapi;
  vapi.on('speech-start', () => { S.speaking = true; });
  vapi.on('speech-end', () => { S.speaking = false; S.lastSpeechEnd = Date.now(); });
  vapi.on('message', m => {
    const calls = m.toolCallList || m.toolCalls || [];
    if (m.type === 'transfer-update' || (m.type === 'tool-calls' && calls.some(t => (t.function?.name || t.name) === 'transferCall'))) {
      requestTransfer();
    }
  });
  vapi.on('call-end', () => { if (S.phase === 'ai') finish('The AI assistant ended the call'); });
  vapi.on('error', e => { console.error(e); log('AI assistant error: ' + (e?.error?.message || e?.message || 'see console')); });

  // The assistant reports stage "handoff" with update_call_state just before it says the handoff phrase.
  S.stateCh = S.sb.channel(`fake-call-state-${S.callId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'call_state', filter: `call_id=eq.${S.callId}` },
      p => { if (p.new?.stage === 'handoff') requestTransfer(); })
    .subscribe();

  // metadata.call_id lets vapi-webhook attach the Vapi call to this calls row.
  await vapi.start(CFG.vapiAssistantId, { metadata: { call_id: S.callId } });
}

// Wait until the assistant has finished the handoff phrase, then hand the call over.
async function requestTransfer() {
  if (S.phase !== 'ai' || S.transferPending) return;
  S.transferPending = true;
  log('The AI assistant hands the call over');
  const t0 = Date.now();
  while (Date.now() - t0 < 12000) {
    if (!S.speaking && (S.lastSpeechEnd > t0 || Date.now() - t0 > 4000)) break;
    await new Promise(r => setTimeout(r, 200));
  }
  await new Promise(r => setTimeout(r, 700));
  if (S.phase !== 'ai') return;
  S.phase = 'transfer-ring';   // before stopping Vapi, so call-end does not end the call
  try {
    await action('transfer');
  } catch (e) {
    console.error(e); toast(e.message);
  }
  S.vapi?.stop();
  S.vapi = null;
  ring(true);
}

async function transferFailed() {
  if (S.phase !== 'transfer-ring') return;
  send('cancel', {});
  S.phase = 'ended';
  log('The administrator did not pick up');
  setStatus('Administrator not available', 'bad');
  let say = S.config.handoff.admin_no_answer.say;
  try { say = (await action('no-answer')).say || say; } catch (e) { console.error(e); toast(e.message); }
  const u = new SpeechSynthesisUtterance(say);
  u.lang = 'en-US';
  u.onend = u.onerror = () => finish(null);
  speechSynthesis.speak(u);
  log('Apology played, the call ends');
}

/* ---------- Start and end ---------- */

async function startCall() {
  if (!CFG.supabaseUrl || !CFG.supabaseAnonKey) { toast('Set supabaseUrl and supabaseAnonKey in config.js'); return; }
  $('#callLog').innerHTML = '';
  try {
    S.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    S.phase = 'ringing';
    setStatus('Connecting…', 'warn');
    S.callId = (await fn('fake-call', { action: 'start', phone: $('#phone').value.trim() })).call_id;
    S.transferPending = false;
    ring(false);
  } catch (e) {
    console.error(e); toast(e.message);
    finish('Cannot start the call');
  }
}

async function finish(reason) {
  if (S.phase === 'idle') return;
  clearTimeout(S.timer);
  if (S.callId) {
    if (S.phase === 'ringing' || S.phase === 'transfer-ring') send('cancel', {});
    if (S.pc) send('hangup', {});
  }
  const vapi = S.vapi;
  S.vapi = null;
  S.phase = 'idle';
  vapi?.stop();
  FakeCall.close(S.pc, S.mic);
  S.pc = null; S.mic = null;
  if (S.stateCh) { S.sb.removeChannel(S.stateCh); S.stateCh = null; }
  if (reason) log(reason);
  if (S.callId) await action('end').catch(e => console.error(e));
  S.callId = null;
  setStatus('Call ended');
}

async function init() {
  try {
    S.config = await fetch('agent-config.json').then(r => r.json());
    $('#clinicName').textContent = `Call ${S.config.clinic.name}`;
  } catch (e) {
    toast('Cannot load agent-config.json'); return;
  }
  if (CFG.supabaseUrl && CFG.supabaseAnonKey) {
    S.sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey);
    S.ch = FakeCall.join(S.sb, onMessage);
  }
  $('#callBtn').addEventListener('click', startCall);
  $('#hangupBtn').addEventListener('click', () => finish('You hung up'));
  setStatus('Idle');
}

init();

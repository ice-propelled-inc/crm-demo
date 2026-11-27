'use strict';

/*
 * Web chat for visitors (?biz=<business set>). The chat Edge Function stores the messages and lets the AI reply
 * when it leads; the administrator replies from the Call Desk page. This page reads its messages over Realtime.
 * Who replies first follows the operation mode: while the administrator is Available (Overflow, Copilot) the chat
 * waits chat_timeout_sec, then asks the function to let the AI take over. A handoff waits the same time.
 */
const CFG = window.DEMO_CONFIG || {};
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const S = { sb: null, ch: null, business: 'dental', callId: null, mode: null, wait: 30, timer: null, seen: new Set(), busy: false };

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg; el.classList.remove('hidden');
  clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.add('hidden'), 4000);
}

async function fn(body) {
  const base = CFG.functionsUrl || `${CFG.supabaseUrl}/functions/v1`;
  const r = await fetch(`${base}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CFG.supabaseAnonKey}`, apikey: CFG.supabaseAnonKey },
    body: JSON.stringify({ call_id: S.callId, ...body }),
  });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(out.error || `chat: HTTP ${r.status}`);
  return out;
}

const WHO = { ai: 'Assistant', admin: 'Front desk', caller: 'You' };
function addMessage(m) {
  if (m.id && S.seen.has(m.id)) return;
  if (m.id) S.seen.add(m.id);
  const box = $('#messages');
  box.insertAdjacentHTML('beforeend', m.speaker === 'system'
    ? `<div class="sysmsg">${esc(m.text)}</div>`
    : `<div class="turn ${m.speaker === 'caller' ? 'admin' : m.speaker === 'admin' ? 'caller' : 'ai'}"><div class="by">${WHO[m.speaker] || ''}</div>${esc(m.text)}</div>`);
  box.scrollTop = box.scrollHeight;
}

const STATUS = {
  ringing: 'Connecting you with our team…', ai: 'You are chatting with our AI assistant.',
  admin: 'You are chatting with our front desk.', transferring: 'Inviting a team member…', ended: 'The chat has ended.',
};
function setMode(mode) {
  if (!mode || mode === S.mode) return;
  S.mode = mode;
  $('#chatStatus').textContent = STATUS[mode] || '';
  $('#endBtn').disabled = mode === 'ended';
  $('#text').disabled = mode === 'ended';
  clearTimeout(S.timer);
  // Nobody replied in time: the function lets the AI take over, or turns a failed handoff into a callback task.
  if (mode === 'ringing' || mode === 'transferring') {
    S.timer = setTimeout(() => fn({ action: 'timeout' }).then(o => setMode(o.mode)).catch(e => toast(e.message)), S.wait * 1000);
  }
}

async function start() {
  const out = await fn({ action: 'start', business: S.business });
  S.callId = out.call_id;
  S.wait = out.wait_sec || 30;
  S.ch = S.sb.channel(`chat-${S.callId}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'call_messages', filter: `call_id=eq.${S.callId}` }, p => addMessage(p.new))
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'calls', filter: `id=eq.${S.callId}` },
      p => setMode(p.new.status === 'ended' ? 'ended' : p.new.mode))
    .subscribe();
  // Messages written before the subscription was ready (the AI greeting).
  const { data } = await S.sb.from('call_messages').select('*').eq('call_id', S.callId).order('created_at');
  (data || []).forEach(addMessage);
  setMode(out.mode);
}

async function send(e) {
  e.preventDefault();
  const text = $('#text').value.trim();
  if (!text || S.busy || S.mode === 'ended') return;
  S.busy = true;
  $('#text').value = '';
  try {
    if (!S.callId) await start();
    await fn({ action: 'message', text });
  } catch (err) {
    console.error(err); toast(err.message);
  } finally {
    S.busy = false;
    $('#text').focus();
  }
}

async function init() {
  try {
    let list = [{ id: 'dental', path: '.' }];
    if (CFG.businessSets) list = await fetch('businesses/index.json').then(r => r.json());
    const biz = list.find(b => b.id === new URLSearchParams(location.search).get('biz')) || list[0];
    S.business = biz.id;
    const config = await fetch(`${biz.path}/agent-config.json`).then(r => r.json());
    const info = config.clinic || config.business;
    $('#clinicName').textContent = info.name;
    $('#logo').textContent = config.labels?.logo || 'BS';
    document.title = `${info.name} · Chat`;
  } catch (_) { /* keep defaults */ }
  if (!CFG.supabaseUrl || !CFG.supabaseAnonKey) {
    $('#chatStatus').textContent = 'The chat needs Live mode: set supabaseUrl and supabaseAnonKey in config.js.';
    $('#text').disabled = true;
    return;
  }
  S.sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey);
  $('#composer').addEventListener('submit', send);
  $('#endBtn').addEventListener('click', () => fn({ action: 'end' }).then(() => setMode('ended')).catch(e => toast(e.message)));
}

init();

/*
 * Fake page-to-page call: shared by caller.html (the caller) and index.html (the administrator).
 * Signalling goes over the Supabase Realtime Broadcast channel "fake-call"; audio goes browser to
 * browser over WebRTC. Every message carries call_id.
 *   caller -> admin: ring { phone, transfer }, cancel, offer { sdp }, hangup
 *   admin -> caller: accept, decline, answer { sdp }, hangup
 * SDP is sent once ICE gathering is complete, so no separate ICE messages are needed.
 */
const FakeCall = {
  join(sb, onMessage) {
    const ch = sb.channel('fake-call', { config: { broadcast: { self: false } } });
    ['ring', 'cancel', 'offer', 'hangup', 'accept', 'decline', 'answer']
      .forEach(ev => ch.on('broadcast', { event: ev }, m => onMessage(ev, m.payload || {})));
    ch.subscribe();
    return ch;
  },

  send(ch, event, payload) {
    return ch.send({ type: 'broadcast', event, payload });
  },

  peer(localStream, onRemote) {
    const pc = new RTCPeerConnection({ iceServers: window.DEMO_CONFIG.iceServers || [] });
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
    pc.ontrack = e => onRemote(e.streams[0]);
    return pc;
  },

  async gathered(pc) {
    if (pc.iceGatheringState === 'complete') return;
    await new Promise(resolve => {
      const t = setTimeout(resolve, 3000);
      pc.addEventListener('icegatheringstatechange', () => {
        if (pc.iceGatheringState === 'complete') { clearTimeout(t); resolve(); }
      });
    });
  },

  async offer(pc) {
    await pc.setLocalDescription(await pc.createOffer());
    await this.gathered(pc);
    return { type: pc.localDescription.type, sdp: pc.localDescription.sdp };
  },

  async answer(pc, offer) {
    await pc.setRemoteDescription(offer);
    await pc.setLocalDescription(await pc.createAnswer());
    await this.gathered(pc);
    return { type: pc.localDescription.type, sdp: pc.localDescription.sdp };
  },

  play(stream) {
    const el = document.getElementById('fakeCallAudio') || Object.assign(document.createElement('audio'), { id: 'fakeCallAudio', autoplay: true });
    if (!el.isConnected) document.body.appendChild(el);
    el.srcObject = stream;
    el.play().catch(() => {});
  },

  close(pc, stream) {
    try { pc?.close(); } catch (_) { /* ignore */ }
    stream?.getTracks().forEach(t => t.stop());
  },
};

/*
 * Demo page configuration. Leave the Supabase values empty to use Replay mode only.
 * Only public values go here: the page is served as static files on GitHub Pages.
 *
 * Live mode expects this backend contract:
 *
 * Supabase tables (Realtime enabled, readable with the anon key):
 *   calls          id, phone, started_at, ended_at, status ('ringing'|'active'|'ended'),
 *                  mode ('ringing'|'ai'|'admin'|'transferring'), outcome, handoff_reason, recording_url
 *   call_messages  id, call_id, speaker ('ai'|'caller'|'admin'|'system'), text, created_at
 *   call_state     call_id (PK), stage, script_step, fields (jsonb), handoff_reason, updated_at
 *   appointments   id, call_id, doctor_id, service_id, start, end ('YYYY-MM-DDTHH:MM' clinic local time),
 *                  name, phone, patient_type, complaint, insurance_number, status
 *                  (the anon role must be allowed to update the status column)
 *
 * Supabase Edge Functions (POST, JSON):
 *   twilio-token    -> { token }  Twilio Voice access token for the admin softphone (identity "admin")
 *   deepgram-token  -> { key }    short-lived Deepgram key for UC2 transcription
 *   fake-call       { action, call_id, phone } -> call states for the fake page-to-page call (caller.html)
 *   observe         { call_id, speaker, text } -> stores the message, runs the observer LLM,
 *                   writes call_state
 *
 * Twilio incoming calls to the softphone carry custom parameters:
 *   call_id   the calls.id of this call
 *   transfer  "1" when the call is a transfer from the AI assistant
 */
window.DEMO_CONFIG = {
  supabaseUrl: "https://vhduwkhohqarrxysdcvc.supabase.co",
  supabaseAnonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZoZHV3a2hvaHFhcnJ4eXNkY3ZjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTU1MzEzMjgsImV4cCI6MjExMTEwNzMyOH0.m_TxMRnu1G40dZa0Ay2IhIPNdcL6I3ribsBAA4-LTsY",
  functionsUrl: "",        // default: <supabaseUrl>/functions/v1
  enableSoftphone: true,
  // Fake page-to-page call (caller.html): WebRTC audio, signalling over Supabase Realtime Broadcast.
  enableFakeCall: true,
  vapiPublicKey: "",       // Vapi public key (safe for the browser) for the AI part of the fake call
  vapiAssistantId: "",     // id printed by scripts/deploy_vapi_assistant.py
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  defaultMode: "replay"    // "replay" or "live"
};

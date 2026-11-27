/*
 * Demo page configuration. Leave the Supabase values empty to use Replay mode only.
 * Only public values go here: the page is served as static files on GitHub Pages.
 *
 * Live mode expects this backend contract (supabase/migrations, supabase/functions):
 *
 * Supabase tables (Realtime enabled, readable with the anon key; rows carry "business"):
 *   calls             id, phone, channel ('phone'|'chat'), started_at, ended_at, status ('ringing'|'active'|'ended'),
 *                     mode ('ringing'|'ai'|'admin'|'transferring'), outcome, handoff_reason, recording_url
 *   call_messages     id, call_id, speaker ('ai'|'caller'|'admin'|'system'), text, created_at
 *   call_state        call_id (PK), stage, script_step, fields (jsonb), handoff_reason, suggestions (jsonb)
 *   appointments      id, call_id, doctor_id, service_id, start, end ('YYYY-MM-DDTHH:MM' local time), name, phone,
 *                     patient_type, complaint, insurance_type, insurance_company, insurance_member_id, details, status
 *                     (the anon role may update the status column)
 *   tasks             id, type, status, name, phone, reason, call_id, appointment_id, due_at
 *   notifications     id, appointment_id, event, channel, recipient, text, status ('sent'|'simulated'|'failed')
 *   business_settings business, operation_mode, admin_availability, notifications
 *   business_data     business, config, schedule  (clinic data edited on the page; no row = the seed files)
 *
 * Supabase Edge Functions (POST, JSON):
 *   twilio-token    -> { token }  Twilio Voice access token for the admin softphone (identity "admin")
 *   deepgram-token  -> { key }    short-lived Deepgram key for UC2 transcription
 *   observe         { call_id, speaker, text } -> stores the message, runs the observer LLM (state, suggestions)
 *   admin           settings, clinic data, task status, chat replies (see supabase/functions/admin)
 *   chat            the visitor web chat (chat.html)
 *
 * Twilio incoming calls to the softphone carry custom parameters: call_id, and transfer = "1" for a handoff.
 */
window.DEMO_CONFIG = {
  supabaseUrl: "https://vhduwkhohqarrxysdcvc.supabase.co",
  supabaseAnonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZoZHV3a2hvaHFhcnJ4eXNkY3ZjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTU1MzEzMjgsImV4cCI6MjExMTEwNzMyOH0.m_TxMRnu1G40dZa0Ay2IhIPNdcL6I3ribsBAA4-LTsY",
  functionsUrl: "",        // default: <supabaseUrl>/functions/v1
  enableSoftphone: true,
  softphone: "twilio",       // "twilio" or "telnyx"
  defaultMode: "replay"    // "replay" or "live"
};

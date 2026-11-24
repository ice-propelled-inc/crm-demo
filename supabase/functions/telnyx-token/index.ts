// Telnyx WebRTC login token for the admin softphone (valid 24 h).
// TELNYX_CREDENTIAL_ID is a telephony credential of the credential SIP connection the softphone registers on.
import { CORS, env, json, pinError } from "../_shared/common.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const denied = pinError(req);
  if (denied) return denied;
  try {
    const r = await fetch(`https://api.telnyx.com/v2/telephony_credentials/${env("TELNYX_CREDENTIAL_ID")}/token`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env("TELNYX_API_KEY")}` },
    });
    if (!r.ok) throw new Error(`Telnyx token: HTTP ${r.status}`);
    return json({ token: (await r.text()).trim() });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});

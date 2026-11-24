// Short-lived Deepgram token for the page's UC2 streaming transcription. The Deepgram API key never reaches the page.
import { CORS, env, json, pinError } from "../_shared/common.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const denied = pinError(req);
  if (denied) return denied;
  const r = await fetch("https://api.deepgram.com/v1/auth/grant", {
    method: "POST",
    headers: { Authorization: `Token ${env("DEEPGRAM_API_KEY")}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ttl_seconds: 60 }),
  });
  if (!r.ok) return json({ error: `Deepgram: HTTP ${r.status}` }, 502);
  const { access_token } = await r.json();
  // The token is only needed to open the WebSocket; the open connection outlives it.
  return json({ key: access_token, scheme: "bearer" });
});

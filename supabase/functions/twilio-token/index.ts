// Twilio Voice access token for the admin softphone (identity "admin", incoming calls only).
import { CORS, env, json, pinError } from "../_shared/common.ts";

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));

async function accessToken(identity: string): Promise<string> {
  const keySid = env("TWILIO_API_KEY_SID");
  const now = Math.floor(Date.now() / 1000);
  const header = { typ: "JWT", alg: "HS256", cty: "twilio-fpa;v=1" };
  const payload = {
    jti: `${keySid}-${now}`, iss: keySid, sub: env("TWILIO_ACCOUNT_SID"), iat: now, nbf: now, exp: now + 3600,
    grants: { identity, voice: { incoming: { allow: true } } },
  };
  const unsigned = `${enc(header)}.${enc(payload)}`;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env("TWILIO_API_KEY_SECRET")),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(unsigned)));
  return `${unsigned}.${b64url(sig)}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const denied = pinError(req);
  if (denied) return denied;
  try {
    return json({ token: await accessToken("admin") });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});

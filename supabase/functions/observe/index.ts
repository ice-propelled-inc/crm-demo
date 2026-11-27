// UC2 observer: the page sends each final utterance of the administrator's call.
// Stores the message, then the observer LLM updates the call state and the suggestions (see _shared/observer.ts).
import { CORS, db, json, pinError } from "../_shared/common.ts";
import { observe } from "../_shared/observer.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const denied = pinError(req);
  if (denied) return denied;

  const { call_id, speaker, text } = await req.json();
  if (!call_id || !text || !["admin", "caller"].includes(speaker)) return json({ error: "call_id, speaker and text are required" }, 400);

  try {
    await db.from("call_messages").insert({ call_id, speaker, text });
    return json({ ok: true, ...(await observe(call_id)) });
  } catch (e) {
    console.error(e);
    return json({ error: (e as Error).message }, 500);
  }
});

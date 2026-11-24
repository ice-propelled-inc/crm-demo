"""Create or update the demo Vapi assistant from docs/agent-config.json and docs/schedule.json.

Also creates or updates the Vapi SIP number (VAPI_SIP_URI) that Twilio forwards unanswered calls to.

Usage:
    $env:VAPI_API_KEY = "<private API key from the Vapi dashboard>"
    python scripts/deploy_vapi_assistant.py            # create or update
    python scripts/deploy_vapi_assistant.py --dry-run  # print the payload only

Shared values are read from supabase/.env (same file as the Edge Function secrets):
    VAPI_SECRET, VAPI_SIP_URI, FUNCTIONS_PUBLIC_URL
Optional (environment or supabase/.env):
    VAPI_MODEL_PROVIDER (default openai), VAPI_MODEL (default gpt-4o-mini),
    VAPI_VOICE_PROVIDER (default vapi), VAPI_VOICE_ID (default Elliot),
    ADMIN_TRANSFER_SIP (default sip:admin@transfer.invalid; Twilio handles the REFER, the target is not dialled)
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
API = "https://api.vapi.ai"


def load_env() -> dict[str, str]:
    values: dict[str, str] = {}
    env_file = ROOT / "supabase" / ".env"
    if env_file.exists():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, value = line.split("=", 1)
                values[key.strip()] = value.strip()
    values.update({k: v for k, v in os.environ.items() if k.startswith(("VAPI_", "FUNCTIONS_", "ADMIN_"))})
    return values


def build_prompt(config: dict, schedule: dict) -> str:
    clinic = config["clinic"]
    tz = clinic["timezone"]
    rules = config["rules"]
    handoff = config["handoff"]
    lines = [
        f"You are the phone assistant of {clinic['name']}, a dental clinic. Speak English only.",
        "Be warm, brief and clear: one question at a time, short sentences, no lists or markdown.",
        f'Current date and time in the clinic: {{{{"now" | date: "%A, %B %d, %Y, %I:%M %p", "{tz}"}}}}.',
        "Caller phone number (caller ID): {{customer.number}}.",
        "",
        "## Rules",
        f"- {rules['no_medical_advice']}",
        f"- {rules['doctor_choice']}",
        f"- {rules['booking']}",
        f"- {rules['state_updates']} Pass the stage id, the script step id and all fields collected so far.",
        "- Use only the knowledge base and the services list below. Never invent prices, doctors or slots.",
        "- Always get slots from get_free_slots and book only slots it returned. Dates are YYYY-MM-DD, times HH:MM, clinic local time.",
        "",
        "## Slot selection",
        *[f"{i}. {r}" for i, r in enumerate(rules["slot_selection"], 1)],
        "Use get_free_slots with date for the same date, with time (and a later date) for the same time on another date,"
        " and without both for the nearest slots.",
        "",
        "## Reschedule or cancel",
        *[f"- {r}" for r in rules["appointment_lookup"]],
        "Use find_appointments with the caller's phone number, then reschedule or cancel.",
        "",
        "## Handoff to the administrator",
        "Hand the call over when:",
        *[f"- {t['description']} (handoff_reason: {t['id']})" for t in handoff["triggers"]],
        "For an urgent case:",
        *[f"- {s}" for s in handoff["urgent_case_steps"]],
        "Before the transfer, call update_call_state with stage handoff and the handoff_reason, then say:"
        f' "{handoff["say_before_transfer"]}" and call transferCall.',
        "",
        "## Funnel stages (id: label)",
        *[f"- {s['id']}: {s['label']}" for s in config["funnel_stages"]],
        "",
        "## Script (step id / stage: what to say or do)",
        *[f"- {s['step']} / {s['stage']}: {s.get('say') or s.get('goal')}" for s in config["script"]],
        "",
        "## Appointment fields (field id: label)",
        *[
            f"- {f['id']}: {f['label']}{' (required)' if f['required'] else ' (optional)'}"
            + (f" - {f['note']}" if f.get("note") else "")
            for f in config["appointment_fields"]
        ],
        "",
        f"## Services (prices in {clinic['currency']})",
        *[
            f"- {s['id']}: {s['name']}, {s['price_min']}-{s['price_max']}, about {s['duration_min']} min,"
            f" {s['speciality']}{', urgent' if s['urgent'] else ''}"
            for s in config["services"]
        ],
        "",
        "## Doctors",
        *[f"- {d['id']}: {d['name']}, {d['speciality_label']} ({d['speciality']})" for d in schedule["doctors"]],
        "",
        "## Knowledge base",
        *[f"Q: {f['q']}\nA: {f['a']}" for f in config["knowledge_base"]["faq"]],
    ]
    return "\n".join(lines)


def build_assistant(config: dict, schedule: dict, env: dict[str, str]) -> dict:
    server = {
        "url": env["FUNCTIONS_PUBLIC_URL"].rstrip("/") + "/vapi-webhook",
        "headers": {"x-vapi-secret": env["VAPI_SECRET"]},
    }
    tools = [
        {"type": "function", "function": t}
        for t in config["tools"]
        if t["name"] != "transfer_to_admin"  # replaced by Vapi's own transferCall tool
    ]
    tools.append({
        "type": "transferCall",
        "destinations": [{
            "type": "sip",
            "sipUri": env.get("ADMIN_TRANSFER_SIP", "sip:admin@transfer.invalid"),
            "description": "Clinic administrator",
        }],
    })
    stt = config["speech_to_text"]
    greet = next(s["say"] for s in config["script"] if s["step"] == "greet")
    return {
        "name": f"{config['clinic']['name']} demo",
        "firstMessage": greet,
        "firstMessageMode": "assistant-speaks-first",
        "model": {
            "provider": env.get("VAPI_MODEL_PROVIDER", "openai"),
            "model": env.get("VAPI_MODEL", "gpt-4o-mini"),
            "temperature": 0.3,
            "messages": [{"role": "system", "content": build_prompt(config, schedule)}],
            "tools": tools,
        },
        "voice": {"provider": env.get("VAPI_VOICE_PROVIDER", "vapi"), "voiceId": env.get("VAPI_VOICE_ID", "Elliot")},
        "transcriber": {
            "provider": stt["provider"], "model": stt["model"], "language": stt["language"], "keyterm": stt["keyterms"],
        },
        "server": server,
        "serverMessages": ["transcript", "status-update", "tool-calls", "end-of-call-report"],
        "endCallFunctionEnabled": True,
        "artifactPlan": {"recordingEnabled": True},
    }


def call(method: str, path: str, key: str, body: dict | None = None):
    req = urllib.request.Request(
        API + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        # Cloudflare in front of api.vapi.ai rejects the default Python-urllib user agent (error 1010).
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json", "User-Agent": "crm-demo-deploy/1.0"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        sys.exit(f"Vapi {method} {path} failed: HTTP {e.code} {e.read().decode(errors='replace')}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dry-run", action="store_true", help="print the assistant payload and exit")
    args = parser.parse_args()

    env = load_env()
    missing = [k for k in ("VAPI_SECRET", "VAPI_SIP_URI", "FUNCTIONS_PUBLIC_URL") if not env.get(k)]
    if missing and not args.dry_run:
        sys.exit(f"Missing in supabase/.env or environment: {', '.join(missing)}")
    if args.dry_run:
        env = {"VAPI_SECRET": "<secret>", "VAPI_SIP_URI": "sip:<name>@sip.vapi.ai",
               "FUNCTIONS_PUBLIC_URL": "https://<ref>.supabase.co/functions/v1", **{k: v for k, v in env.items() if v}}

    config = json.loads((ROOT / "docs" / "agent-config.json").read_text(encoding="utf-8"))
    schedule = json.loads((ROOT / "docs" / "schedule.json").read_text(encoding="utf-8"))
    assistant = build_assistant(config, schedule, env)

    if args.dry_run:
        shown = json.loads(json.dumps(assistant))
        shown["server"]["headers"]["x-vapi-secret"] = "<hidden>"
        print(json.dumps(shown, indent=2, ensure_ascii=False))
        return

    key = env.get("VAPI_API_KEY")
    if not key:
        sys.exit("Set VAPI_API_KEY (private key from the Vapi dashboard) in the environment.")

    existing = next((a for a in call("GET", "/assistant?limit=100", key) if a.get("name") == assistant["name"]), None)
    if existing:
        result = call("PATCH", f"/assistant/{existing['id']}", key, assistant)
        print(f"Updated assistant {result['id']}")
    else:
        result = call("POST", "/assistant", key, assistant)
        print(f"Created assistant {result['id']}")
    assistant_id = result["id"]

    sip_uri = env["VAPI_SIP_URI"]
    numbers = call("GET", "/phone-number?limit=100", key)
    number = next((n for n in numbers if n.get("sipUri") == sip_uri), None)
    if number:
        call("PATCH", f"/phone-number/{number['id']}", key, {"assistantId": assistant_id})
        print(f"SIP number {sip_uri} now uses the assistant")
    else:
        created = call("POST", "/phone-number", key, {
            "provider": "vapi", "sipUri": sip_uri, "assistantId": assistant_id, "name": "Twilio forward",
        })
        print(f"Created SIP number {created.get('sipUri', sip_uri)}")


if __name__ == "__main__":
    main()

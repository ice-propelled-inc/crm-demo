import { useEffect, useState } from "react";
import { send, type Schemas } from "../api/client";
import { errorText, useLoad } from "../useLoad";

type Settings = Schemas["TenantSettings"];
type Delays = Schemas["DelaySettings"];

const lines = (text: string) =>
  text
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

export function ConfigSection() {
  const { data, error, setError } = useLoad<Schemas["ConfigOut"]>("/admin/api/config");
  const [form, setForm] = useState<Settings | null>(null);
  const [saved, setSaved] = useState<number | null>(null);

  useEffect(() => {
    if (data) setForm(data.settings);
  }, [data]);

  if (error && !form) return <p className="error">{error}</p>;
  if (!form || !data) return <p>Loading…</p>;

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setForm({ ...form, [key]: value });
  const delays = form.delays as Delays;
  const setDelay = (key: keyof Delays, value: string) =>
    set("delays", { ...delays, [key]: Number(value) });

  async function save() {
    try {
      const result = await send<Schemas["ConfigOut"]>("PUT", "/admin/api/config", form);
      setSaved(result.version);
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }

  return (
    <form
      className="card"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <h2>Settings</h2>
      <div className="grid">
        <label>
          Business name
          <input value={form.business_name ?? ""} onChange={(e) => set("business_name", e.target.value)} />
        </label>
        <label>
          Default language
          <input value={form.default_language ?? ""} onChange={(e) => set("default_language", e.target.value)} />
        </label>
        <label>
          Tone of voice
          <select value={form.tone_preset ?? ""} onChange={(e) => set("tone_preset", e.target.value)}>
            {data.tone_presets.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={form.use_dialog_dataset ?? true}
            onChange={(e) => set("use_dialog_dataset", e.target.checked)}
          />
          Learn tone from the dialog dataset
        </label>
        <label>
          Topic restriction
          <select
            value={form.restriction_level ?? "medium"}
            onChange={(e) => set("restriction_level", e.target.value as Settings["restriction_level"])}
          >
            <option value="medium">medium: small talk, back to topic in 3 messages</option>
            <option value="high">high: briefly decline other topics</option>
            <option value="strict">strict: only products and orders</option>
          </select>
        </label>
        <label>
          AI confidence limit for a handoff
          <input
            type="number"
            min={0}
            max={1}
            step={0.05}
            value={form.confidence_limit ?? 0.6}
            onChange={(e) => set("confidence_limit", Number(e.target.value))}
          />
        </label>
        <label>
          Operator accept time limit (s)
          <input
            type="number"
            min={10}
            value={form.operator_accept_timeout_seconds ?? 60}
            onChange={(e) => set("operator_accept_timeout_seconds", Number(e.target.value))}
          />
        </label>
        <label>
          Order status check interval (min)
          <input
            type="number"
            min={1}
            value={form.status_check_interval_minutes ?? 10}
            onChange={(e) => set("status_check_interval_minutes", Number(e.target.value))}
          />
        </label>
        <label>
          WhatsApp notification language
          <input
            value={form.notification_language ?? "en"}
            onChange={(e) => set("notification_language", e.target.value)}
          />
        </label>
      </div>

      <h3>Delays that look human (seconds)</h3>
      <div className="grid four">
        {(["min_delay", "max_delay", "per_char_delay", "max_total_delay"] as const).map((key) => (
          <label key={key}>
            {key}
            <input
              type="number"
              min={0}
              step={key === "per_char_delay" ? 0.01 : 0.5}
              value={delays[key] ?? 0}
              onChange={(e) => setDelay(key, e.target.value)}
            />
          </label>
        ))}
      </div>

      <div className="grid">
        <label>
          Sales funnel stages (one for each line)
          <textarea
            rows={7}
            value={(form.funnel_stages ?? []).join("\n")}
            onChange={(e) => set("funnel_stages", lines(e.target.value))}
          />
        </label>
        <label>
          Harsh words (one for each line)
          <textarea
            rows={7}
            value={(form.harsh_keywords ?? []).join("\n")}
            onChange={(e) => set("harsh_keywords", lines(e.target.value))}
          />
        </label>
      </div>

      <h3>Catalog source</h3>
      <div className="grid">
        <label>
          Type
          <select
            value={form.catalog_source?.type ?? "crm_catalog"}
            onChange={(e) =>
              set("catalog_source", {
                ...form.catalog_source,
                type: e.target.value as "crm_catalog" | "external_api",
              })
            }
          >
            <option value="crm_catalog">CRM product catalog</option>
            <option value="external_api">External API</option>
          </select>
        </label>
        <label>
          External API URL
          <input
            disabled={form.catalog_source?.type !== "external_api"}
            value={form.catalog_source?.url ?? ""}
            onChange={(e) =>
              set("catalog_source", {
                ...form.catalog_source,
                type: form.catalog_source?.type ?? "crm_catalog",
                url: e.target.value || null,
              })
            }
          />
        </label>
      </div>

      {error && <p className="error">{error}</p>}
      {saved !== null && <p className="ok">Saved as version {saved}.</p>}
      <button type="submit">Save settings</button>
    </form>
  );
}

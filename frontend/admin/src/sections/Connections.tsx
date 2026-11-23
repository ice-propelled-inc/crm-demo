import { useEffect, useState } from "react";
import { send, type Schemas } from "../api/client";
import { errorText, useLoad } from "../useLoad";

const CREDENTIAL_FIELDS: Record<string, string[]> = {
  jivo: ["provider_id", "token"],
  instagram: ["access_token", "app_secret"],
};

export function ChannelsSection() {
  const { data, error, reload, setError } = useLoad<Schemas["ChannelOut"][]>("/admin/api/channels");
  const [kind, setKind] = useState<"jivo" | "instagram">("jivo");
  const [externalId, setExternalId] = useState("");
  const [credentials, setCredentials] = useState<Record<string, string>>({});

  async function add() {
    const filled = Object.fromEntries(Object.entries(credentials).filter(([, v]) => v));
    try {
      await send("POST", "/admin/api/channels", { kind, external_id: externalId, credentials: filled });
      setExternalId("");
      setCredentials({});
      await reload();
    } catch (e) {
      setError(errorText(e));
    }
  }

  return (
    <section>
      <h2>Channels</h2>
      <p className="muted">
        Credentials are encrypted and never shown again. Put the webhook URL into the channel settings (Jivo bot
        channel, Meta app). Tidio is not supported: its API has no live-chat bot interface.
      </p>
      <table>
        <thead>
          <tr>
            <th>Kind</th>
            <th>Account / widget</th>
            <th>Credentials</th>
            <th>Webhook URL</th>
            <th>Enabled</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {(data ?? []).map((c) => (
            <tr key={c.id}>
              <td>{c.kind}</td>
              <td>{c.external_id}</td>
              <td>{c.credential_keys.join(", ")}</td>
              <td>
                <code className="wrap">{c.webhook_url}</code>
              </td>
              <td>
                <input
                  type="checkbox"
                  aria-label={`Enable ${c.external_id}`}
                  checked={c.enabled}
                  onChange={async (e) => {
                    await send("PATCH", `/admin/api/channels/${c.id}`, { enabled: e.target.checked }).catch((err) =>
                      setError(errorText(err)),
                    );
                    await reload();
                  }}
                />
              </td>
              <td>
                <button
                  className="danger"
                  onClick={async () => {
                    if (!window.confirm(`Remove channel ${c.external_id}?`)) return;
                    await send("DELETE", `/admin/api/channels/${c.id}`).catch((e) => setError(errorText(e)));
                    await reload();
                  }}
                >
                  Remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <form
        className="inline"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <select aria-label="Channel kind" value={kind} onChange={(e) => setKind(e.target.value as "jivo" | "instagram")}>
          <option value="jivo">Jivo</option>
          <option value="instagram">Instagram</option>
        </select>
        <input
          placeholder={kind === "instagram" ? "Instagram account ID" : "Widget name"}
          aria-label="Account or widget"
          value={externalId}
          onChange={(e) => setExternalId(e.target.value)}
        />
        {CREDENTIAL_FIELDS[kind].map((field) => (
          <input
            key={field}
            type="password"
            placeholder={field === "token" ? "token (empty: generated)" : field}
            aria-label={field}
            value={credentials[field] ?? ""}
            onChange={(e) => setCredentials({ ...credentials, [field]: e.target.value })}
          />
        ))}
        <button type="submit" disabled={!externalId}>
          Add channel
        </button>
      </form>
      {error && <p className="error">{error}</p>}
    </section>
  );
}

export function CrmSection() {
  const { data, error, setError } = useLoad<Schemas["CrmConnectionOut"]>("/admin/api/crm-connection");
  const [form, setForm] = useState({ base_url: "", client_id: "", client_secret: "", webhook_secret: "" });
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (data) setForm((f) => ({ ...f, base_url: data.base_url, client_id: data.client_id }));
  }, [data]);

  if (!data) return error ? <p className="error">{error}</p> : <p>Loading…</p>;
  return (
    <form
      className="card"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await send("PUT", "/admin/api/crm-connection", {
            base_url: form.base_url,
            client_id: form.client_id,
            client_secret: form.client_secret || null,
            webhook_secret: form.webhook_secret || null,
          });
          setSaved(true);
          setForm({ ...form, client_secret: "", webhook_secret: "" });
        } catch (err) {
          setError(errorText(err));
        }
      }}
    >
      <h2>CRM connection (OAuth)</h2>
      <div className="grid">
        <label>
          CRM base URL
          <input value={form.base_url} onChange={(e) => setForm({ ...form, base_url: e.target.value })} />
        </label>
        <label>
          OAuth client ID
          <input value={form.client_id} onChange={(e) => setForm({ ...form, client_id: e.target.value })} />
        </label>
        <label>
          OAuth client secret {data.has_client_secret && <span className="muted">(set; empty keeps it)</span>}
          <input type="password" value={form.client_secret} onChange={(e) => setForm({ ...form, client_secret: e.target.value })} />
        </label>
        <label>
          Webhook secret {data.has_webhook_secret && <span className="muted">(set; empty keeps it)</span>}
          <input type="password" value={form.webhook_secret} onChange={(e) => setForm({ ...form, webhook_secret: e.target.value })} />
        </label>
      </div>
      <p>
        Order status webhook URL for the CRM: <code className="wrap">{data.webhook_url}</code>
      </p>
      {error && <p className="error">{error}</p>}
      {saved && <p className="ok">Saved.</p>}
      <button type="submit">Save connection</button>
    </form>
  );
}

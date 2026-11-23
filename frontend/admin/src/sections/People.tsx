import { useState } from "react";
import { send, type Schemas } from "../api/client";
import { errorText, useLoad } from "../useLoad";

export function OperatorsSection() {
  const { data, error, reload, setError } = useLoad<Schemas["OperatorOut"][]>("/admin/api/operators");
  const [form, setForm] = useState({ crm_user_id: "", name: "", whatsapp_number: "" });

  async function add() {
    try {
      await send("POST", "/admin/api/operators", { ...form, name: form.name || null });
      setForm({ crm_user_id: "", name: "", whatsapp_number: "" });
      await reload();
    } catch (e) {
      setError(errorText(e));
    }
  }

  return (
    <section>
      <h2>Operators</h2>
      <p className="muted">Each operator is a CRM user. The module sends handoff notifications to the WhatsApp number.</p>
      <table>
        <thead>
          <tr>
            <th>CRM user</th>
            <th>Name</th>
            <th>WhatsApp</th>
            <th>Available</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {(data ?? []).map((o) => (
            <tr key={o.id}>
              <td>{o.crm_user_id}</td>
              <td>{o.name}</td>
              <td>{o.whatsapp_number}</td>
              <td>{o.is_available ? "yes" : "no"}</td>
              <td>
                <button
                  className="danger"
                  onClick={async () => {
                    if (!window.confirm(`Remove operator ${o.crm_user_id}?`)) return;
                    await send("DELETE", `/admin/api/operators/${o.id}`).catch((e) => setError(errorText(e)));
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
        <input placeholder="CRM user ID" aria-label="CRM user ID" value={form.crm_user_id} onChange={(e) => setForm({ ...form, crm_user_id: e.target.value })} />
        <input placeholder="Name" aria-label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <input placeholder="+33600000000" aria-label="WhatsApp number" value={form.whatsapp_number} onChange={(e) => setForm({ ...form, whatsapp_number: e.target.value })} />
        <button type="submit" disabled={!form.crm_user_id || !form.whatsapp_number}>
          Add operator
        </button>
      </form>
      {error && <p className="error">{error}</p>}
    </section>
  );
}

type CommunicationType = Schemas["UrgentManagerIn"]["communication_types"][number];
const TYPES: CommunicationType[] = ["phone_call", "whatsapp_text"];

export function UrgentManagersSection() {
  const { data, error, reload, setError } = useLoad<Schemas["UrgentManagerOut"][]>("/admin/api/urgent-managers");
  const [form, setForm] = useState({ crm_user_id: "", name: "", phone_number: "" });
  const [types, setTypes] = useState<CommunicationType[]>(["phone_call", "whatsapp_text"]);

  async function add() {
    try {
      await send("POST", "/admin/api/urgent-managers", {
        ...form,
        name: form.name || null,
        communication_types: types,
      });
      setForm({ crm_user_id: "", name: "", phone_number: "" });
      await reload();
    } catch (e) {
      setError(errorText(e));
    }
  }

  return (
    <section>
      <h2>Urgent managers</h2>
      <p className="muted">
        When no operator accepts a handoff, the module alerts these people: a phone call (Twilio) and/or a WhatsApp
        text.
      </p>
      <table>
        <thead>
          <tr>
            <th>CRM user</th>
            <th>Name</th>
            <th>Phone</th>
            <th>Alerts</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {(data ?? []).map((m) => (
            <tr key={m.id}>
              <td>{m.crm_user_id}</td>
              <td>{m.name}</td>
              <td>{m.phone_number}</td>
              <td>{m.communication_types.join(", ")}</td>
              <td>
                <button
                  className="danger"
                  onClick={async () => {
                    if (!window.confirm(`Remove urgent manager ${m.crm_user_id}?`)) return;
                    await send("DELETE", `/admin/api/urgent-managers/${m.id}`).catch((e) => setError(errorText(e)));
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
        <input placeholder="CRM user ID" aria-label="CRM user ID" value={form.crm_user_id} onChange={(e) => setForm({ ...form, crm_user_id: e.target.value })} />
        <input placeholder="Name" aria-label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <input placeholder="+33600000000" aria-label="Phone number" value={form.phone_number} onChange={(e) => setForm({ ...form, phone_number: e.target.value })} />
        {TYPES.map((t) => (
          <label key={t} className="check">
            <input
              type="checkbox"
              checked={types.includes(t)}
              onChange={(e) => setTypes(e.target.checked ? [...types, t] : types.filter((x) => x !== t))}
            />
            {t}
          </label>
        ))}
        <button type="submit" disabled={!form.crm_user_id || !form.phone_number || types.length === 0}>
          Add urgent manager
        </button>
      </form>
      {error && <p className="error">{error}</p>}
    </section>
  );
}

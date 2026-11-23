import { useState } from "react";
import { api, send, type Schemas } from "../api/client";
import { errorText } from "../useLoad";

export function ClientsSection() {
  const [search, setSearch] = useState("");
  const [clients, setClients] = useState<Schemas["ClientOut"][] | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function find() {
    try {
      setClients(await api<Schemas["ClientOut"][]>(`/admin/api/clients?search=${encodeURIComponent(search)}`));
    } catch (e) {
      setMessage(errorText(e));
    }
  }

  return (
    <section>
      <h2>Client data</h2>
      <p className="muted">
        The module keeps data for a maximum of 3 years. When a client asks to delete their data or account, delete it
        here: conversations, messages, memory, orders and pending messages. This cannot be undone.
      </p>
      <form
        className="inline"
        onSubmit={(e) => {
          e.preventDefault();
          void find();
        }}
      >
        <input placeholder="Name or channel user ID" aria-label="Search clients" value={search} onChange={(e) => setSearch(e.target.value)} />
        <button type="submit">Search</button>
      </form>
      {clients && (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Channel</th>
              <th>Channel user ID</th>
              <th>First contact</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {clients.map((c) => (
              <tr key={c.id}>
                <td>{c.display_name}</td>
                <td>{c.channel}</td>
                <td>{c.channel_user_id}</td>
                <td>{new Date(c.created_at).toLocaleDateString()}</td>
                <td>
                  <button
                    className="danger"
                    onClick={async () => {
                      if (!window.confirm(`Delete ALL data of ${c.display_name ?? c.channel_user_id}? This cannot be undone.`))
                        return;
                      try {
                        await send("DELETE", `/admin/api/clients/${c.id}`);
                        setMessage("Client data deleted.");
                        await find();
                      } catch (e) {
                        setMessage(errorText(e));
                      }
                    }}
                  >
                    Delete all data
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {clients?.length === 0 && <p>No clients found.</p>}
      {message && <p className="muted">{message}</p>}
    </section>
  );
}

import { useCallback, useEffect, useState } from "react";
import { api, send, type Schemas } from "./api/client";
import { LogoutButton, RoleBanner } from "./RoleBanner";

type Item = Schemas["ConversationItem"];
type Detail = Schemas["ConversationDetail"];
type HandoffOut = Schemas["HandoffOut"];
type Me = Schemas["OperatorMe"];

const OUT_TO_AI = "/out-to-AI";

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Route: #/conversations/<id> or #/handoffs. */
function useRoute(): [string, (r: string) => void] {
  const [route, setRoute] = useState(window.location.hash.slice(1) || "/");
  useEffect(() => {
    const onChange = () => setRoute(window.location.hash.slice(1) || "/");
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return [route, (r: string) => (window.location.hash = r)];
}

/** Live tenant events. Each event bumps the version, and the views load again. */
function useEvents(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (typeof WebSocket === "undefined") return;
    let socket: WebSocket | null = null;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      const scheme = window.location.protocol === "https:" ? "wss" : "ws";
      socket = new WebSocket(`${scheme}://${window.location.host}/operator/ws`);
      socket.onmessage = () => setVersion((v) => v + 1);
      socket.onclose = () => {
        if (!closed) retry = setTimeout(connect, 3000);
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      socket?.close();
    };
  }, []);
  return version;
}

function Badge({ handoff }: { handoff: HandoffOut | null | undefined }) {
  if (!handoff) return null;
  return (
    <span className={`badge ${handoff.status}`}>
      {handoff.status}
      {handoff.mine ? " · you" : ""}
    </span>
  );
}

function ConversationView({ id, version, me }: { id: string; version: number; me: Me | null }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setDetail(await api<Detail>(`/operator/api/conversations/${id}`));
    } catch (e) {
      setError(errorText(e));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load, version]);

  if (!detail) return error ? <p className="error">{error}</p> : <p>Loading…</p>;
  const handoff = detail.handoff;
  const mine = Boolean(handoff?.mine);

  async function post(body: string) {
    try {
      const result = await send<Schemas["MessageResult"]>("POST", `/operator/api/conversations/${id}/messages`, {
        text: body,
      });
      if (result.status === "not_delivered") setError("The channel did not deliver the message.");
      else setError(null);
      setText("");
      await load();
    } catch (e) {
      setError(errorText(e));
    }
  }

  return (
    <div className="card">
      <h2>
        {detail.client_name} <span className="muted">({detail.channel}, {detail.language ?? "?"})</span>
        <Badge handoff={handoff} />
      </h2>
      {handoff?.summary && (
        <p>
          <strong>Summary:</strong> {handoff.summary}
        </p>
      )}
      {detail.orders.length > 0 && (
        <p className="muted">
          Orders:{" "}
          {detail.orders.map((o) => (
            <span key={o.crm_order_id}>
              {o.crm_order_id} ({o.status}){" "}
            </span>
          ))}
        </p>
      )}
      <div className="messages" aria-label="Messages">
        {detail.messages.map((m) => (
          <div key={m.id} className={`msg ${m.sender}`}>
            <small>
              {m.sender} · {new Date(m.created_at).toLocaleTimeString()}
            </small>
            {m.body}
          </div>
        ))}
      </div>
      {handoff?.status === "pending" && mine && me?.operator_id && (
        <button onClick={() => void send("POST", `/operator/api/handoffs/${handoff.id}/accept`).then(load, (e) => setError(errorText(e)))}>
          Accept conversation
        </button>
      )}
      {handoff?.status === "active" && mine && (
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) void post(text.trim());
          }}
        >
          <input aria-label="Message" placeholder={`Reply, or ${OUT_TO_AI}`} value={text} onChange={(e) => setText(e.target.value)} />
          <button type="submit" disabled={!text.trim()}>
            Send
          </button>
          <button type="button" onClick={() => void post(OUT_TO_AI)}>
            Give back to AI
          </button>
        </form>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

function HandoffLog({ version }: { version: number }) {
  const [rows, setRows] = useState<HandoffOut[] | null>(null);
  useEffect(() => {
    void api<HandoffOut[]>("/operator/api/handoffs").then(setRows);
  }, [version]);
  if (!rows) return <p>Loading…</p>;
  return (
    <table>
      <thead>
        <tr>
          <th>Requested</th>
          <th>Trigger</th>
          <th>Status</th>
          <th>Operator</th>
          <th>Accepted</th>
          <th>Alerts</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((h) => (
          <tr key={h.id}>
            <td>
              <a href={`#/conversations/${h.conversation_id}`}>{new Date(h.requested_at).toLocaleString()}</a>
            </td>
            <td>{h.trigger}</td>
            <td>{h.status}</td>
            <td>{h.operator_name ?? "–"}</td>
            <td>{h.accepted_at ? new Date(h.accepted_at).toLocaleTimeString() : "–"}</td>
            <td>{h.alerts.map((a) => String(a.type)).join(", ") || "–"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function App() {
  const [route, go] = useRoute();
  const version = useEvents();
  const [scope, setScope] = useState<"active" | "all">("active");
  const [items, setItems] = useState<Item[] | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Item[]>(`/operator/api/conversations?scope=${scope}`).then(setItems, (e) => setError(errorText(e)));
  }, [scope, version]);

  useEffect(() => {
    api<Me>("/operator/api/me").then(setMe, () => undefined);
  }, []);

  const selected = route.startsWith("/conversations/") ? route.split("/")[2] : null;
  return (
    <div className="layout">
      <header className="inline">
        <h1>AI-chat-helper Operator chat</h1>
        <nav aria-label="Views" className="inline">
          <button className={route !== "/handoffs" ? "active" : ""} onClick={() => go("/")}>
            Conversations
          </button>
          <button className={route === "/handoffs" ? "active" : ""} onClick={() => go("/handoffs")}>
            Handoff log
          </button>
        </nav>
        {me?.operator_id && (
          <label className="check">
            <input
              type="checkbox"
              checked={Boolean(me.is_available)}
              onChange={async (e) =>
                setMe(await send<Me>("PUT", "/operator/api/me/availability", { is_available: e.target.checked }))
              }
            />
            Available for handoffs
          </label>
        )}
        <LogoutButton />
      </header>
      <RoleBanner />
      <main>
        {error && <p className="error">{error}</p>}
        {route === "/handoffs" ? (
          <HandoffLog version={version} />
        ) : (
          <div className="chat">
            <div>
              <div className="inline">
                <label className="check">
                  <input type="radio" checked={scope === "active"} onChange={() => setScope("active")} />
                  Handoffs now
                </label>
                <label className="check">
                  <input type="radio" checked={scope === "all"} onChange={() => setScope("all")} />
                  History
                </label>
              </div>
              <div className="list" aria-label="Conversations">
                {(items ?? []).map((c) => (
                  <button key={c.id} className={c.id === selected ? "active" : ""} onClick={() => go(`/conversations/${c.id}`)}>
                    <strong>{c.client_name}</strong>
                    <Badge handoff={c.handoff} />
                    <br />
                    <span className="muted">{c.last_message ?? ""}</span>
                  </button>
                ))}
                {items?.length === 0 && <p className="muted">No conversations.</p>}
              </div>
            </div>
            {selected ? <ConversationView key={selected} id={selected} version={version} me={me} /> : <p className="muted">Select a conversation.</p>}
          </div>
        )}
      </main>
    </div>
  );
}

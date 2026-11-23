import { useCallback, useEffect, useMemo, useState } from "react";
import { api, send, type Schemas } from "../api/client";
import { errorText } from "../useLoad";

type State = Schemas["TestChatState"];
type Trace = Schemas["TestTrace"];
type Data = Record<string, unknown>;

const CLIENT_KEY = "aich.testClient";
const POLL_MS = 1500;

function storedClient(): string | null {
  try {
    return localStorage.getItem(CLIENT_KEY);
  } catch {
    return null;
  }
}

function storeClient(ref: string) {
  try {
    localStorage.setItem(CLIENT_KEY, ref);
  } catch {
    /* private mode: keep it in memory only */
  }
}

const obj = (v: unknown): Data => (v && typeof v === "object" ? (v as Data) : {});
const str = (v: unknown) => (v === null || v === undefined || v === "" ? "–" : String(v));

function Pairs({ data }: { data: Data }) {
  return (
    <table className="pairs">
      <tbody>
        {Object.entries(data).map(([k, v]) => (
          <tr key={k}>
            <th>{k}</th>
            <td>{typeof v === "object" && v !== null ? JSON.stringify(v) : str(v)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TraceView({ trace }: { trace: Trace }) {
  const d = trace.data as Data;
  const tools = (d.tools as Data[] | undefined) ?? [];
  const calls = (d.llm_calls as Data[] | undefined) ?? [];
  const rules: Data = {
    language: d.language,
    funnel_stage: d.funnel_stage,
    handoff_trigger: obj(d.handoff).trigger ?? "none",
    human_requests: obj(d.handoff).human_request_count,
    confidence_limit: obj(d.handoff).confidence_limit,
    restriction: d.restriction ? `${obj(d.restriction).level} → ${obj(d.restriction).action}` : "–",
    off_topic_count: obj(d.restriction).off_topic_count,
    examples_used: d.examples_used,
    memories_used: d.memories_used,
  };
  return (
    <div aria-label="Turn trace">
      <h3>
        Outcome: {str(d.outcome)} <span className="muted">({str(d.seconds)} s, reply delay {str(d.delay_seconds)} s)</span>
      </h3>
      {d.reply ? <p className="reply">{String(d.reply)}</p> : null}
      {d.confirmation ? (
        <>
          <h4>Order confirmation</h4>
          <Pairs data={obj(d.confirmation)} />
        </>
      ) : null}
      <h4>Classifier (fast model)</h4>
      <Pairs data={obj(d.classification)} />
      <h4>Rules</h4>
      <Pairs data={rules} />
      <h4>Tools ({tools.length})</h4>
      {tools.map((t, i) => (
        <details key={i}>
          <summary>
            {String(t.name)} {JSON.stringify(t.arguments)}
          </summary>
          <pre>{String(t.result)}</pre>
        </details>
      ))}
      <h4>Model calls ({calls.length})</h4>
      <table>
        <thead>
          <tr>
            <th>Tier</th>
            <th>Model</th>
            <th>Seconds</th>
            <th>Tokens in / out</th>
            <th>Tool calls</th>
          </tr>
        </thead>
        <tbody>
          {calls.map((c, i) => (
            <tr key={i}>
              <td>{str(c.tier)}</td>
              <td>{str(c.model)}</td>
              <td>{str(c.seconds)}</td>
              <td>
                {str(c.input_tokens)} / {str(c.output_tokens)}
              </td>
              <td>{((c.tool_calls as Data[]) ?? []).map((t) => String(t.name)).join(", ") || "–"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <details>
        <summary>System prompt</summary>
        <pre>{str(d.system_prompt)}</pre>
      </details>
    </div>
  );
}

export function TestChatSection() {
  const [clientRef, setClientRef] = useState<string | null>(storedClient);
  const [state, setState] = useState<State | null>(null);
  const [text, setText] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const newConversation = useCallback(async () => {
    try {
      const created = await send<Schemas["TestSession"]>("POST", "/admin/api/test-chat/sessions");
      storeClient(created.client_ref);
      setClientRef(created.client_ref);
      setState(null);
      setSelected(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  const load = useCallback(async () => {
    if (!clientRef) return;
    try {
      setState(await api<State>(`/admin/api/test-chat/conversation?client_ref=${encodeURIComponent(clientRef)}`));
      setNow(Date.now());
      setError(null);
    } catch (e) {
      if (e instanceof Error && "status" in e && (e as { status: number }).status === 404) void newConversation();
      else setError(errorText(e));
    }
  }, [clientRef, newConversation]);

  useEffect(() => {
    if (!clientRef) void newConversation();
  }, [clientRef, newConversation]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const traceByMessage = useMemo(() => {
    const map = new Map<string, Trace>();
    for (const t of state?.traces ?? []) if (t.message_id) map.set(t.message_id, t);
    return map;
  }, [state]);
  const traces = state?.traces ?? [];
  const shown = traces.find((t) => t.id === selected) ?? traces[traces.length - 1];

  async function submit() {
    if (!clientRef || !text.trim()) return;
    try {
      await send("POST", "/admin/api/test-chat/messages", { client_ref: clientRef, text: text.trim() });
      setText("");
      await load();
    } catch (e) {
      setError(errorText(e));
    }
  }

  const typingFor = state?.typing_until ? Math.ceil((Date.parse(state.typing_until) - now) / 1000) : null;
  const waiting = state?.oldest_waiting_job_seconds ?? null;

  return (
    <section>
      <h2>Test chat</h2>
      <p className="muted">
        You are the client on the web test channel. The bot uses the current settings, prompts and the configured
        model. Change a setting, then send a new message to see the effect.
      </p>
      <div className="inline">
        <button onClick={() => void newConversation()}>New conversation</button>
        {state && (
          <span className="muted">
            state <b>{str(state.state)}</b> · language {str(state.language)} · stage {str(state.funnel_stage)} · human
            requests {state.human_request_count} · off-topic {state.off_topic_count}
          </span>
        )}
      </div>
      {waiting !== null && waiting > 20 && (
        <p className="error">Jobs wait for {Math.round(waiting)} s. Is the worker running?</p>
      )}
      {error && <p className="error">{error}</p>}

      <div className="testchat">
        <div className="card">
          <div className="messages" aria-label="Test messages">
            {(state?.messages ?? []).map((m) => {
              const trace = traceByMessage.get(m.id);
              return (
                <div
                  key={m.id}
                  className={`msg ${m.sender}${trace && trace.id === shown?.id ? " selected" : ""}`}
                  onClick={() => trace && setSelected(trace.id)}
                  title={trace ? "Show the decisions of this turn" : undefined}
                >
                  <small>{m.sender}</small>
                  {m.body}
                </div>
              );
            })}
            {state && state.queued_turns > 0 && (
              <div className="msg system">
                The bot is thinking…
                {state.thinking_since && ` ${Math.max(0, Math.round((now - Date.parse(state.thinking_since)) / 1000))} s`}
                {" "}(a local model can take 1–3 minutes)
              </div>
            )}
            {typingFor !== null && typingFor > 0 && <div className="msg system">typing… (reply in {typingFor} s)</div>}
          </div>
          {state?.pending_confirmation && (
            <p className="muted">Waiting for "yes": {String(obj(state.pending_confirmation).summary)}</p>
          )}
          {state?.handoff && (
            <div className="muted">
              Handoff: <b>{state.handoff.status}</b> ({state.handoff.trigger}) · operator {str(state.handoff.operator_name)}
              {state.handoff.alerts.length > 0 && (
                <> · alerts: {state.handoff.alerts.map((a) => String(a.type)).join(", ")}</>
              )}
              <br />
              To answer as the operator, open the operator chat in a private window and log in as an operator.
            </div>
          )}
          <form
            className="composer"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <input aria-label="Client message" placeholder="Write as the client…" value={text} onChange={(e) => setText(e.target.value)} />
            <button type="submit" disabled={!text.trim() || !clientRef}>
              Send
            </button>
          </form>
        </div>
        <div className="card">{shown ? <TraceView trace={shown} /> : <p className="muted">No turn yet.</p>}</div>
      </div>
    </section>
  );
}

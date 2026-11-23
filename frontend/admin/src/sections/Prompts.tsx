import { useMemo, useState } from "react";
import { send, type Schemas } from "../api/client";
import { errorText, useLoad } from "../useLoad";

type Prompt = Schemas["PromptOut"];

function PromptEditor({ prompt, onSaved }: { prompt: Prompt; onSaved: () => void }) {
  const [body, setBody] = useState(prompt.body);
  const [message, setMessage] = useState<string | null>(null);
  return (
    <div className="card">
      <h3>
        {prompt.key} <span className="muted">({prompt.language}, {prompt.source} v{prompt.version})</span>
      </h3>
      <textarea rows={6} aria-label={`${prompt.key} ${prompt.language}`} value={body} onChange={(e) => setBody(e.target.value)} />
      <button
        disabled={body === prompt.body}
        onClick={async () => {
          try {
            await send("PUT", `/admin/api/prompts/${encodeURIComponent(prompt.key)}/${prompt.language}`, { body });
            setMessage("Saved.");
            onSaved();
          } catch (e) {
            setMessage(errorText(e));
          }
        }}
      >
        Save
      </button>
      {message && <span className="muted"> {message}</span>}
    </div>
  );
}

export function PromptsSection() {
  const { data, error, reload } = useLoad<Prompt[]>("/admin/api/prompts");
  const languages = useMemo(() => [...new Set((data ?? []).map((p) => p.language))], [data]);
  const [language, setLanguage] = useState("en");
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p>Loading…</p>;
  return (
    <section>
      <h2>Harness prompts</h2>
      <p className="muted">
        A saved prompt makes a new tenant version. The defaults stay. Placeholders such as{" "}
        <code>{"{business_name}"}</code> and <code>{"{summary}"}</code> are filled in by the module.
      </p>
      <label>
        Language{" "}
        <select value={language} onChange={(e) => setLanguage(e.target.value)}>
          {languages.map((l) => (
            <option key={l}>{l}</option>
          ))}
        </select>
      </label>
      {data
        .filter((p) => p.language === language)
        .map((p) => (
          <PromptEditor key={`${p.key}/${p.language}/${p.version}/${p.source}`} prompt={p} onSaved={reload} />
        ))}
    </section>
  );
}

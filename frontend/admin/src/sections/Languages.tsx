import { useState } from "react";
import { send, type Schemas } from "../api/client";
import { errorText, useLoad } from "../useLoad";

type Example = Schemas["DialogExampleIn"];

/** Dialogs are separated by a line with "---". */
function parseDialogs(text: string, language: string, toneTag: string): Example[] {
  return text
    .split(/^---\s*$/m)
    .map((d) => d.trim())
    .filter(Boolean)
    .map((content) => ({ language, tone_tag: toneTag || null, content }));
}

export function LanguagesSection() {
  const packs = useLoad<Schemas["LanguagePackOut"][]>("/admin/api/language-packs");
  const groups = useLoad<Schemas["DialogGroup"][]>("/admin/api/dialog-examples");
  const [pack, setPack] = useState({ language: "", name: "" });
  const [dialogs, setDialogs] = useState("");
  const [dialogLanguage, setDialogLanguage] = useState("en");
  const [toneTag, setToneTag] = useState("friendly");
  const [message, setMessage] = useState<string | null>(null);

  async function upload() {
    const examples = parseDialogs(dialogs, dialogLanguage, toneTag);
    try {
      const result = await send<{ added: number }>("POST", "/admin/api/dialog-examples", { examples });
      setMessage(`${result.added} dialogs added.`);
      setDialogs("");
      await groups.reload();
    } catch (e) {
      setMessage(errorText(e));
    }
  }

  return (
    <section>
      <h2>Language packs</h2>
      <p className="muted">
        English and French are built in. A pack enables one more language. Add its prompts in "Prompts" and its
        example dialogs below.
      </p>
      <ul>
        {(packs.data ?? []).map((p) => (
          <li key={p.id}>
            {p.language} – {p.name}{" "}
            <button
              className="danger"
              onClick={async () => {
                await send("DELETE", `/admin/api/language-packs/${p.id}`).catch((e) => packs.setError(errorText(e)));
                await packs.reload();
              }}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
      <form
        className="inline"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await send("POST", "/admin/api/language-packs", { ...pack, enabled: true });
            setPack({ language: "", name: "" });
            await packs.reload();
          } catch (err) {
            packs.setError(errorText(err));
          }
        }}
      >
        <input placeholder="de" aria-label="Language code" value={pack.language} onChange={(e) => setPack({ ...pack, language: e.target.value })} />
        <input placeholder="Deutsch" aria-label="Language name" value={pack.name} onChange={(e) => setPack({ ...pack, name: e.target.value })} />
        <button type="submit" disabled={!pack.language || !pack.name}>
          Add language pack
        </button>
      </form>
      {packs.error && <p className="error">{packs.error}</p>}

      <h2>Dialog dataset (tone and language)</h2>
      <table>
        <thead>
          <tr>
            <th>Language</th>
            <th>Tone tag</th>
            <th>Dialogs</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {(groups.data ?? []).map((g) => (
            <tr key={`${g.language}/${g.tone_tag}`}>
              <td>{g.language}</td>
              <td>{g.tone_tag ?? "–"}</td>
              <td>{g.count}</td>
              <td>
                <button
                  className="danger"
                  onClick={async () => {
                    const query = new URLSearchParams({ language: g.language });
                    if (g.tone_tag) query.set("tone_tag", g.tone_tag);
                    await send("DELETE", `/admin/api/dialog-examples?${query}`);
                    await groups.reload();
                  }}
                >
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="card">
        <div className="inline">
          <input aria-label="Dialog language" value={dialogLanguage} onChange={(e) => setDialogLanguage(e.target.value)} />
          <input aria-label="Tone tag" placeholder="tone tag" value={toneTag} onChange={(e) => setToneTag(e.target.value)} />
        </div>
        <textarea
          rows={10}
          aria-label="Dialogs"
          placeholder={"Client: Hi!\nBot: Hello, how can I help?\n---\nClient: ...\nBot: ..."}
          value={dialogs}
          onChange={(e) => setDialogs(e.target.value)}
        />
        <button disabled={!dialogs.trim()} onClick={() => void upload()}>
          Upload dialogs
        </button>
        {message && <p className="muted">{message}</p>}
      </div>
    </section>
  );
}

import { useState } from "react";
import { tenantId } from "./api/client";
import { ChannelsSection, CrmSection } from "./sections/Connections";
import { ClientsSection } from "./sections/Clients";
import { ConfigSection } from "./sections/Config";
import { LanguagesSection } from "./sections/Languages";
import { OperatorsSection, UrgentManagersSection } from "./sections/People";
import { PromptsSection } from "./sections/Prompts";

const SECTIONS = {
  config: { label: "Settings", view: ConfigSection },
  prompts: { label: "Prompts", view: PromptsSection },
  operators: { label: "Operators", view: OperatorsSection },
  managers: { label: "Urgent managers", view: UrgentManagersSection },
  channels: { label: "Channels", view: ChannelsSection },
  crm: { label: "CRM connection", view: CrmSection },
  languages: { label: "Languages & dialogs", view: LanguagesSection },
  clients: { label: "Client data", view: ClientsSection },
} as const;

type SectionKey = keyof typeof SECTIONS;

function TenantPrompt() {
  const [value, setValue] = useState("");
  return (
    <form
      className="card"
      onSubmit={(e) => {
        e.preventDefault();
        window.location.search = `?tenant=${encodeURIComponent(value.trim())}`;
      }}
    >
      <h2>Tenant</h2>
      <p>Open this page with <code>?tenant=&lt;tenant ID&gt;</code>, or type the ID:</p>
      <input aria-label="Tenant ID" value={value} onChange={(e) => setValue(e.target.value)} />
      <button type="submit" disabled={!value.trim()}>
        Continue
      </button>
    </form>
  );
}

export default function App() {
  const [section, setSection] = useState<SectionKey>("config");
  const tenant = tenantId();
  const View = SECTIONS[section].view;
  return (
    <div className="layout">
      <header>
        <h1>AI-chat-helper Admin</h1>
        <p className="muted">Module setup</p>
      </header>
      {tenant ? (
        <div className="body">
          <nav aria-label="Sections">
            {(Object.keys(SECTIONS) as SectionKey[]).map((key) => (
              <button
                key={key}
                className={key === section ? "active" : ""}
                onClick={() => setSection(key)}
              >
                {SECTIONS[key].label}
              </button>
            ))}
          </nav>
          <main>
            <View />
          </main>
        </div>
      ) : (
        <TenantPrompt />
      )}
    </div>
  );
}

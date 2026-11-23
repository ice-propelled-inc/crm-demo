import { useState } from "react";
import { LogoutButton, RoleBanner } from "./RoleBanner";
import { ChannelsSection, CrmSection } from "./sections/Connections";
import { ClientsSection } from "./sections/Clients";
import { ConfigSection } from "./sections/Config";
import { LanguagesSection } from "./sections/Languages";
import { OperatorsSection, UrgentManagersSection } from "./sections/People";
import { PromptsSection } from "./sections/Prompts";
import { TestChatSection } from "./sections/TestChat";

const SECTIONS = {
  config: { label: "Settings", view: ConfigSection },
  prompts: { label: "Prompts", view: PromptsSection },
  operators: { label: "Operators", view: OperatorsSection },
  managers: { label: "Urgent managers", view: UrgentManagersSection },
  channels: { label: "Channels", view: ChannelsSection },
  crm: { label: "CRM connection", view: CrmSection },
  languages: { label: "Languages & dialogs", view: LanguagesSection },
  clients: { label: "Client data", view: ClientsSection },
  test: { label: "Test chat", view: TestChatSection },
} as const;

type SectionKey = keyof typeof SECTIONS;

export default function App() {
  const [section, setSection] = useState<SectionKey>("config");
  const View = SECTIONS[section].view;
  return (
    <div className="layout">
      <header>
        <h1>AI-chat-helper Admin</h1>
        <p className="muted">Module setup</p>
        <LogoutButton />
      </header>
      <RoleBanner />
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
    </div>
  );
}

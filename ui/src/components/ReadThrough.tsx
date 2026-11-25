// Whether a long file a model reads comes back as a small model's compiled
// reading of it (src/tools/reading.ts): one switch for the sessions the owner
// talks to (`sessions.read_through`) and one for agents (`agents.read_through`,
// off until its trial under Usage ends with Keep).
import { reportError } from "../lib/store.ts";
import { SettingRow } from "./settings/kit.tsx";
import { useSettings } from "./StoragePanel.tsx";
import { Toggle } from "./surfaces/kit.tsx";

export function ReadThrough() {
  const [settings, patch] = useSettings();
  if (!settings) return null;
  return (
    <>
      <SettingRow
        label="Read long files through a small model"
        hint="A long file your sessions read comes back as a small model's reading of it, with the file's own lines where they matter."
        help="The first small model reads the file and writes what it is, its parts with their lines and what matters for the work; the lines it marks are copied from the file. The file itself comes back for a short file, for prose and instruction files, for a file your prompt names, and whenever the model asks for it."
        testid="read-through-sessions-row"
      >
        <Toggle on={settings.sessions?.read_through !== false} label="Read long files through a small model" testid="read-through-sessions" onChange={(on) => patch({ sessions: { read_through: on } }).catch(reportError)} />
      </SettingRow>
      <SettingRow
        label="Agents read long files that way too"
        hint="Off until its trial ends with Keep: Usage, Trials, Agents' file reads."
        testid="read-through-agents-row"
      >
        <Toggle on={settings.agents?.read_through === true} label="Agents read long files through a small model" testid="read-through-agents" onChange={(on) => patch({ agents: { read_through: on } }).catch(reportError)} />
      </SettingRow>
    </>
  );
}

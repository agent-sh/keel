// Whether a long file a model reads comes back as a small model's compiled
// reading of it (src/tools/reading.ts): one switch for the sessions the owner
// talks to (`sessions.read_through`) and one for agents (`agents.read_through`,
// off until its trial under Usage ends with Keep). The switch is Base UI's own
// here: the surfaces kit's Toggle would bring that kit and what it imports into
// the Settings chunk, and the page's start names every chunk that makes.
import { Switch } from "@base-ui/react/switch";
import { reportError } from "../lib/store.ts";
import { SettingRow } from "./settings/kit.tsx";
import { useSettings } from "./StoragePanel.tsx";

function Toggle({ on, onChange, label, testid }: { on: boolean; onChange: (on: boolean) => void; label: string; testid: string }) {
  return (
    <Switch.Root checked={on} onCheckedChange={onChange} aria-label={label} data-testid={testid} className="k-switch">
      <Switch.Thumb className="k-switch-thumb" />
    </Switch.Root>
  );
}

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

// Where the session is kept, in its side panel: its project (the folder's
// unless another or none is picked).
import type { Session } from "../../../src/core/types.ts";
import { projectOfFolder, projects, useProjects } from "../lib/projects.ts";
import { reportError } from "../lib/store.ts";
import { navigate } from "../lib/ui.ts";
import { Line, Section } from "./SessionPanel.tsx";
import { Select } from "./Select.tsx";

export function SessionOrganize({ s }: { s: Session }) {
  const list = useProjects((x) => x.projects);
  const member = useProjects((x) => x.members[s.id]);
  if (s.parent_id) return null;
  const set = s.settings.project;
  // The folder's project (a worktree's is its repository's: the daemon says, through members).
  const byFolder = s.machine ? undefined : !set ? list.find((p) => p.id === member) : projectOfFolder(s.workspace);
  const value = set === "none" ? "none" : set && list.some((p) => p.id === set) ? set : "";
  const current = list.find((p) => p.id === member);
  return (
    <Section title="Organize" testid="session-organize">
      <Line label="Project" hint={current ? <>Its instructions are part of this session's prompt. <button type="button" className="text-accent-ink hover:underline" onClick={() => navigate({ name: "project", id: current.id })}>Open {current.name}</button></> : "Sessions in a project read its instructions."}>
        <Select value={value} onChange={(e) => projects.move(s.id, e.target.value || null).catch(reportError)} aria-label="Project" data-testid="session-project">
          <option value="">{byFolder ? `${byFolder.name} (its folder's)` : "By its folder (none)"}</option>
          {list.filter((p) => p.id !== byFolder?.id).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          <option value="none">No project</option>
        </Select>
      </Line>
    </Section>
  );
}

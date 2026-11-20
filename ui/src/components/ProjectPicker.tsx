// The project of a new session, beside its folder: the folder's project
// unless another (or none) is picked. Picking one starts in its primary folder
// with its default model. Shown once there is a project.
import { Boxes } from "lucide-react";
import { projectOfFolder, useProjects } from "../lib/projects.ts";
import { getState } from "../lib/store.ts";
import { savePref, setUI, useUI } from "../lib/ui.ts";
import { Select } from "./Select.tsx";

// What the start box sends: the picked project, else the folder's.
export const startProject = (workspace: string, picked: string) => picked || projectOfFolder(workspace)?.id;

export function ProjectPicker({ workspace }: { workspace: string }) {
  const list = useProjects((s) => s.projects);
  const picked = useUI((s) => s.newProject);
  useProjects((s) => s.members); // the folder's project follows a change of the projects
  if (!list.length) return null;
  const value = startProject(workspace, picked) ?? "none";
  return (
    <span className="inline-flex items-center gap-1 text-ui text-muted" data-testid="new-project">
      <Boxes className="size-3.5 text-faint" aria-hidden="true" />
      <Select
        value={value}
        aria-label="Project of the new session"
        data-testid="new-project-select"
        onChange={(e) => {
          const id = e.target.value;
          const p = list.find((x) => x.id === id);
          setUI({ newProject: id, ...(p?.defaults.model && getState().models.some((m) => m.id === p.defaults.model) ? { newModel: p.defaults.model } : {}) });
          if (p?.folders[0] && !p.folders.some((f) => workspace === f || workspace.startsWith(`${f}/`))) savePref("newWorkspace", p.folders[0]);
        }}
      >
        <option value="none">No project</option>
        {list.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </Select>
    </span>
  );
}

// Projects in the palette: a new project, and each project's page.
import { registerCommand } from "../lib/keys.ts";
import { createProject, getProjects, subscribeProjects } from "../lib/projects.ts";
import { reportError } from "../lib/store.ts";
import { navigate } from "../lib/ui.ts";

registerCommand({ id: "project-new", label: "New project", group: "Projects", words: "project instructions folders", run: () => void createProject().catch(reportError) });
const seen = new Set<string>();
subscribeProjects(() => {
  const list = getProjects().projects;
  for (const p of list) {
    if (seen.has(`${p.id}\u0000${p.name}`)) continue;
    seen.add(`${p.id}\u0000${p.name}`);
    registerCommand({
      id: `project-open-${p.id}`, label: `Open the project ${p.name}`, group: "Projects", words: "project page instructions",
      when: () => getProjects().projects.some((x) => x.id === p.id), run: () => navigate({ name: "project", id: p.id }),
    });
  }
});

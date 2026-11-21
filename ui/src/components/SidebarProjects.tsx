// The session list by project: each project with its sessions, its head a
// link to the project's page and a new session in it, then the sessions in
// no project. A session dropped on a project's head moves into it.
import { Boxes, Plus } from "lucide-react";
import { useState } from "react";
import type { Session } from "../../../src/core/types.ts";
import { createProject, newInProject, projects, useProjects } from "../lib/projects.ts";
import { reportError } from "../lib/store.ts";
import { navigate, useUI } from "../lib/ui.ts";
import { cn } from "../lib/utils.ts";
import { DRAG } from "./Panes.tsx";
import { Group } from "./Sidebar.tsx";

// Quiet until the head is hovered or holds the keyboard; shown from the start where nothing hovers.
const headAct = "grid size-6 shrink-0 place-items-center rounded-sm text-faint opacity-0 hover:bg-hover hover:text-fg group-hover/head:opacity-100 group-focus-within/head:opacity-100 focus-visible:opacity-100 touch:size-7 touch:opacity-100";

// Drop target for a session dragged from the list.
export function useDropSession(onDrop: (id: string) => void) {
  const [over, setOver] = useState(false);
  return {
    over,
    bind: {
      onDragOver: (e: React.DragEvent) => { if (e.dataTransfer.types.includes(DRAG)) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setOver(true); } },
      onDragLeave: () => setOver(false),
      onDrop: (e: React.DragEvent) => { setOver(false); const id = e.dataTransfer.getData(DRAG); if (id) { e.preventDefault(); e.stopPropagation(); onDrop(id); } },
    },
  };
}

function ProjectHead({ id, name, n }: { id: string | null; name: string; n: number }) {
  const route = useUI((s) => s.route);
  const p = useProjects((s) => s.projects.find((x) => x.id === id));
  const drop = useDropSession((sid) => projects.move(sid, id ?? "none").catch(reportError));
  return (
    <h2 className={cn("k-group-head group/head rounded-sm", drop.over && "bg-accent-soft text-accent-ink")} data-testid="project-head" data-project={id ?? "none"} {...drop.bind}>
      <Boxes />
      {p ? (
        <button type="button" className="min-w-0 truncate text-left hover:text-fg" aria-current={route.name === "project" && route.id === p.id ? "page" : undefined} title="Open the project" onClick={() => navigate({ name: "project", id: p.id })}>{name}</button>
      ) : <span className="truncate">{name}</span>}
      <span className="tabular-nums text-faint">{n || ""}</span>
      {p && <button type="button" className={cn(headAct, "ml-auto")} aria-label={`New session in ${name}`} title="New session in this project" data-testid="project-head-new" onClick={() => newInProject(p)}><Plus /></button>}
    </h2>
  );
}

export function ProjectGroups({ list, cmp, current, every }: { list: Session[]; cmp: (a: Session, b: Session) => number; current: string | null; every: boolean }) {
  const all = useProjects((s) => s.projects);
  const members = useProjects((s) => s.members);
  const by = new Map<string, Session[]>();
  for (const s of list) {
    const k = members[s.id] ?? "";
    (by.get(k) ?? by.set(k, []).get(k)!).push(s);
  }
  const loose = (by.get("") ?? []).sort(cmp);
  return (
    <>
      {all.map((p) => {
        const mine = (by.get(p.id) ?? []).sort(cmp);
        // A filter that leaves a project empty leaves it out.
        if (every && !mine.length) return null;
        return (
          <section key={p.id} className="k-group" data-testid="project-group" data-project={p.id}>
            <ProjectHead id={p.id} name={p.name} n={mine.length} />
            {mine.length ? <Group list={mine} current={current} every={every} where /> : <p className="px-2 pb-1 text-caption text-faint">No sessions yet</p>}
          </section>
        );
      })}
      {loose.length > 0 && (
        <section className="k-group" data-testid="project-group" data-project="none">
          <ProjectHead id={null} name="No project" n={loose.length} />
          <Group list={loose} current={current} every={every} where />
        </section>
      )}
      <button type="button" className="k-more flex items-center gap-1.5" data-testid="project-create" onClick={() => createProject().catch(reportError)}><Plus className="size-3.5" />New project</button>
    </>
  );
}

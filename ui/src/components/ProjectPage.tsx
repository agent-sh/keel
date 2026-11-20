// A project's page: its name, the instructions every member session reads,
// its folders (the first is where a new session starts), files to read, the
// defaults of a new session, and its sessions. Plain controls on the shared
// tokens; the look belongs to the design of the workbench.
import { ArrowLeft, FileText, Folder, Plus, Star, Trash2, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { newInProject, projects, useProjects, type Project } from "../lib/projects.ts";
import { safety, useSafety } from "../lib/safety.ts";
import { failed, reportError, useStore } from "../lib/store.ts";
import { navigate } from "../lib/ui.ts";
import { ago, cn, when } from "../lib/utils.ts";
import { useAgentCounts, useWatches, watchLabel } from "../lib/watch.ts";
import { Where } from "./Where.tsx";
import { confirmAction } from "./Confirm.tsx";
import { Mark } from "./Mark.tsx";
import { ModelPicker } from "./ModelPicker.tsx";
import { Select } from "./Select.tsx";
import { WorkspacePicker } from "./WorkspacePicker.tsx";
import { ArtifactBrowser, useArtifacts } from "./ArtifactsPanel.tsx";

const field = "h-8 min-w-0 rounded-md border border-line bg-sunken px-2.5 text-ui outline-none focus:ring-2 focus:ring-ring";
const button = "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-line-strong px-3 text-ui font-medium hover:bg-hover disabled:opacity-50";
const home = (p: string) => p.replace(/^\/(home|Users)\/[^/]+/, "~");

function Block({ title, hint, children, testid, aside }: { title: string; hint?: ReactNode; children: ReactNode; testid?: string; aside?: ReactNode }) {
  return (
    <section className="rounded-lg border border-line bg-raised px-5 py-4 shadow-1" data-testid={testid}>
      <div className="mb-3 flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold">{title}</h2>
          {hint && <p className="mt-0.5 text-ui text-muted">{hint}</p>}
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function ProjectPage({ id }: { id: string }) {
  const p = useProjects((s) => s.projects.find((x) => x.id === id));
  const loaded = useProjects((s) => s.loaded);
  if (!p) return <div className="grid flex-1 place-items-center text-ui text-muted">{loaded ? "This project is gone." : ""}</div>;
  return <Body key={p.id} p={p} />;
}

function Body({ p }: { p: Project }) {
  const [err, setErr] = useState("");
  const save = (body: Partial<Project>) => projects.patch(p.id, body).then(() => setErr(""), (e) => setErr(failed(e, { at: "project save" })));
  const [name, setName] = useState(p.name);
  useEffect(() => setName(p.name), [p.name]);
  const [text, setText] = useState(p.instructions);
  const dirty = text !== p.instructions;
  const [file, setFile] = useState("");
  const modes = useSafety((s) => s.modes);
  useEffect(() => { if (!modes.length) safety.loadSettings().catch(reportError); }, []);
  const members = useProjects((s) => s.members);
  const all = useStore((s) => s.sessions);
  const list = Object.values(all).filter((s) => members[s.id] === p.id && !s.parent_id).sort((a, b) => Number(a.archived) - Number(b.archived) || b.updated - a.updated);
  const watches = useWatches(list);
  const agents = useAgentCounts();

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="project-page" data-project={p.id}>
      <header className="k-page-head flex h-12 shrink-0 items-center gap-2 border-b border-line px-3 md:px-5">
        <button type="button" onClick={() => (history.length > 1 ? history.back() : navigate({ name: "new" }))} className="flex h-8 items-center gap-1.5 rounded-md px-2 text-ui text-muted hover:bg-hover hover:text-fg">
          <ArrowLeft className="size-4" /> Back
        </button>
        <span className="text-ui text-faint">Project</span>
        <div className="ml-auto flex items-center gap-2">
          <button type="button" className={button} data-testid="project-new-session" onClick={() => newInProject(p)}><Plus className="size-4" />New session</button>
          <button
            type="button"
            className={cn(button, "text-danger")}
            data-testid="project-delete"
            onClick={async () => {
              if (!(await confirmAction({ title: `Delete the project ${p.name}?`, body: "Its sessions stay; they leave the project and its instructions.", action: "Delete project", danger: true }))) return;
              await projects.remove(p.id).catch(reportError);
              navigate({ name: "new" });
            }}
          ><Trash2 className="size-4" />Delete</button>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid max-w-[72rem] gap-5 px-4 py-6 md:px-10 md:py-8 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="flex min-w-0 flex-col gap-5">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => name.trim() && name !== p.name && save({ name })}
              onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
              aria-label="Project name"
              data-testid="project-name"
              className="w-full rounded-md bg-transparent px-1 text-display font-semibold tracking-[-0.025em] outline-none focus:bg-sunken"
            />
            {err && <p className="rounded-md bg-danger-soft px-3 py-2 text-ui text-danger" data-testid="project-error">{err}</p>}
            <Block
              title="Instructions"
              hint="Added to the system prompt of each session in the project, as a block of its own after the cache prefix. A change applies at each session's next turn."
              testid="project-instructions"
              aside={<button type="button" className={button} disabled={!dirty} data-testid="project-instructions-save" onClick={() => save({ instructions: text })}>{dirty ? "Save" : "Saved"}</button>}
            >
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => { if (e.key === "s" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); if (dirty) save({ instructions: text }); } }}
                rows={8}
                placeholder="What every session of this project should know: the goal, the branch to target, how to name things."
                data-testid="project-instructions-text"
                className="w-full resize-y rounded-md border border-line bg-sunken px-3 py-2 font-mono text-ui leading-relaxed outline-none focus:ring-2 focus:ring-ring"
              />
            </Block>
            <Block title="Folders" hint="Sessions working in these folders (or in a worktree of them) join the project. A new session starts in the first." testid="project-folders">
              <ul className="mb-3 flex flex-col">
                {p.folders.map((f, i) => (
                  <li key={f} className="flex h-9 items-center gap-2 border-b border-line text-ui last:border-0" data-testid="project-folder">
                    <Folder className="size-4 shrink-0 text-faint" />
                    <span className="min-w-0 flex-1 truncate font-mono text-caption" title={f}>{home(f)}</span>
                    {i === 0 ? <span className="rounded-xs bg-accent-soft px-1.5 text-micro text-accent-ink">primary</span> : (
                      <button type="button" title="Start new sessions here" aria-label="Make primary" className="grid size-7 place-items-center rounded-md text-faint hover:bg-hover hover:text-fg" onClick={() => save({ folders: [f, ...p.folders.filter((x) => x !== f)] })}><Star className="size-3.5" /></button>
                    )}
                    <button type="button" aria-label={`Remove ${f}`} className="grid size-7 place-items-center rounded-md text-faint hover:bg-hover hover:text-fg" onClick={() => save({ folders: p.folders.filter((x) => x !== f) })}><X className="size-3.5" /></button>
                  </li>
                ))}
                {!p.folders.length && <li className="text-ui text-faint">No folder yet: only sessions moved here are in the project.</li>}
              </ul>
              <div className="flex items-center gap-2 text-ui text-muted" data-testid="project-add-folder">
                <span>Add</span>
                <WorkspacePicker value={p.folders.at(-1) ?? ""} onChange={(path) => !p.folders.includes(path) && save({ folders: [...p.folders, path] })} />
              </div>
            </Block>
            <Block title="Files" hint="Files every session should know of (a spec, a design note). Sessions are told their paths and read them when a task needs one." testid="project-files">
              <ul className="mb-3 flex flex-col">
                {p.files.map((f) => (
                  <li key={f} className="flex h-9 items-center gap-2 border-b border-line text-ui last:border-0" data-testid="project-file">
                    <FileText className="size-4 shrink-0 text-faint" />
                    <span className="min-w-0 flex-1 truncate font-mono text-caption" title={f}>{home(f)}</span>
                    <button type="button" aria-label={`Remove ${f}`} className="grid size-7 place-items-center rounded-md text-faint hover:bg-hover hover:text-fg" onClick={() => save({ files: p.files.filter((x) => x !== f) })}><X className="size-3.5" /></button>
                  </li>
                ))}
              </ul>
              <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); const f = file.trim(); if (!f) return; save({ files: [...p.files, f.startsWith("/") || f.startsWith("~") || !p.folders[0] ? f : `${p.folders[0]}/${f}`] }).then(() => setFile("")); }}>
                <input value={file} onChange={(e) => setFile(e.target.value)} placeholder="Path of a file (from the primary folder, or absolute)" className={cn(field, "flex-1 font-mono")} data-testid="project-file-input" spellCheck={false} />
                <button type="submit" className={button} disabled={!file.trim()}>Add</button>
              </form>
            </Block>
            <Block title="New sessions" hint="What a session started in this project begins with. Unset follows your defaults." testid="project-defaults">
              <div className="flex flex-col">
                <div className="flex items-center gap-3 border-b border-line py-2 text-ui">
                  <span className="flex-1">Model</span>
                  <ModelPicker value={p.defaults.model ?? ""} placeholder="Your default model" onChange={(m) => save({ defaults: { ...p.defaults, model: m } })} />
                  {p.defaults.model && <button type="button" aria-label="Use your default model" className="grid size-7 place-items-center rounded-md text-faint hover:bg-hover hover:text-fg" onClick={() => save({ defaults: { ...p.defaults, model: undefined } })}><X className="size-3.5" /></button>}
                </div>
                <div className="flex items-center gap-3 py-2 text-ui">
                  <span className="flex-1">Permission mode</span>
                  <Select value={p.defaults.mode ?? ""} onChange={(e) => save({ defaults: { ...p.defaults, mode: e.target.value || undefined } })} aria-label="Permission mode of a new session" data-testid="project-mode">
                    <option value="">Your default mode</option>
                    {modes.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </Select>
                </div>
              </div>
            </Block>
          </div>
          <ProjectArtifacts p={p} members={members} />
          <aside className="flex min-w-0 flex-col gap-5 lg:col-start-2 lg:row-start-1 lg:row-end-3">
            <Block title="Sessions" hint={list.length ? `${list.length} in the project` : "None yet"} testid="project-sessions">
              <div className="flex flex-col">
                {list.map((s) => (
                  <button key={s.id} type="button" data-testid="project-session" data-session={s.id} onClick={() => navigate({ name: "session", id: s.id })} className={cn("flex h-9 items-center gap-2.5 border-b border-line text-left text-ui last:border-0 hover:text-fg", s.archived ? "text-faint" : "text-muted")}>
                    <span className="grid w-4 place-items-center" title={watchLabel(watches[s.id] ?? "idle", agents[s.id])}><Mark w={watches[s.id] ?? "idle"} /></span>
                    <span className="min-w-0 flex-1 truncate">{s.title || "New session"}</span>
                    <Where s={s} />
                    <span className="text-caption tabular-nums text-faint" title={when(s.updated)}>{s.archived ? "archived" : ago(s.updated)}</span>
                  </button>
                ))}
              </div>
            </Block>
          </aside>
        </div>
      </div>
    </div>
  );
}

// Everything the project's sessions made, newest first.
function ProjectArtifacts({ p, members }: { p: Project; members: Record<string, string> }) {
  const list = useArtifacts(`/api/projects/${p.id}/artifacts`, (id) => !!id && members[id] === p.id);
  return (
    <Block title="Artifacts" hint="What the project's sessions made: files they created or changed, and what they put in their artifacts folders." testid="project-artifacts">
      <div className="-mx-5 -mb-4 h-[34rem] border-t border-line"><ArtifactBrowser list={list} testid="project-artifacts-list" withSession /></div>
    </Block>
  );
}

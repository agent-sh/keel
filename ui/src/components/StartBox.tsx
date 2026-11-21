import { lazy, Suspense, useEffect, useMemo, useRef, useState, Fragment } from "react";
import { actions, api, reportError, useStore } from "../lib/store.ts";
import { navigate, savePref, setUI, useUI } from "../lib/ui.ts";
import { ago, when } from "../lib/utils.ts";
import { useAgentCounts, useWatches, watchLabel } from "../lib/watch.ts";
import { MachineSep, machineRuns } from "./Where.tsx";
import { Mark } from "./Mark.tsx";
import { Composer } from "./Composer.tsx";
import { FirstSteps, SetupProviders } from "./Onboarding.tsx";
import { Kbd } from "./Kbd.tsx";
import { SidebarButton } from "./SessionHeader.tsx";
import { WorkspacePicker } from "./WorkspacePicker.tsx";
import { ProjectPicker, startProject } from "./ProjectPicker.tsx";
import { MachineBlocked, MachinePicker, RemoteFolderPicker, useNewMachine } from "./Fleet.tsx";
import { fleet, useFleet } from "../lib/fleet.ts";
import { createInWorktree, isGitFolder, useStartInWorktree } from "../lib/worktree.ts";

const WorktreeToggle = lazy(() => import("./WorktreeChip.tsx").then((m) => ({ default: m.WorktreeToggle })));

// The start box: the folder, the model and the first message of a new session.
export function StartBox() {
  const defaultModel = useStore((s) => s.defaultModel);
  const sessions = useStore((s) => s.sessions);
  const newModel = useUI((s) => s.newModel);
  const newProject = useUI((s) => s.newProject);
  const chosen = useUI((s) => s.newWorkspace);
  const [fallback, setFallback] = useState("");
  useEffect(() => { api("/api/workspaces").then((r) => setFallback(r.recent[0]?.path ?? r.default)).catch(reportError); }, []);
  const workspace = chosen || fallback;
  const model = newModel || defaultModel;
  // Saving another default ends a pick made against the old one.
  const lastDefault = useRef(defaultModel);
  useEffect(() => {
    if (lastDefault.current && defaultModel !== lastDefault.current) setUI({ newModel: "" });
    lastDefault.current = defaultModel;
  }, [defaultModel]);
  const inWorktree = useStartInWorktree();
  const { id: machine, blocked } = useNewMachine();
  // An ssh machine's folder, kept per machine (its granted directory until one is picked).
  const sshMachine = useFleet((s) => s.machines.find((m) => m.id === machine && m.transport === "ssh"));
  const pickedName = useFleet((s) => s.machines.find((m) => m.id === machine)?.name);
  const [remoteDir, setRemoteDir] = useState("");
  useEffect(() => { setRemoteDir(sshMachine ? localStorage.getItem(`keel.remoteFolder.${sshMachine.id}`) ?? "" : ""); }, [sshMachine?.id]);
  const pickRemote = (p: string) => { setRemoteDir(p); if (sshMachine) localStorage.setItem(`keel.remoteFolder.${sshMachine.id}`, p); };
  const loaded = useStore((s) => s.loaded);
  const noModels = useStore((s) => s.loaded.models && s.models.length === 0);
  const firstRun = loaded.sessions && !Object.values(sessions).some((s) => !s.archived);
  const recent = useMemo(
    () => Object.values(sessions).filter((s) => !s.archived && !s.parent_id && s.workspace === workspace).sort((a, b) => b.updated - a.updated).slice(0, 5),
    [sessions, workspace],
  );
  const watches = useWatches(recent);
  const agents = useAgentCounts();
  // Auto is shown as where it would place the session now: a folder of this
  // machine when it stays here, the other machine's directory when it goes.
  const place = useFleet((s) => s.autoPlace);
  const root = useFleet((s) => s.machines.find((m) => m.id === place?.machine_id)?.workspace_root);
  const rulesKey = useFleet((s) => JSON.stringify(s.rules) + s.machines.map((m) => m.id + m.state).join());
  useEffect(() => { if (machine === "auto") fleet.previewAuto().catch(reportError); }, [machine, rulesKey]);
  const autoThere = machine === "auto" && !!place && place.machine_id !== "local";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-12 shrink-0 items-center px-2 md:px-4"><SidebarButton /></div>
      <div className="flex flex-1 flex-col items-center overflow-y-auto px-4 pb-[max(1rem,env(safe-area-inset-bottom))] md:px-6">
        <div className="k-start-box mt-auto w-full max-w-[46rem] pb-[8vh] pt-6 md:mb-auto md:mt-[18vh] md:pb-0 md:pt-0">
          <h1 className="mb-1.5 text-display font-semibold tracking-[-0.025em] text-fg">What should we work on?</h1>
          <p className="mb-6 text-base text-muted">{autoThere ? `Keel works on ${place!.machine}, in its granted directory.` : sshMachine ? `Keel works in the folder below, on ${sshMachine.name}.` : machine && machine !== "auto" ? `Keel works on ${pickedName ?? "the machine you picked"}, in its granted directory.` : "Keel works in the folder below."} Paste screenshots, mention files with @, and steer while it runs.</p>
          <div className="mb-2.5 flex flex-wrap items-center gap-2">
            <MachinePicker />
            {(!machine || (machine === "auto" && !autoThere)) && <WorkspacePicker value={workspace} onChange={(p) => savePref("newWorkspace", p)} />}
            {sshMachine && <RemoteFolderPicker machine={sshMachine.id} value={remoteDir} onChange={pickRemote} />}
            {!machine && <Suspense fallback={null}><WorktreeToggle workspace={workspace} /></Suspense>}
            {!machine && <ProjectPicker workspace={workspace} />}
          </div>
          {machine === "auto" && place && (
            <p data-testid="auto-place" data-machine={place.machine_id} className="mb-2.5 flex min-w-0 items-center gap-1.5 text-caption text-muted">
              <span>Auto {autoThere ? "places it on" : "keeps it on"}</span>
              <span className="font-medium text-fg">{place.machine}</span>
              {autoThere && root && <span className="truncate font-mono text-micro text-faint">{root}</span>}
              <span className="truncate text-faint">· {place.reason}</span>
            </p>
          )}
          {blocked && <MachineBlocked blocked={blocked} />}
          {noModels && <SetupProviders />}
          <div data-testid="new-composer">
            <Composer
              model={model}
              onModel={(id) => setUI({ newModel: id })}
              workspace={workspace}
              autoFocus
              hold={blocked ? "Not sent: the note above the box says why." : undefined}
              onSend={async (t, images) => {
                const s = machine
                  ? await fleet.createOn(machine, t, model || undefined, images, autoThere ? undefined : workspace || undefined, machine === "auto" ? place?.machine_id : undefined, sshMachine ? remoteDir || undefined : undefined)
                  : inWorktree && (await isGitFolder(workspace))
                  ? await createInWorktree(t, model || undefined, workspace || undefined, images)
                  : await actions.create(t, model || undefined, workspace || undefined, images, { project: startProject(workspace, newProject) });
                // The pick was for this conversation: the next New starts on the default
                // again. A failed create keeps it for the retry.
                setUI({ newModel: "", newProject: "" });
                navigate({ name: "session", id: s.id });
              }}
            />
          </div>
          <div className="mt-3 hidden items-center gap-4 text-caption text-faint sm:flex">
            <span className="flex items-center gap-1.5"><Kbd keys="mod+k" /> search and commands</span>
            <span className="flex items-center gap-1.5"><Kbd keys="alt+m" /> model</span>
            <span className="flex items-center gap-1.5"><Kbd keys="mod+/" /> all shortcuts</span>
          </div>
          {firstRun && <FirstSteps />}
          {recent.length > 0 && !autoThere && (
            <section className="mt-10">
              <h2 className="mb-2 k-label">Recent in {workspace.split("/").pop()}</h2>
              <div className="flex flex-col">
                {machineRuns(recent).map((run, ri, runs) => (<Fragment key={run.machine ?? "local"}>{runs.length > 1 && <MachineSep machine={run.machine} count={run.list.length} />}{run.list.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => navigate({ name: "session", id: s.id })}
                    data-testid="recent-session"
                    className="k-recent-session group flex h-10 items-center gap-3 border-b border-line text-left text-ui text-muted last:border-0 hover:text-fg"
                  >
                    <span className="grid w-4 place-items-center" title={watchLabel(watches[s.id] ?? "idle", agents[s.id])}><Mark w={watches[s.id] ?? "idle"} /></span>
                    <span className="min-w-0 flex-1 truncate">{s.title || "New session"}</span>
                    <span className="text-caption tabular-nums text-faint" title={when(s.updated)}>{ago(s.updated)}</span>
                  </button>
                ))}</Fragment>))}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

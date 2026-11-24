import type { PromptBlock } from "../../../src/core/types.ts";
import { lazy, Suspense, useEffect, useMemo, useRef, useState, Fragment } from "react";
import { actions, api, reportError, useStore, workspaces } from "../lib/store.ts";
import { savePref, setUI, useUI } from "../lib/ui.ts";
import { openPlaced } from "../lib/looks.ts";
import { ago, cn, when } from "../lib/utils.ts";
import { useStateLabel, useWatches } from "../lib/watch.ts";
import { MachineSep, machineRuns } from "./Where.tsx";
import { Mark, folderOf } from "./Mark.tsx";
import { Composer } from "./Composer.tsx";
import { FirstSteps, SetupProviders } from "./Onboarding.tsx";
import { Kbd } from "./Kbd.tsx";
import { SidebarButton } from "./SessionHeader.tsx";
import { WorkspacePicker } from "./WorkspacePicker.tsx";
import { usePhoneWidth } from "../lib/list-hold.ts";
import { HelperAsk } from "./HelperAsk.tsx";
import { NewModelNews } from "./NewModels.tsx";
import { WatchHeadline, WatchLists, openWaiting, useAttended } from "./HomeWatch.tsx";
import { ProjectPicker, startProject } from "./ProjectPicker.tsx";
import { MachineBlocked, MachinePicker, RemoteFolderPicker, useNewMachine } from "./Fleet.tsx";
import { fleet, useFleet } from "../lib/fleet.ts";
import { isFailure } from "../lib/home.ts";
import { useRail, useWidth } from "../lib/rail.ts";
import { createInWorktree, isGitFolder, startBase, useStartInWorktree } from "../lib/worktree.ts";

const WorktreeToggle = lazy(() => import("./WorktreeChip.tsx").then((m) => ({ default: m.WorktreeToggle })));

// The home screen: the state of every session as its headline, the start box
// (the folder, the model and the first message of a new session), then the
// sessions that need the owner and the ones at work, then the folder's recent ones.
// The same in every layout: in a pane that stands beside others it is one column in
// the pane's width, with what needs the owner under the start box.
// `beside`: it shows in a pane that stands beside others. What needs the owner then
// comes first, above the start box, as an empty pane has it: that pane is where they
// look for it, and the list is in view at any text size.
// `onBack`: it lies over a pane's session, and Escape in the box goes back to that.
export function StartBox({ onBack, beside }: { onBack?: () => void; beside?: boolean } = {}) {
  const defaultModel = useStore((s) => s.defaultModel);
  const sessions = useStore((s) => s.sessions);
  const newModel = useUI((s) => s.newModel);
  const newProject = useUI((s) => s.newProject);
  const chosen = useUI((s) => s.newWorkspace);
  const [fallback, setFallback] = useState("");
  useEffect(() => { workspaces().then((r) => setFallback(r.recent[0]?.path ?? r.default)).catch(reportError); }, []);
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
  const noModels = useStore((s) => s.loaded.models && s.modelCount === 0);
  const firstRun = loaded.sessions && !Object.values(sessions).some((s) => !s.archived);
  // The newest sessions anywhere, without the ones the rows of what needs the owner show.
  const attended = useAttended();
  const rail = useRail();
  const listed = useWidth() >= 768 && rail.list;
  const phone = usePhoneWidth();
  const live = useMemo(() => Object.values(sessions).filter((s) => !s.archived && !s.parent_id && !attended.has(s.id)).sort((a, b) => b.updated - a.updated), [sessions, attended]);
  const watches = useWatches(live);
  // The six newest, and any failed session older than those: a red mark in the list has its row here, whatever its age.
  const recent = useMemo(() => [...live.slice(0, 6), ...live.slice(6).filter((s) => isFailure(watches[s.id])).slice(0, 3)], [live, watches]);
  const label = useStateLabel();
  // Auto is shown as where it would place the session now: a folder of this
  // machine when it stays here, the other machine's directory when it goes.
  const place = useFleet((s) => s.autoPlace);
  const root = useFleet((s) => s.machines.find((m) => m.id === place?.machine_id)?.workspace_root);
  const rulesKey = useFleet((s) => JSON.stringify(s.rules) + s.machines.map((m) => m.id + m.state).join());
  useEffect(() => { if (machine === "auto") fleet.previewAuto().catch(reportError); }, [machine, rulesKey]);
  const autoThere = machine === "auto" && !!place && place.machine_id !== "local";
  const start = async (t: string, images: PromptBlock[]) => {
    const s = machine
      ? await fleet.createOn(machine, t, model || undefined, images, autoThere ? undefined : workspace || undefined, machine === "auto" ? place?.machine_id : undefined, sshMachine ? remoteDir || undefined : undefined)
      : inWorktree && (await isGitFolder(workspace))
      ? await createInWorktree(t, model || undefined, workspace || undefined, images, startBase(workspace))
      : await actions.create(t, model || undefined, workspace || undefined, images, { project: startProject(workspace, newProject) });
    // The pick was for this conversation: the next New starts on the default
    // again. A failed create keeps it for the retry.
    setUI({ newModel: "", newProject: "" });
    // The session they started is the pane's session: they mean to work in it (lib/looks.ts).
    openPlaced(s.id);
    return s;
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* (Beside other panes the row is there only when it holds the list's button.) */}
      <div className={cn("flex shrink-0 items-center px-2 md:px-4", beside ? "h-9 empty:hidden" : "h-12")}><SidebarButton /></div>
      {/* One column in a narrow pane or on a phone: the headline, the start box, what needs the
          owner, the recent sessions. With the width for it, what needs the owner stands beside
          the start box, so nothing under it moves the box. */}
      <div className="@container flex flex-1 flex-col items-center overflow-y-auto px-4 pb-[max(1rem,env(safe-area-inset-bottom))] md:px-6">
        <div className={cn("k-home mt-auto grid w-full max-w-[46rem] grid-cols-1 pb-[8vh] pt-6 md:mb-auto md:pb-8 md:pt-0", beside ? "md:mt-5" : "md:mt-[9vh] @[74rem]:max-w-[88rem] @[74rem]:grid-cols-[minmax(0,46rem)_minmax(0,1fr)] @[74rem]:gap-x-14")}>
        <div className="min-w-0" data-testid="home-start">
          {/* On a phone the helper comes first: ask it across the sessions, by voice or typed. */}
          {phone && <HelperAsk />}
          <WatchHeadline />
          <NewModelNews />
          {beside && !autoThere && <WatchLists className="min-w-0" />}
          <h2 className={cn("k-pane-empty-word mb-2.5", beside ? "mt-8" : "mt-5")}>Start a session{machine && <span>{autoThere ? `on ${place!.machine}, in its granted directory` : sshMachine ? `on ${sshMachine.name}` : machine !== "auto" ? `on ${pickedName ?? "the machine you picked"}, in its granted directory` : ""}</span>}</h2>
          {/* Where it starts, as one line of quiet pickers whose words line up with the box (styles.css, .k-chip-pick). */}
          <div className="-ml-2 mb-2 flex flex-wrap items-center gap-x-1 gap-y-0.5">
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
              onEscape={onBack}
              hold={blocked ? "Not sent: the note above the box says why." : undefined}
              onSend={(t, images) => start(t, images)}
              // A command typed here (/goal) starts its session on this machine; one placed on
              // another is started there with its first message.
              onStart={blocked || (machine && !(machine === "auto" && !autoThere)) ? undefined : () => start("", [])}
            />
          </div>
          {/* The keys to know, while there is nothing else here: once the owner has sessions, the
              palette, the list's rows and the shortcut sheet say them where they are used. */}
          {firstRun && <div className={cn("mt-3 hidden items-center gap-4 text-caption text-faint", !beside && "sm:flex")} data-testid="home-keys">
            <span className="flex items-center gap-1.5"><Kbd keys="mod+k" /> search and commands</span>
            <span className="flex items-center gap-1.5"><Kbd keys="alt+m" /> model</span>
            <span className="flex items-center gap-1.5"><Kbd keys="mod+/" /> all shortcuts</span>
          </div>}
          {firstRun && <FirstSteps />}
        </div>
        {!autoThere && !beside && <WatchLists className="min-w-0 @[74rem]:col-start-2 @[74rem]:row-span-2 @[74rem]:row-start-1 @[74rem]:[&>section:first-child]:mt-[4.25rem]" />}
          {/* Recent is for where the titled list is not on screen (a phone, a rail folded to its marks): beside the list it would say the same sessions again. */}
          {recent.length > 0 && !autoThere && !listed && (
            <section className="k-home-sec min-w-0 @[74rem]:col-start-1">
              <h2 className="k-pane-empty-word">Recent</h2>
              <div className="mt-2 flex flex-col border-t border-line">
                {machineRuns(recent).map((run, ri, runs) => (<Fragment key={run.machine ?? "local"}>{runs.length > 1 && <MachineSep machine={run.machine} count={run.list.length} />}{run.list.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => openWaiting(s.id)}
                    data-testid="recent-session"
                    data-session={s.id}
                    data-watch={watches[s.id] ?? "idle"}
                    // A phone lists the working and the waiting ones above; a desk has them here, with their state.
                    className={cn("k-home-recent group flex h-10 items-center gap-3 border-b border-line text-left text-ui text-muted last:border-0 hover:text-fg", ["work", "wait", "resume"].includes(watches[s.id] ?? "") && "max-md:hidden")}
                  >
                    <span className="grid w-4 place-items-center"><Mark w={watches[s.id] ?? "idle"} /></span>
                    <span dir="auto" className="min-w-0 flex-1 truncate text-left">{s.title || "New session"}</span>
                    {/* The state in a word when it is not simply done; then where, and when. */}
                    {(watches[s.id] ?? "idle") !== "done" && <span className="k-face-state k-home-recent-word">{label(s.id, watches[s.id] ?? "idle")}</span>}
                    <span className={cn("k-pane-empty-in", (watches[s.id] ?? "idle") !== "done" && "max-sm:hidden")} data-testid="recent-folder">{folderOf(s)}</span>
                    <span className="k-pane-empty-time tabular-nums" title={when(s.updated)}>{ago(s.updated)}</span>
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

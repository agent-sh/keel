// The bottom line of the dock over the message box: what the session's turn does now, in the words the whole page
// uses for it, with a marker that moves a little and differs for thinking, acting and waiting; then the place the
// work is in (its folder, its project) and what it changed. A path in the action or the folder opens the Files
// panel, the changes open the Changes panel. The line above it (SessionDock.tsx) holds the plan and the agents.
import { Boxes, Folder } from "lucide-react";
import type { ReactNode } from "react";
import { STATE_WORD, stateLabel } from "../../../src/core/state-words.ts";
import { briefText, whyText } from "../../../src/core/watch.ts";
import { momentOf, pathInAction, type Moment } from "../lib/now-line.ts";
import { projectOfFolder, useProjects } from "../lib/projects.ts";
import { useStore } from "../lib/store.ts";
import { navigate, savePref, setUI } from "../lib/ui.ts";
import { useSessionState } from "../lib/watch.ts";
import { folderOf, tickOf, timed, stateClock, useNow } from "./Mark.tsx";

// What a screen reader is told of the marker: the state's word (the vocabulary's), the same whatever the motion.
const MOMENT_WORD: Record<Moment, string> = { thinking: STATE_WORD.work, acting: STATE_WORD.work, waiting: STATE_WORD.wait, need: STATE_WORD.need };

// The marker: three dots that rise in turn (thinking), three bars that breathe (acting), a ring that fades slowly
// (waiting), a still dot in the owner's color (needs you). Each has its own shape at rest, so with motion off
// (styles.css) they still differ.
export function MomentMark({ moment }: { moment: Moment }) {
  return (
    <span className="k-moment" data-moment={moment} role="img" aria-label={MOMENT_WORD[moment]} data-testid="dock-moment">
      <i /><i /><i />
    </span>
  );
}

// The Files panel on a place in the session's folder: a file at its top, or the folder's list.
export function showInFiles(sessionId: string, rel: string) {
  if (rel) setUI({ fileAt: { session: sessionId, path: rel, n: Date.now() } });
  savePref("panel", "files");
}

export function DockNow({ sessionId, changes }: { sessionId: string; changes: ReactNode }) {
  const session = useStore((s) => s.sessions[sessionId]);
  const st = useSessionState(session);
  const now = useNow(timed(st), tickOf(st));
  const project = useProjects((s) => s.projects.find((p) => p.id === (session ? (s.members[session.id] ?? projectOfFolder(session.workspace)?.id) : undefined)));
  if (!session) return null;
  const moment = momentOf(st);
  const said = st.text ? briefText(st, now) : "";
  const whole = st.text ? whyText(st, now) : "";
  // At rest the line says the state in its word (and the reason a failure or a stop has); at work, the action.
  const words = moment ? said || stateLabel(st) : [stateLabel(st), st.watch === "fail" || st.watch === "declined" || st.watch === "stop" ? said : ""].filter(Boolean).join(": ");
  const path = moment === "acting" ? pathInAction(said, session.workspace) : null;
  const clock = moment && timed(st) ? stateClock(st, now) : "";
  const folder = session.workspace ? folderOf(session) : "";
  return (
    <div className="k-docket-line k-now" data-testid="dock-now" data-moment={moment ?? undefined} data-watch={st.watch} data-why={st.why}>
      <span className="k-now-act" data-testid="dock-action" title={whole || undefined}>
        {moment ? <MomentMark moment={moment} /> : <span className="k-now-rest" aria-hidden="true" />}
        <span className="k-now-text" data-testid="dock-action-text">
          {path ? (
            <>
              {path.before}
              <button type="button" className="k-now-path" data-testid="dock-action-path" title={`Open ${path.dir ? "the folder" : path.path} in Files`} onClick={() => showInFiles(sessionId, path.rel)}>{path.path}</button>
            </>
          ) : words}
        </span>
        {clock && <span className="k-now-clock k-face-figure" data-testid="dock-action-clock">{clock}</span>}
      </span>
      {folder && (
        <button type="button" className="k-now-seg k-now-folder" data-testid="dock-folder" title={`${session.workspace}\nOpen the folder in Files`} aria-label={`Folder ${session.workspace}: open it in Files`} onClick={() => showInFiles(sessionId, "")}>
          <Folder className="k-docket-glyph" aria-hidden="true" />
          <span className="k-now-name">{folder}</span>
        </button>
      )}
      {project && (
        <button type="button" className="k-now-seg k-now-project" data-testid="dock-project" title={`Project ${project.name}`} aria-label={`Project ${project.name}: open it`} onClick={() => navigate({ name: "project", id: project.id })}>
          <Boxes className="k-docket-glyph" aria-hidden="true" />
          <span className="k-now-name">{project.name}</span>
        </button>
      )}
      {changes}
    </div>
  );
}

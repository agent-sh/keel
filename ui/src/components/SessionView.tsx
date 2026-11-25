import type { PromptBlock } from "../../../src/core/types.ts";
import { lazy, memo, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { setBaseTitle } from "./Attention.tsx";
import { FolderX, WifiOff } from "lucide-react";
import { WaitingElsewhere } from "./AnswerQueue.tsx";
import { ReachLine } from "./ReachLine.tsx";
import { Boundary } from "./Boundary.tsx";
import { ChildApprovals } from "./automation/ChildApprovals.tsx";
import { sequenceAt } from "../lib/asks.ts";
import { stopHere, useAuto } from "../lib/automation.ts";
import { Composer } from "./Composer.tsx";
import { SelectionBar } from "./SelectionBar.tsx";
import { SessionHeader, SidebarButton } from "./SessionHeader.tsx";
import { openPanel, SidePanel, usePanelSheet } from "./SidePanel.tsx";
import { LiveSourceBanner } from "./TakeOver.tsx";
import { OutsideBar } from "./OutsideBar.tsx";
import { TranscriptLoading } from "./TranscriptLoading.tsx";
import { switchSession } from "../lib/switch.ts";
import { actions, getState, reportError, scope, useStore } from "../lib/store.ts";
import type { ModelPick } from "./ModelMenu.tsx";
import { navigate } from "../lib/ui.ts";
import { useAgentCount } from "../lib/watch.ts";
import { whenIdle } from "../lib/utils.ts";
import { machineName, useFleet } from "../lib/fleet.ts";
import "../lib/gutter.ts";
import { useAppSays } from "./Stale.tsx";
import { DESK_QUERY } from "../lib/phone.ts";

// The conversation (Markdown, tool rows) is its own chunk: the start page does
// not need it, and a session link starts loading it with the page.
const loadTranscript = () => import("./Transcript.tsx");
const Transcript = lazy(() => loadTranscript().then((m) => ({ default: m.Transcript })));
const HeldMessages = lazy(() => import("./FleetMessages.tsx").then((m) => ({ default: m.HeldMessages })));
const SessionDock = lazy(() => import("./SessionDock.tsx").then((m) => ({ default: m.SessionDock })));
if (location.pathname.startsWith("/s/")) loadTranscript();
else whenIdle(() => void loadTranscript());
const Approvals = lazy(() => import("./ApprovalCard.tsx").then((m) => ({ default: m.Approvals })));
const Questions = lazy(() => import("./QuestionCard.tsx").then((m) => ({ default: m.Questions })));


export { Boundary };

// One session: header, transcript, the dock, approvals and the composer.
// `header` replaces the standard header (a shell's own), `missingHeader` heads the
// view of a session this daemon does not have; `panel` shows the side panel.
// `back`: the view lies over something it leads back to (a look over a pane's
// session): Escape goes back, as it does from an agent's session, and the turn
// is stopped by its Stop button, the same one as in every pane.
export function SessionView({ id, header, missingHeader, panel = true, focus = true, back }: { id: string; header?: ReactNode; missingHeader?: ReactNode; panel?: boolean; focus?: boolean; back?: () => void }) {
  const session = useStore((s) => s.sessions[id]);
  const said = useAppSays() ?? "Keel is not reachable";
  // A link to a session that is gone (deleted, another daemon's) says so instead of loading forever.
  const [missing, setMissing] = useState<string | null>(null);
  // A load that failed for want of the daemon (a cold open offline) is tried
  // again when the connection is back: this route's session, not only the
  // ones the page already held.
  const [unreached, setUnreached] = useState<string | null>(null);
  const connected = useStore((s) => s.connected);
  const gone = useStore((s) => s.gone[id]);
  const loaded = useStore((s) => !!s.events[id]);
  // A compaction between turns has no turn, and Stop ends it all the same (the daemon aborts its request).
  const compacting = useStore((s) => s.status[id]?.kind === "compacting");
  // The page's socket is asked for this session's stream while the view is up (lib/scope.ts).
  useEffect(() => scope.show(id), [id]);
  useEffect(() => {
    setMissing(null);
    if (unreached === id && !connected) return;
    actions.openSession(id).then(() => { scope.loaded(id); setUnreached(null); }, (e) => {
      const status = (e as { status?: number }).status;
      if (status === 404) setMissing(id);
      else if (status === undefined && e instanceof TypeError) setUnreached(id);
      else reportError(e, { at: "open session" });
    });
  }, [id, unreached === id && connected]);
  // A session elsewhere says where in the tab's title too.
  const on = useFleet((x) => (session?.machine ? machineName(session.machine) ?? "" : "")) || undefined;
  useEffect(() => { if (focus) setBaseTitle(session?.title ? `${session.title}${on ? ` on ${on}` : ""} - Keel` : "Keel"); }, [session?.title, on, focus]);
  // A panel lying over the conversation covers it: nothing under it takes focus, text or a press.
  const covered = usePanelSheet(session, !!panel);
  // (One function for the life of the view: the message box is not drawn again for a new one.)
  const backNow = useRef(back);
  backNow.current = back;
  const goBack = useMemo(() => (back ? () => backNow.current?.() : undefined), [!back]);
  // The conversation is drawn by what changes in it, not each time its pane draws its part (the
  // header, the panel, the message box): a long one is not gone through again for those.
  const transcript = useMemo(() => <Transcript sessionId={id} />, [id]);
  // The session and its panel: the words selected anywhere in them are offered for a quote or a comment.
  const body = useRef<HTMLDivElement>(null);
  if (!session && (missing === id || gone)) {
    return (
      <div className="flex flex-1 flex-col" data-testid="session-missing">
        {missingHeader ?? <div className="flex h-12 items-center px-2 md:px-4"><SidebarButton /></div>}
        <div className={missingHeader ? "max-w-md px-[1.375rem] py-5" : "m-auto max-w-sm text-center"}>
          {!missingHeader && <p className="text-ui text-fg">This session is not on this daemon.</p>}
          <p className="mt-1 text-caption text-muted">It was deleted, or the link comes from another machine.</p>
          {typeof gone === "string"
            ? <button type="button" data-testid="missing-parent" onClick={() => navigate({ name: "session", id: gone })} className="k-btn k-btn-lg mt-3">Back to the parent session</button>
            : <button type="button" onClick={() => navigate({ name: "new" })} className="k-btn k-btn-lg mt-3">Start a new session</button>}
        </div>
      </div>
    );
  }
  if (!session) {
    return (
      <div className="flex flex-1 flex-col">
        <div className="flex h-12 items-center px-2 md:px-4"><SidebarButton /></div>
        <div className="m-auto text-ui text-faint" data-testid={unreached === id ? "session-unreached" : undefined}>
          {unreached === id ? `${said}. The session opens when the connection is back.` : "Opening the session"}
        </div>
      </div>
    );
  }
  return (
    <>
      {header ?? <SessionHeader session={session} />}
      <div ref={body} className="relative flex min-h-0 flex-1">
        <div className="k-session flex min-w-0 flex-1 flex-col" inert={covered}>
          {/* Until the conversation is here (its events, and the chunk that draws them), the pane says it is loading. */}
          <Boundary><Suspense fallback={<TranscriptLoading />}>{loaded ? transcript : <TranscriptLoading unreached={unreached === id} />}</Suspense></Boundary>
          {/* The stack is one height budget (Composer's Tray): the cards above the box scroll, the box stays. */}
          {/* Its right padding is the conversation's scroll bar, measured once the conversation is drawn; until then the
              width a scroll bar takes on this page (lib/gutter.ts), so nothing in it moves sideways as it arrives. */}
          <div className="k-compose flex min-h-0 flex-col pr-[var(--sbw,var(--k-gutter,0px))]">
            <div className="k-compose-in mx-auto flex min-h-0 w-full max-w-[48rem] flex-col px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:px-6 md:pb-5">
              {/* A session another harness runs is read-only here: its bar takes the box's place. */}
              {session.outside
                ? <OutsideBar session={session} />
                : <SessionCompose id={session.id} parentId={session.parent_id ?? null} working={session.phase === "working" || compacting} model={session.model} workspace={session.workspace} folderGone={!!session.workspace_gone} unreached={unreached === id} focus={focus} back={goBack} panel={panel} />}
            </div>
          </div>
        </div>
        {panel && <Boundary><SidePanel session={session} /></Boundary>}
        <SelectionBar sid={session.id} root={body} working={session.phase === "working"} />
      </div>
    </>
  );
}

// The session's message box with the cards above it. It is drawn again only
// when one of these facts changes: the session's row changes with every
// stored event (its head moves), and the box, its pickers and the cards have
// nothing to say about that.
// `panel`: this pane has the side panel (the plan's strip gives way while its Tasks tab is open).
const SessionCompose = memo(function SessionCompose({ id, parentId, working, model, workspace, folderGone, unreached, focus, back, panel }: { id: string; parentId: string | null; working: boolean; model: string; workspace: string; folderGone: boolean; unreached: boolean; focus: boolean; back?: () => void; panel?: boolean }) {
  const session = useMemo(() => ({ id }), [id]);
  // A coordinator's Stop ends its turn; its agents go on (the turn's end line offers to stop them too).
  const agents = useAgentCount(parentId ? undefined : id);
  // An agent another program runs (an ACP agent's child) reads no message from here.
  const outside = useAuto((x) => Object.values(x.agents).find((a) => a.session_id === id)?.external?.agent);
  const does = useMemo(() => ({
    // The picker's row sets the effort with the model; on the model in use that is an effort change alone.
    model: (m: string, p?: ModelPick) => {
      const s = getState().sessions[id];
      const change = p?.effort && s?.model === m ? (p.effort === s.settings.effort ? { model: m } : { effort: p.effort }) : { model: m, ...(p?.effort ? { effort: p.effort } : {}) };
      return switchSession(id, change, { compactFirst: p?.compactFirst }).catch(reportError);
    },
    send: (t: string, images: PromptBlock[], client_id?: string) => actions.send(id, t, { images, client_id }),
    queue: (t: string, images: PromptBlock[], client_id?: string) => actions.send(id, t, { mode: "queue", images, client_id }),
    stop: () => void stopHere({ id, parent_id: parentId }),
    escape: back ?? (parentId ? () => navigate({ name: "session", id: parentId }) : undefined),
  }), [id, parentId, back]);
  const above = useMemo(() => (
    <>
      {unreached && <Unreached />}
      {folderGone && <FolderGone path={workspace} />}
      <LiveSourceBanner sessionId={id} />
      <Suspense fallback={null}><HeldMessages sessionId={id} /></Suspense>
      <Suspense fallback={null}><SessionDock sessionId={id} panel={panel} /></Suspense>
    </>
  ), [id, unreached, folderGone, workspace, panel]);
  const asks = useMemo(() => (
    <>
      <WaitingElsewhere sessionId={id} />
      <ReachLine sessionId={id} />
      <Suspense fallback={null}><Questions sessionId={id} /></Suspense>
      <Suspense fallback={null}><Approvals sessionId={id} /></Suspense>
      <ChildApprovals parentId={id} />
    </>
  ), [id]);
  return (
    <Composer
      session={session}
      working={working}
      model={model}
      workspace={workspace}
      onModel={does.model}
      onSend={does.send}
      onQueue={does.queue}
      onStop={does.stop}
      stopLeaves={agents ? (agents === 1 ? "its agent goes on" : `its ${agents} agents go on`) : undefined}
      {...(does.escape ? { onEscape: does.escape, ...(parentId ? { stopLabel: "Stop this agent" } : {}) } : {})}
      focus={focus}
      // (Not in a pane the answering sequence opened to bring the keyboard to its card: lib/asks.ts.)
      autoFocus={focus && matchMedia(DESK_QUERY).matches && sequenceAt() !== id}
      above={above}
      asks={asks}
      closed={outside ? `${outside} runs this agent. Keel shows its work and asks you for what it needs; it reads no message from here.` : undefined}
    />
  );
});

// The session's folder is not on disk: the transcript reads as before, and
// the way on is to move the session to a folder that exists.
// The session's row is known (from the list) but its history could not be
// fetched: said, not shown as an empty conversation.
function Unreached() {
  const said = useAppSays() ?? "Keel is not reachable";
  return (
    <div className="k-notice mb-2" data-testid="session-unreached" role="status">
      <WifiOff className="size-4 shrink-0 text-warn" aria-hidden="true" />
      <p className="min-w-0 flex-1">
        <span className="text-fg">{said}.</span>{" "}
        <span className="text-muted">The conversation loads when the connection is back.</span>
      </p>
    </div>
  );
}

function FolderGone({ path }: { path: string }) {
  return (
    <div className="k-notice mb-2" data-testid="folder-gone" role="status">
      <FolderX className="size-4 shrink-0 text-st-fail" aria-hidden="true" />
      <p className="min-w-0 flex-1">
        <span className="text-fg">The folder is gone.</span>{" "}
        <span className="text-muted">Tools that read or change files cannot run in <code className="font-mono text-caption">{path.replace(/^\/home\/[^/]+/, "~")}</code>.</span>
      </p>
      <button type="button" onClick={() => openPanel("session")} className="k-btn shrink-0" data-testid="folder-gone-move">Move the session</button>
    </div>
  );
}

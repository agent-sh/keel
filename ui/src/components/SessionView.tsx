import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { FolderX } from "lucide-react";
import { Boundary } from "./Boundary.tsx";
import { ChildApprovals } from "./automation/ChildApprovals.tsx";
import { Composer } from "./Composer.tsx";
import { SessionHeader, SidebarButton } from "./SessionHeader.tsx";
import { openPanel, SidePanel } from "./SidePanel.tsx";
import { LiveSourceBanner } from "./TakeOver.tsx";
import { switchSession } from "../lib/switch.ts";
import { actions, reportError, useStore } from "../lib/store.ts";
import { navigate } from "../lib/ui.ts";

// The conversation (Markdown, tool rows) is its own chunk: the start page does
// not need it, and a session link starts loading it with the page.
const loadTranscript = () => import("./Transcript.tsx");
const Transcript = lazy(() => loadTranscript().then((m) => ({ default: m.Transcript })));
const HeldMessages = lazy(() => import("./FleetMessages.tsx").then((m) => ({ default: m.HeldMessages })));
const SessionDock = lazy(() => import("./SessionDock.tsx").then((m) => ({ default: m.SessionDock })));
if (location.pathname.startsWith("/s/")) loadTranscript();
else (window.requestIdleCallback ?? setTimeout)(() => void loadTranscript());
const Approvals = lazy(() => import("./ApprovalCard.tsx").then((m) => ({ default: m.Approvals })));


export { Boundary };

// One session: header, transcript, the dock, approvals and the composer.
// `header` replaces the standard header (a shell's own), `missingHeader` heads the
// view of a session this daemon does not have; `panel` shows the side panel.
export function SessionView({ id, header, missingHeader, panel = true, focus = true }: { id: string; header?: ReactNode; missingHeader?: ReactNode; panel?: boolean; focus?: boolean }) {
  const session = useStore((s) => s.sessions[id]);
  // A link to a session that is gone (deleted, another daemon's) says so instead of loading forever.
  const [missing, setMissing] = useState<string | null>(null);
  const gone = useStore((s) => !!s.gone[id]);
  useEffect(() => {
    setMissing(null);
    actions.loadSession(id).catch((e) => {
      if ((e as { status?: number }).status === 404) setMissing(id);
      else reportError(e, { at: "open session" });
    });
  }, [id]);
  useEffect(() => { if (focus) document.title = session?.title ? `${session.title} - Keel` : "Keel"; }, [session?.title, focus]);
  if (!session && (missing === id || gone)) {
    return (
      <div className="flex flex-1 flex-col" data-testid="session-missing">
        {missingHeader ?? <div className="flex h-12 items-center px-2 md:px-4"><SidebarButton /></div>}
        <div className={missingHeader ? "max-w-md px-[22px] py-5" : "m-auto max-w-sm text-center"}>
          {!missingHeader && <p className="text-ui text-fg">This session is not on this daemon.</p>}
          <p className="mt-1 text-caption text-muted">It was deleted, or the link comes from another machine.</p>
          <button type="button" onClick={() => navigate({ name: "new" })} className="mt-3 h-8 rounded-md border border-line px-3 text-ui hover:bg-hover">Start a new session</button>
        </div>
      </div>
    );
  }
  if (!session) {
    return (
      <div className="flex flex-1 flex-col">
        <div className="flex h-12 items-center px-2 md:px-4"><SidebarButton /></div>
        <div className="m-auto text-ui text-faint">Opening the session</div>
      </div>
    );
  }
  return (
    <>
      {header ?? <SessionHeader session={session} />}
      <div className="flex min-h-0 flex-1">
        <div className="k-session flex min-w-0 flex-1 flex-col">
          <Boundary><Suspense fallback={<div className="flex-1" />}><Transcript sessionId={session.id} /></Suspense></Boundary>
          <div className="k-compose pr-[var(--sbw,0px)]">
            <div className="k-compose-in mx-auto w-full max-w-[48rem] px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:px-6 md:pb-5">
              {session.workspace_gone && <FolderGone path={session.workspace} />}
              <LiveSourceBanner sessionId={session.id} />
              <Suspense fallback={null}><HeldMessages sessionId={session.id} /></Suspense>
              <Suspense fallback={null}><SessionDock sessionId={session.id} /></Suspense>
              <Suspense fallback={null}><Approvals sessionId={session.id} /></Suspense>
              <ChildApprovals parentId={session.id} />
              <Composer
                session={session}
                working={session.phase === "working"}
                model={session.model}
                workspace={session.workspace}
                onModel={(m) => switchSession(session.id, { model: m }).catch(reportError)}
                onSend={(t, images) => actions.send(session.id, t, { images })}
                onQueue={(t, images) => actions.send(session.id, t, { mode: "queue", images })}
                onStop={() => actions.interrupt(session.id).catch(reportError)}
                focus={focus}
                autoFocus={focus && matchMedia("(min-width: 768px)").matches}
              />
            </div>
          </div>
        </div>
        {panel && <Boundary><SidePanel session={session} /></Boundary>}
      </div>
    </>
  );
}

// The session's folder is not on disk: the transcript reads as before, and
// the way on is to move the session to a folder that exists.
function FolderGone({ path }: { path: string }) {
  return (
    <div className="mb-2 flex items-center gap-3 rounded-md border border-line border-l-[3px] border-l-st-fail bg-raised px-3 py-2 text-ui" data-testid="folder-gone" role="status">
      <FolderX className="size-4 shrink-0 text-st-fail" aria-hidden="true" />
      <p className="min-w-0 flex-1">
        <span className="text-fg">The folder is gone.</span>{" "}
        <span className="text-muted">Tools that read or change files cannot run in <code className="font-mono text-caption">{path.replace(/^\/home\/[^/]+/, "~")}</code>.</span>
      </p>
      <button type="button" onClick={() => openPanel("session")} className="h-7 shrink-0 rounded-md border border-line px-2.5 text-caption text-fg hover:bg-hover" data-testid="folder-gone-move">Move the session</button>
    </div>
  );
}

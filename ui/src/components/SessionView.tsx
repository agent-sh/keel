import { Component, lazy, Suspense, useEffect, type ReactNode } from "react";
import { ChildApprovals } from "./automation/ChildApprovals.tsx";
import { Composer } from "./Composer.tsx";
import { SessionHeader, SidebarButton } from "./SessionHeader.tsx";
import { SidePanel } from "./SidePanel.tsx";
import { switchSession } from "../lib/switch.ts";
import { actions, reportError, useStore } from "../lib/store.ts";

// The conversation (Markdown, tool rows) is its own chunk: the start page does
// not need it, and a session link starts loading it with the page.
const loadTranscript = () => import("./Transcript.tsx");
const Transcript = lazy(() => loadTranscript().then((m) => ({ default: m.Transcript })));
const HeldMessages = lazy(() => import("./FleetMessages.tsx").then((m) => ({ default: m.HeldMessages })));
const SessionDock = lazy(() => import("./SessionDock.tsx").then((m) => ({ default: m.SessionDock })));
if (location.pathname.startsWith("/s/")) loadTranscript();
else (window.requestIdleCallback ?? setTimeout)(() => void loadTranscript());
const Approvals = lazy(() => import("./ApprovalCard.tsx").then((m) => ({ default: m.Approvals })));

export class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  override componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    reportError(error, { kind: "react", componentStack: info.componentStack });
  }
  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="m-auto max-w-md p-8 text-center">
        <p className="font-semibold">This view failed to render.</p>
        <p className="mt-1 text-ui text-muted">{this.state.error.message}</p>
        <p className="mt-1 text-caption text-faint">It is recorded in Errors.</p>
        <button className="mt-4 h-8 rounded-md bg-accent px-3 text-ui font-medium text-accent-fg hover:bg-accent-hover" onClick={() => this.setState({ error: null })}>Render again</button>
      </div>
    );
  }
}

// One session: header, transcript, the dock, approvals and the composer.
// `header` replaces the standard header (a shell's own); `panel` shows the side panel.
export function SessionView({ id, header, panel = true, focus = true }: { id: string; header?: ReactNode; panel?: boolean; focus?: boolean }) {
  const session = useStore((s) => s.sessions[id]);
  useEffect(() => { actions.loadSession(id).catch(reportError); }, [id]);
  useEffect(() => { if (focus) document.title = session?.title ? `${session.title} - Keel` : "Keel"; }, [session?.title, focus]);
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

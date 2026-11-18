import { Component, lazy, Suspense, useEffect, useRef, type ReactNode } from "react";
import { Approvals } from "./components/ApprovalCard.tsx";
import { ChildApprovals } from "./components/automation/ChildApprovals.tsx";
import { Composer } from "./components/Composer.tsx";
import { ConfirmHost } from "./components/Confirm.tsx";
import { McpOverlay } from "./components/McpPanel.tsx";
import { SessionDock } from "./components/SessionDock.tsx";
import { SessionHeader, SidebarButton } from "./components/SessionHeader.tsx";
import { SidePanel } from "./components/SidePanel.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { StartBox } from "./components/StartBox.tsx";
import { Transcript } from "./components/Transcript.tsx";
import "./lib/builtins.ts";
import "./lib/tools-ui.ts";
import "./lib/providers-ui.ts";
import "./lib/admin-ui.ts";
import { installKeymap } from "./lib/keys.ts";
import { actions, connect, reportError, useStore } from "./lib/store.ts";
import { savePref, setUI, useUI } from "./lib/ui.ts";
import { cn } from "./lib/utils.ts";

// Overlays and Settings load on first use; the first page carries the shell only.
const Palette = lazy(() => import("./components/Palette.tsx").then((m) => ({ default: m.Palette })));
const ShortcutSheet = lazy(() => import("./components/ShortcutSheet.tsx").then((m) => ({ default: m.ShortcutSheet })));
const ErrorsPanel = lazy(() => import("./components/ErrorsPanel.tsx").then((m) => ({ default: m.ErrorsPanel })));
const Settings = lazy(() => import("./components/Settings.tsx").then((m) => ({ default: m.Settings })));

// Mounts its child the first time `open` is true, then keeps it (for close animations).
function OnFirstOpen({ open, children }: { open: boolean; children: ReactNode }) {
  const seen = useRef(false);
  if (open) seen.current = true;
  return seen.current ? <Suspense fallback={null}>{children}</Suspense> : null;
}

class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
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

function SessionView({ id }: { id: string }) {
  const session = useStore((s) => s.sessions[id]);
  useEffect(() => { actions.loadSession(id).catch(reportError); }, [id]);
  useEffect(() => { document.title = session?.title ? `${session.title} - Keel` : "Keel"; }, [session?.title]);
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
      <SessionHeader session={session} />
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <Boundary><Transcript sessionId={session.id} /></Boundary>
          <div className="pr-[var(--sbw,0px)]">
            <div className="mx-auto w-full max-w-[48rem] px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:px-6 md:pb-5">
              <SessionDock sessionId={session.id} />
              <Approvals sessionId={session.id} />
              <ChildApprovals parentId={session.id} />
              <Composer
                session={session}
                working={session.phase === "working"}
                model={session.model}
                workspace={session.workspace}
                onModel={(m) => actions.patch(session.id, { model: m }).catch(reportError)}
                onSend={(t, images) => actions.send(session.id, t, { images })}
                onQueue={(t) => actions.send(session.id, t, { mode: "queue" })}
                onStop={() => actions.interrupt(session.id).catch(reportError)}
                autoFocus={matchMedia("(min-width: 768px)").matches}
              />
            </div>
          </div>
        </div>
        <Boundary><SidePanel session={session} /></Boundary>
      </div>
    </>
  );
}

export function App() {
  const route = useUI((s) => s.route);
  const sidebar = useUI((s) => s.sidebar);

  useEffect(() => {
    connect();
    actions.loadSessions().catch(reportError);
    actions.loadModels().catch(reportError);
    actions.loadErrors().catch(reportError);
    return installKeymap();
  }, []);
  useEffect(() => { if (route.name !== "session") document.title = route.name === "settings" ? "Settings - Keel" : "Keel"; }, [route]);

  return (
    <Boundary>
      <div
        className="flex h-full overflow-hidden"
        onDragOver={(e) => e.dataTransfer.types.includes("Files") && e.preventDefault()}
        onDrop={(e) => {
          if (!e.dataTransfer.files.length) return;
          e.preventDefault();
          dispatchEvent(new CustomEvent("keel:files", { detail: [...e.dataTransfer.files] }));
        }}
      >
        {/* Desktop: the sidebar is part of the layout. Phone: a drawer over it. */}
        <div
          className={cn(
            "z-40 h-full shrink-0 transition-[margin,transform] duration-200 ease-[var(--ease-out)]",
            "max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:shadow-3",
            sidebar ? "md:ml-0" : "md:-ml-[272px] max-md:-translate-x-full",
          )}
        >
          <Sidebar />
        </div>
        {sidebar && <div className="fixed inset-0 z-30 bg-overlay md:hidden" onClick={() => savePref("sidebar", false)} aria-hidden="true" />}
        <main className="flex min-w-0 flex-1 flex-col">
          {route.name === "session" ? <SessionView key={route.id} id={route.id} /> : route.name === "settings" ? <Suspense fallback={null}><Settings section={route.section} /></Suspense> : <StartBox />}
        </main>
      </div>
      <Overlays />
      <ConfirmHost />
    </Boundary>
  );
}

function Overlays() {
  const palette = useUI((s) => s.palette);
  const shortcuts = useUI((s) => s.shortcuts);
  const errors = useUI((s) => s.errors);
  return (
    <>
      <OnFirstOpen open={palette}><Palette /></OnFirstOpen>
      <OnFirstOpen open={shortcuts}><ShortcutSheet /></OnFirstOpen>
      <McpOverlay />
      <OnFirstOpen open={errors}><ErrorsPanel open={errors} onOpenChange={(o) => setUI({ errors: o })} /></OnFirstOpen>
    </>
  );
}

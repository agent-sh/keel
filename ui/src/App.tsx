import { lazy, Suspense, useEffect, useRef, type ReactNode } from "react";
import { ConfirmHost } from "./components/Confirm.tsx";
import { Boundary, SessionView } from "./components/SessionView.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { StartBox } from "./components/StartBox.tsx";
import "./lib/builtins.ts";
import "./lib/tools-ui.ts";
import "./lib/providers-ui.ts";
import "./lib/admin-ui.ts";
import "./lib/integrations-ui.ts";
import { useDirection } from "./lib/direction.ts";
import { installKeymap } from "./lib/keys.ts";
import { actions, connect, reportError } from "./lib/store.ts";
import { savePref, setUI, useUI } from "./lib/ui.ts";
import { cn } from "./lib/utils.ts";

// Overlays and Settings load on first use; the first page carries the shell only.
const Palette = lazy(() => import("./components/Palette.tsx").then((m) => ({ default: m.Palette })));
const ShortcutSheet = lazy(() => import("./components/ShortcutSheet.tsx").then((m) => ({ default: m.ShortcutSheet })));
const McpPanel = lazy(() => import("./components/McpPanel.tsx").then((m) => ({ default: m.McpPanel })));
const ErrorsPanel = lazy(() => import("./components/ErrorsPanel.tsx").then((m) => ({ default: m.ErrorsPanel })));
const Board = lazy(() => import("./components/Board.tsx").then((m) => ({ default: m.Board })));
const Settings = lazy(() => import("./components/Settings.tsx").then((m) => ({ default: m.Settings })));
// Each direction's shell is its own chunk: only the chosen one loads.
const Bridge = lazy(() => import("./components/shells/Bridge.tsx").then((m) => ({ default: m.Bridge })));
const Wake = lazy(() => import("./components/shells/Wake.tsx").then((m) => ({ default: m.Wake })));
const Watch = lazy(() => import("./components/shells/Watch.tsx").then((m) => ({ default: m.Watch })));

// Mounts its child the first time `open` is true, then keeps it (for close animations).
function OnFirstOpen({ open, children }: { open: boolean; children: ReactNode }) {
  const seen = useRef(false);
  if (open) seen.current = true;
  return seen.current ? <Suspense fallback={null}>{children}</Suspense> : null;
}

// The single-column shell: the sidebar, one session.
function Classic() {
  const route = useUI((s) => s.route);
  const sidebar = useUI((s) => s.sidebar);
  return (
    <>
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
        {route.name === "session" ? <SessionView key={route.id} id={route.id} /> : <StartBox />}
      </main>
    </>
  );
}

export function App() {
  const route = useUI((s) => s.route);
  const direction = useDirection();

  useEffect(() => {
    connect();
    actions.loadSessions().catch(reportError);
    actions.loadModels().catch(reportError);
    actions.loadErrors().catch(reportError);
    return installKeymap();
  }, []);
  useEffect(() => { if (route.name !== "session") document.title = route.name === "settings" ? "Settings - Keel" : route.name === "board" ? "Board - Keel" : "Keel"; }, [route]);

  // Settings and the board are pages of their own in every direction.
  const page = route.name === "settings" || route.name === "board";
  return (
    <Boundary>
      <div
        className="k-app flex h-full overflow-hidden"
        onDragOver={(e) => e.dataTransfer.types.includes("Files") && e.preventDefault()}
        onDrop={(e) => {
          if (!e.dataTransfer.files.length) return;
          e.preventDefault();
          dispatchEvent(new CustomEvent("keel:files", { detail: [...e.dataTransfer.files] }));
        }}
      >
        {direction === "classic" || page ? (
          page ? (
            <>
              {direction === "classic" && <ClassicSidebarOnly />}
              <main className="flex min-w-0 flex-1 flex-col"><Suspense fallback={null}>{route.name === "settings" ? <Settings section={route.section} /> : <Board />}</Suspense></main>
            </>
          ) : <Classic />
        ) : (
          <Suspense fallback={null}>
            {direction === "bridge" ? <Bridge /> : direction === "wake" ? <Wake /> : <Watch />}
          </Suspense>
        )}
      </div>
      <Overlays />
      <ConfirmHost />
    </Boundary>
  );
}

function ClassicSidebarOnly() {
  const sidebar = useUI((s) => s.sidebar);
  return (
    <>
      <div className={cn("z-40 h-full shrink-0 transition-[margin,transform] duration-200 ease-[var(--ease-out)] max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:shadow-3", sidebar ? "md:ml-0" : "md:-ml-[272px] max-md:-translate-x-full")}>
        <Sidebar />
      </div>
      {sidebar && <div className="fixed inset-0 z-30 bg-overlay md:hidden" onClick={() => savePref("sidebar", false)} aria-hidden="true" />}
    </>
  );
}

function Overlays() {
  const palette = useUI((s) => s.palette);
  const shortcuts = useUI((s) => s.shortcuts);
  const errors = useUI((s) => s.errors);
  const mcp = useUI((s) => s.mcp);
  return (
    <>
      <OnFirstOpen open={palette}><Palette /></OnFirstOpen>
      <OnFirstOpen open={shortcuts}><ShortcutSheet /></OnFirstOpen>
      <OnFirstOpen open={mcp}><McpPanel open={mcp} onOpenChange={(o) => setUI({ mcp: o })} /></OnFirstOpen>
      <OnFirstOpen open={errors}><ErrorsPanel open={errors} onOpenChange={(o) => setUI({ errors: o })} /></OnFirstOpen>
    </>
  );
}

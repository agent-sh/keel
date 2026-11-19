import { lazy, Suspense, useEffect, useRef, type ReactNode } from "react";
import { ConfirmHost } from "./components/Confirm.tsx";
import { Boundary } from "./components/Boundary.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import "./lib/builtins.ts";
import "./lib/tools-ui.ts";
import "./lib/providers-ui.ts";
import "./lib/admin-ui.ts";
import { AdminBand } from "./components/AdminBand.tsx";
import "./lib/integrations-ui.ts";
import "./lib/surfaces-ui.ts";
import { installKeymap } from "./lib/keys.ts";
import { actions, connect, reportError } from "./lib/store.ts";
import { phone, savePref, setUI, useUI } from "./lib/ui.ts";

// Overlays and Settings load on first use; the first page carries the shell only.
const Palette = lazy(() => import("./components/Palette.tsx").then((m) => ({ default: m.Palette })));
const ShortcutSheet = lazy(() => import("./components/ShortcutSheet.tsx").then((m) => ({ default: m.ShortcutSheet })));
const ErrorsPanel = lazy(() => import("./components/ErrorsPanel.tsx").then((m) => ({ default: m.ErrorsPanel })));
// The bridge (stations, sessions) is its own chunk, fetched with the page.
const Bridge = lazy(() => import("./components/Bridge.tsx").then((m) => ({ default: m.Bridge })));
const Settings = lazy(() => import("./components/Settings.tsx").then((m) => ({ default: m.Settings })));

// Mounts its child the first time `open` is true, then keeps it (for close animations).
function OnFirstOpen({ open, children }: { open: boolean; children: ReactNode }) {
  const seen = useRef(false);
  if (open) seen.current = true;
  return seen.current ? <Suspense fallback={null}>{children}</Suspense> : null;
}

export function App() {
  const route = useUI((s) => s.route);

  useEffect(() => {
    connect();
    actions.loadSessions().catch(reportError);
    actions.loadModels().catch(reportError);
    actions.loadErrors().catch(reportError);
    return installKeymap();
  }, []);
  useEffect(() => { if (route.name !== "session") document.title = route.name === "settings" ? "Settings - Keel" : "Keel"; }, [route]);

  const sidebar = useUI((s) => s.sidebar);
  const page = route.name === "settings";
  return (
    <Boundary>
      <div
        className="k-app"
        onDragOver={(e) => e.dataTransfer.types.includes("Files") && e.preventDefault()}
        onDrop={(e) => {
          if (!e.dataTransfer.files.length) return;
          e.preventDefault();
          dispatchEvent(new CustomEvent("keel:files", { detail: [...e.dataTransfer.files] }));
        }}
      >
        {/* Desktop: the rail, folded or open. Phone: the open rail as a drawer. */}
        <div className="k-rail-wrap" data-drawer={sidebar || undefined}><Sidebar open={sidebar || phone()} /></div>
        {sidebar && <div className="k-scrim" onClick={() => savePref("sidebar", false)} aria-hidden="true" />}
        {page ? (
          <main className="k-page"><Suspense fallback={null}>{route.name === "settings" && <Settings section={route.section} />}</Suspense></main>
        ) : <Suspense fallback={null}><Bridge /></Suspense>}
      </div>
      <Overlays />
      <ConfirmHost />
      <AdminBand />
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
      <OnFirstOpen open={errors}><ErrorsPanel open={errors} onOpenChange={(o) => setUI({ errors: o })} /></OnFirstOpen>
    </>
  );
}

import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { ConfirmHost } from "./components/Confirm.tsx";
import { ContextMenuHost } from "./components/ContextMenu.tsx";
import { PageFind } from "./components/FindBar.tsx";
import { inShell } from "./lib/shell.ts";
import { Attention, setBaseTitle } from "./components/Attention.tsx";
import { Boundary } from "./components/Boundary.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import "./lib/builtins.ts";
import { AnswerQueue } from "./components/AnswerQueue.tsx";
import { UndoToast } from "./components/UndoToast.tsx";
import "./lib/tools-ui.ts";
import "./lib/providers-ui.ts";
import "./lib/admin-ui.ts";
import { AdminBand } from "./components/AdminBand.tsx";
import { IncidentBand } from "./components/IncidentBand.tsx";
import { StaleMarks } from "./components/Stale.tsx";
import "./lib/integrations-ui.ts";
import "./lib/port-ui.ts";
import "./lib/surfaces-ui.ts";
import { installKeymap } from "./lib/keys.ts";
import { toggleList, useRail } from "./lib/rail.ts";
import { actions, connect, preloadSession, reportError, setBootLoad } from "./lib/store.ts";
import { focusApproval } from "./lib/automation.ts";
import { getUI, phone, savePref, setUI, useUI } from "./lib/ui.ts";

// Overlays and Settings load on first use; the first page carries the shell only.
const Palette = lazy(() => import("./components/Palette.tsx").then((m) => ({ default: m.Palette })));
const ShortcutSheet = lazy(() => import("./components/ShortcutSheet.tsx").then((m) => ({ default: m.ShortcutSheet })));
import { UpdateNotice } from "./components/UpdateNotice.tsx";
const ErrorsPanel = lazy(() => import("./components/ErrorsPanel.tsx").then((m) => ({ default: m.ErrorsPanel })));
// The bridge (stations, sessions) is its own chunk, fetched with the page.
const Bridge = lazy(() => import("./components/Bridge.tsx").then((m) => ({ default: m.Bridge })));
const ProjectPage = lazy(() => import("./components/ProjectPage.tsx").then((m) => ({ default: m.ProjectPage })));
const Settings = lazy(() => import("./components/Settings.tsx").then((m) => ({ default: m.Settings })));

// Mounts its child the first time `open` is true, then keeps it (for close animations).
function OnFirstOpen({ open, children }: { open: boolean; children: ReactNode }) {
  const seen = useRef(false);
  if (open) seen.current = true;
  return seen.current ? <Suspense fallback={null}>{children}</Suspense> : null;
}

// A session action can answer after its composer went away. In that case the
// shell shows the refusal instead, even on a different page.
function ArchivedRefusalNotice() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const on = (e: Event) => queueMicrotask(() => {
      if (e.defaultPrevented) return;
      setVisible(true);
      clearTimeout(t);
      t = setTimeout(() => setVisible(false), 4000);
    });
    addEventListener("keel:archived-refusal", on);
    return () => { removeEventListener("keel:archived-refusal", on); clearTimeout(t); };
  }, []);
  return visible ? (
    <div role="status" data-testid="archived-refusal" className="flex min-h-9 shrink-0 items-center justify-center border-b border-line bg-raised px-4 py-1 text-center text-ui text-warn">
      Action not taken: restore the archived session first.
    </div>
  ) : null;
}

export function App() {
  const route = useUI((s) => s.route);

  useEffect(() => {
    const at = getUI().route;
    if (at.name === "session") preloadSession(at.id);
    const approval = new URLSearchParams(location.search).get("approval");
    if (approval && at.name === "session") focusApproval(approval);
    // The first socket reloads whatever of this first load failed (a daemon
    // restart under the page), so it waits on all of it, not only the sessions.
    // A settings page lists models as it opens: the whole listing. Any other page shows a few.
    const loads = [actions.loadSessions(), at.name === "settings" ? actions.loadModels() : actions.loadModelsBrief([getUI().newModel]), actions.loadErrors()];
    for (const l of loads) l.catch(reportError);
    setBootLoad(Promise.all(loads));
    connect();
    return installKeymap();
  }, []);
  useEffect(() => { if (route.name !== "session") setBaseTitle(route.name === "settings" ? "Settings - Keel" : "Keel"); }, [route]);

  const sidebar = useUI((s) => s.sidebar);
  const rail = useRail();
  // Escape puts a laid-over list away (and nothing else: not the running turn).
  useEffect(() => {
    if (!rail.over) return;
    const f = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); toggleList(false); } };
    addEventListener("keydown", f, true);
    return () => removeEventListener("keydown", f, true);
  }, [rail.over]);
  // On a phone the open list is a drawer over the page, and it owns the
  // keyboard as a panel sheet does: the page under it is out of reach, the
  // keys start in the drawer (on the session shown), Tab stays in it, and
  // Escape, like a tap beside it, closes it and nothing else, with the keys
  // back on what opened it. A popup the drawer opened keeps its own keys.
  const drawer = phone() && sidebar;
  const wrap = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const closeDrawer = () => {
    toggleList(false);
    // The button that opened it left the header while the drawer was open: the one there now takes the keys.
    requestAnimationFrame(() => ((opener.current?.isConnected ? opener.current : null) ?? document.querySelector<HTMLElement>('[data-helm] [data-testid="show-sidebar"]') ?? document.querySelector<HTMLElement>('[data-testid="show-sidebar"], .k-dock-btn[aria-label="All sessions"]'))?.focus());
  };
  useEffect(() => {
    if (!drawer) return;
    const el = wrap.current;
    if (!el) return;
    opener.current = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    const stops = () => [...el.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])')].filter((x) => x.getClientRects().length > 0);
    // The drawer is not focusable until it starts to slide in: asked again on the next frames.
    let raf = 0, tries = 0;
    const enter = () => {
      (el.querySelector<HTMLElement>('[aria-current="page"]') ?? stops()[0])?.focus();
      if (!el.contains(document.activeElement) && tries++ < 12) raf = requestAnimationFrame(enter);
    };
    enter();
    let picked = 0;
    const f = (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") picked = Date.now();
      const at = document.activeElement;
      if (at instanceof HTMLElement && !el.contains(at) && at.closest('[role="menu"], [role="dialog"], [role="listbox"]')) return;
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); return closeDrawer(); }
      if (e.key !== "Tab") return;
      const all = stops();
      const first = all[0], last = all.at(-1);
      if (!first || !last) return;
      const out = !(at instanceof HTMLElement) || !el.contains(at);
      if (e.shiftKey ? out || at === first : out || at === last) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
    };
    addEventListener("keydown", f, true);
    return () => {
      cancelAnimationFrame(raf);
      removeEventListener("keydown", f, true);
      // A session picked in the drawer by a key closed it: the keys go on in
      // the session's pane (not into its message box: no keyboard pops up).
      if (Date.now() - picked > 1000) return;
      requestAnimationFrame(() => {
        // Still on the row inside the closed drawer, or on nothing: anything else took the keys by itself.
        const at = document.activeElement;
        if (at && at !== document.body && !el.contains(at)) return;
        const pane = document.querySelector<HTMLElement>(".k-station[data-helm]");
        if (!pane) return;
        pane.tabIndex = -1;
        pane.focus({ preventScroll: true });
      });
    };
  }, [drawer]);
  const page = route.name === "settings" || route.name === "project";
  return (
    <Boundary>
      <Attention />
      <StaleMarks />
      <AnswerQueue />
      <UndoToast />
      <div className="k-shell">
        <AdminBand />
        <IncidentBand />
        <ArchivedRefusalNotice />
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
          <div ref={wrap} className="k-rail-wrap" data-drawer={sidebar || undefined} data-over={rail.over || undefined}><Sidebar open={rail.list} /></div>
          {(rail.over || sidebar) && <div className="k-scrim" data-over={rail.over || undefined} onClick={() => (drawer ? closeDrawer() : toggleList(false))} aria-hidden="true" />}
          <div className="contents" inert={drawer} data-testid="under-drawer">
            {page ? (
              <main className="k-page"><Suspense fallback={null}>{route.name === "settings" && <Settings section={route.section} />}{route.name === "project" && <ProjectPage id={route.id} />}</Suspense></main>
            ) : <Suspense fallback={null}><Bridge /></Suspense>}
          </div>
        </div>
      </div>
      <Overlays />
      <ConfirmHost />
      <ContextMenuHost />
      {inShell && <PageFind at={route.name === "session" ? `s ${route.id}` : route.name} />}
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
      <UpdateNotice />
    </>
  );
}

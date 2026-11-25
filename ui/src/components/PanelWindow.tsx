// One side panel of one session, alone in a window (the place /s/ID?panel=NAME): no conversation, no list.
// The panel's own name and the session's title are in its head and in the window's bar. The window holds a
// lock for as long as it lives (lib/popout.ts), so the pane it was popped out of docks back when it closes.
import { Suspense, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Boundary } from "./Boundary.tsx";
import { setBaseTitle } from "./Attention.tsx";
import { panels } from "../lib/extend.ts";
import { DOCK_CHANNEL, lockName } from "../lib/popout.ts";
import { shell } from "../lib/shell.ts";
import { actions, reportError, scope, useStore } from "../lib/store.ts";
import { setUI } from "../lib/ui.ts";

export function PanelWindow({ id, panel }: { id: string; panel: string }) {
  const session = useStore((s) => s.sessions[id]);
  const gone = useStore((s) => !!s.gone[id]);
  const [missing, setMissing] = useState(false);
  const [docked, setDocked] = useState(false);
  useSyncExternalStore(panels.subscribe, panels.version);
  const cur = panels.all().find((p) => p.id === panel);

  useEffect(() => scope.show(id), [id]);
  useEffect(() => {
    actions.openSession(id).then(() => scope.loaded(id), (e) => {
      if ((e as { status?: number }).status === 404) setMissing(true);
      else reportError(e, { at: "open panel window" });
    });
  }, [id]);
  // What the panel's own code reads as the open panel.
  useEffect(() => setUI({ panel }), [panel]);
  useEffect(() => { if (session?.title && cur) setBaseTitle(`${session.title} - ${cur.label} - Keel`); }, [session?.title, cur?.label]);

  // The window's lock, held until the page ends or the pane asks it to dock back.
  const release = useRef<() => void>(() => {});
  useEffect(() => {
    if (!navigator.locks?.request) return;
    void navigator.locks.request(lockName(id, panel), () => new Promise<void>((done) => { release.current = done; }));
    if (typeof BroadcastChannel === "undefined") return;
    const c = new BroadcastChannel(DOCK_CHANNEL);
    c.onmessage = (e) => {
      if ((e.data as { dock?: string } | null)?.dock !== lockName(id, panel)) return;
      release.current();
      setDocked(true);
      // The app closes the window it popped out; a tab the page opened closes itself. Any other
      // window stays, and says so.
      if (shell) shell.post({ t: "dock" });
      else window.close();
    };
    return () => c.close();
  }, [id, panel]);

  const dock = () => { release.current(); setDocked(true); if (shell) shell.post({ t: "dock" }); else window.close(); };
  const Body = cur?.component;
  const unavailable = !!session && (!cur || (cur.when && !cur.when(session)));
  return (
    <Boundary>
      <main data-testid="panel-window" data-panel={panel} className="k-surface h-dvh w-full">
        <div className="k-surface-head">
          <span className="k-surface-icon">{cur?.icon}</span>
          <h2 className="k-surface-title">{cur?.label ?? "Panel"}</h2>
          <span className="k-surface-note" data-testid="panel-window-session">{session?.title ?? ""}</span>
          <span className="k-surface-end">
            <button type="button" data-testid="panel-dock-here" onClick={dock} className="k-btn">Dock back</button>
          </span>
        </div>
        <div className="min-h-0 flex-1">
          {docked ? <p className="k-empty p-4" data-testid="panel-window-docked">Docked back. You can close this window.</p>
            : (missing || gone) && !session ? <p className="k-empty p-4" data-testid="panel-window-missing">This session is not on this daemon.</p>
            : !session ? <p className="k-empty p-4">Opening the panel</p>
            : unavailable || !Body ? <p className="k-empty p-4" data-testid="panel-window-none">This session has no {cur?.label ?? panel} panel.</p>
            : <Suspense fallback={null}><Body session={session} /></Suspense>}
        </div>
      </main>
    </Boundary>
  );
}

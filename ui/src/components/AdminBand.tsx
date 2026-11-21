// A band across the top of the page for the daemon's own state: a restart
// that is waiting for running turns, a daemon the page cannot reach, and a
// new build of the page after the daemon came back (the page asks before
// reloading, so nothing typed is lost).
import { RotateCw, Unplug } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { shell } from "../lib/shell.ts";
import { api, downSince, onFeature, readAtOpen, useStore } from "../lib/store.ts";
import { clock } from "../lib/utils.ts";

// A drop this short is a blip (the socket opened again at once): nothing is said.
const AWAY_AFTER_MS = 1_000;

export function AdminBand() {
  const [draining, setDraining] = useState<{ restart: boolean } | null>(null);
  const [updated, setUpdated] = useState(false);
  const build = useRef<string | null>(null);
  const connected = useStore((s) => s.connected);
  useEffect(() => {
    const check = () => api<{ build_id: string; draining: any }>("/api/bootstrap").then((b) => {
      if (build.current && build.current !== b.build_id) setUpdated(true);
      build.current ??= b.build_id;
      setDraining(b.draining);
    });
    return onFeature({ frame: (f) => { if (f.name === "daemon") setDraining(f.data.draining); }, reconnect: readAtOpen(check, "daemon status") });
  }, []);
  // A request the daemon turned away while draining (reportError says so): shown for a moment.
  const [refused, setRefused] = useState(false);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const on = () => { setRefused(true); clearTimeout(t); t = setTimeout(() => setRefused(false), 4000); };
    addEventListener("keel:turned-away", on);
    return () => { removeEventListener("keel:turned-away", on); clearTimeout(t); };
  }, []);
  // Unreachable: said once the drop outlasts a blip, with the time it began.
  // The page's clocks of running work stop meanwhile (store.liveNow).
  const [away, setAway] = useState<number | null>(null);
  useEffect(() => {
    if (connected) return setAway(null);
    const since = downSince();
    if (since === null) return; // the page's first socket has not opened yet: it is loading
    const t = setTimeout(() => setAway(since), Math.max(0, since + AWAY_AFTER_MS - Date.now()));
    return () => clearTimeout(t);
  }, [connected]);
  // In the desktop shell the title bar says the daemon is away, with the button that starts it: one place, not two.
  if (away !== null && !updated && !shell?.can.titlebar) {
    return (
      <div role="status" data-testid="daemon-away" className="flex h-9 shrink-0 items-center justify-center gap-3 border-b border-warn/40 bg-brass-soft px-4 text-ui animate-in">
        <Unplug className="size-3.5 shrink-0 text-warn" />
        <span className="shrink-0 truncate font-medium max-md:shrink">Keel is not reachable since {clock(away)}. Reconnecting.</span>
        <span className="min-w-0 truncate text-caption text-muted max-md:hidden" data-testid="daemon-away-note">What it was doing is not known until it is back. Messages you send wait and go out then.</span>
      </div>
    );
  }
  const text = updated ? "Keel was updated." : draining && connected ? (draining.restart ? "Keel restarts when the running turns finish." : "Keel is stopping when the running turns finish.") : null;
  if (!text) return null;
  // A row of the page's own, above everything: it never sits on a message box or a card.
  return (
    <div role="status" data-testid="admin-band" className="flex h-9 shrink-0 items-center justify-center gap-3 border-b border-line bg-raised px-4 text-ui animate-in">
      <RotateCw className="size-3.5 shrink-0 text-brass" />
      <span className="truncate">{text}</span>
      {updated ? (
        <button type="button" onClick={() => location.reload()} className="h-7 shrink-0 rounded-md bg-accent px-3 text-caption font-medium text-accent-fg hover:bg-accent-hover">Reload the page</button>
      ) : <span data-testid="admin-band-note" className={refused ? "shrink-0 text-caption font-medium text-warn" : "shrink-0 text-caption text-faint"}>{refused ? "Not taken: new work waits." : "New work waits."}</span>}
    </div>
  );
}

// A band across the top of the page for the daemon's own state: a restart
// that is waiting for running turns, a daemon the page cannot reach, and a
// new build of the page after the daemon came back (the page asks before
// reloading, so nothing typed is lost).
import { RotateCw, Unplug } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { shell } from "../lib/shell.ts";
import { api, downSince, onFeature, readAtOpen, useStore } from "../lib/store.ts";
import { useUI } from "../lib/ui.ts";
import { clock } from "../lib/utils.ts";

// A drop this short is a blip (the socket opened again at once): nothing is said.
const AWAY_AFTER_MS = 1_000;

export function AdminBand() {
  const [draining, setDraining] = useState<{ restart: boolean } | null>(null);
  const [updated, setUpdated] = useState(false);
  const build = useRef<string | null>(null);
  const connected = useStore((s) => s.connected);
  const shellAway = useUI((s) => s.shellAway);
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
  // A tab that hangs from the top edge, over the page: it takes no room of its
  // own, so nothing that is being read moves when it comes or goes (a row of
  // the page's own pushed the list and the reading line down each time). What
  // it adds to its first words is its tip, and is read out with it.
  // In the desktop app the title bar says the daemon is away, with the button that starts it: one
  // place, not two. Only while it does say so: a loss the app does not see (the page's own
  // connection cut while the daemon answers) is said here as in a tab.
  if (away !== null && !updated && !(shell?.can.titlebar && shellAway)) {
    const note = "What it was doing is not known until it is back. Messages you send wait and go out then.";
    return (
      <div role="status" data-testid="daemon-away" title={note}
        className="fixed top-0 left-1/2 z-50 flex h-7 max-w-[calc(100vw-1rem)] -translate-x-1/2 items-center gap-2 rounded-b-md border border-t-0 border-warn/40 bg-brass-soft px-3 text-caption shadow-md animate-in max-md:h-[1.125rem] max-md:gap-1.5 max-md:px-2 max-md:text-micro max-md:leading-none">
        <Unplug className="size-3.5 shrink-0 text-warn max-md:size-3" />
        <span className="inline-block whitespace-nowrap font-medium max-md:first-letter:uppercase"><span className="max-md:sr-only">Keel is </span>not reachable since {clock(away)}<span className="max-md:sr-only">. Reconnecting.</span></span>
        <span className="sr-only" data-testid="daemon-away-note">{note}</span>
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

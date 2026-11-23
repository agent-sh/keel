// A band across the top of the page for the daemon's own state: a restart
// that is waiting for running turns, a daemon the page cannot reach, and a
// new build of the page after the daemon came back (the page asks before
// reloading, so nothing typed is lost).
import { HardDrive, RotateCw, Unplug } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { shell } from "../lib/shell.ts";
import { api, downSince, onFeature, readAtOpen, useStore } from "../lib/store.ts";
import { setUI, useUI } from "../lib/ui.ts";
import { clock } from "../lib/utils.ts";

// A drop this short is a blip (the socket opened again at once): nothing is said.
const AWAY_AFTER_MS = 1_000;

export function AdminBand() {
  const [draining, setDraining] = useState<{ restart: boolean } | null>(null);
  // The store's disk does not answer: since when, and whether nothing new is saved by now.
  const [disk, setDisk] = useState<{ full?: { since_ms: number; free_mb?: number }; silent_since_ms?: number; refusing?: boolean; slow?: { since_ms: number; sync_ms: number; held_ms: number; refusing?: boolean; building?: string } } | null>(null);
  const [updated, setUpdated] = useState(false);
  const build = useRef<string | null>(null);
  const connected = useStore((s) => s.connected);
  const shellAway = useUI((s) => s.shellAway);
  const shellNote = useUI((s) => s.shellNote);
  useEffect(() => {
    const check = () => api<{ build_id: string; draining: any; store?: { full?: { since_ms: number; free_mb?: number }; silent_since_ms?: number; refusing?: boolean; slow?: { since_ms: number; sync_ms: number; held_ms: number; refusing?: boolean; building?: string } } | null }>("/api/bootstrap").then((b) => {
      if (build.current && build.current !== b.build_id) setUpdated(true);
      build.current ??= b.build_id;
      setDraining(b.draining);
      setDisk(b.store ?? null);
    });
    return onFeature({ frame: (f) => { if (f.name === "daemon") { setDraining(f.data.draining); setDisk(f.data.store ?? null); } else if (f.name === "store") setDisk(f.data ?? null); }, reconnect: readAtOpen(check, "daemon status") });
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
        className="fixed top-0 left-1/2 z-50 flex h-7 max-w-[calc(100vw-1rem)] -translate-x-1/2 items-center gap-2 rounded-b-md border border-t-0 border-warn/40 bg-brass-soft px-3 text-caption shadow-2 animate-in max-md:h-[1.125rem] max-md:gap-1.5 max-md:px-2 max-md:text-micro max-md:leading-none">
        <Unplug className="size-3.5 shrink-0 text-warn max-md:size-3" />
        <span className="inline-block whitespace-nowrap font-medium max-md:first-letter:uppercase"><span className="max-md:sr-only">Keel is </span>not reachable since {clock(away)}<span className="max-md:sr-only">. Reconnecting.</span></span>
        <span className="sr-only" data-testid="daemon-away-note">{note}</span>
      </div>
    );
  }
  // The disk is full: nothing is saved until there is room.
  if (disk?.full && !updated) {
    const free = disk.full.free_mb === undefined ? "" : `${disk.full.free_mb} MB free. `;
    return (
      <div role="alert" data-testid="store-full" className="flex min-h-9 shrink-0 items-center justify-center gap-3 border-b border-danger/40 bg-danger-soft px-4 py-1 text-ui animate-in">
        <HardDrive className="size-3.5 shrink-0 text-danger" />
        <span className="shrink-0 truncate font-medium max-md:hidden">Keel's disk is full since {clock(disk.full.since_ms)}: nothing new is saved.</span>
        <span className="min-w-0 truncate text-caption text-muted max-md:hidden" data-testid="store-full-note">{free}Free some space: what you send waits and goes out by itself. You can still read sessions, stop a turn, answer a card and restart Keel.</span>
        <span className="min-w-0 leading-snug md:hidden" data-testid="store-full-narrow">
          <span className="font-medium">Disk full: nothing is saved.</span> <span className="text-muted">Free some space. Stop, answer and restart still work.</span>
        </span>
      </div>
    );
  }
  // The disk is slow: saving waits seconds on it. Said while it is so; nothing is refused.
  // A build of the store's own, once after an upgrade: nothing is saved for its seconds.
  if (disk?.slow?.building && disk.silent_since_ms === undefined && !updated) {
    return (
      <div role="status" data-testid="store-building" className="flex min-h-9 shrink-0 items-center justify-center gap-3 border-b border-warn/40 bg-brass-soft px-4 py-1 text-ui animate-in">
        <HardDrive className="size-3.5 shrink-0 text-warn" />
        <span className="shrink-0 truncate font-medium max-md:hidden">Keel is {disk.slow.building}, once: nothing is saved for some seconds.</span>
        <span className="min-w-0 truncate text-caption text-muted max-md:hidden" data-testid="store-building-note">What you send waits and goes out by itself; running turns wait.</span>
        <span className="min-w-0 leading-snug md:hidden" data-testid="store-building-narrow">
          <span className="font-medium">Keel is working on its store, once.</span> <span className="text-muted">What you send waits and goes out by itself.</span>
        </span>
      </div>
    );
  }
  if (disk?.slow && disk.silent_since_ms === undefined && !updated) {
    const s = (disk.slow.sync_ms / 1000).toFixed(1);
    return (
      <div role="status" data-testid="store-slow" className="flex min-h-9 shrink-0 items-center justify-center gap-3 border-b border-warn/40 bg-brass-soft px-4 py-1 text-ui animate-in">
        <HardDrive className="size-3.5 shrink-0 text-warn" />
        <span className="shrink-0 truncate font-medium max-md:hidden">{disk.slow.refusing ? `Keel's disk is slow since ${clock(disk.slow.since_ms)}: nothing is saved for some seconds.` : `Keel's disk is slow since ${clock(disk.slow.since_ms)}: saving waits on it.`}</span>
        <span className="min-w-0 truncate text-caption text-muted max-md:hidden" data-testid="store-slow-note">{disk.slow.refusing ? `A sync of its store takes ${s} s. What you send waits and goes out by itself; running turns wait. See Errors.` : `A sync of its store takes ${s} s. Work goes on; answers come seconds late at times. See Errors.`}</span>
        <span className="min-w-0 leading-snug md:hidden" data-testid="store-slow-narrow">
          <span className="font-medium">{disk.slow.refusing ? "Disk slow: nothing saved for some seconds." : "Disk slow: saving waits."}</span> <span className="text-muted">{disk.slow.refusing ? "What you send waits and goes out by itself." : "Work goes on, seconds late at times."}</span>
        </span>
      </div>
    );
  }
  // The store's disk does not answer: said plainly, with what still works. It stays above a restart's
  // own words: the restart is one of the things that still work.
  if (disk?.silent_since_ms !== undefined && !updated) {
    return (
      <div role="alert" data-testid="store-silent" className="flex min-h-9 shrink-0 items-center justify-center gap-3 border-b border-danger/40 bg-danger-soft px-4 py-1 text-ui animate-in">
        <HardDrive className="size-3.5 shrink-0 text-danger" />
        <span className="shrink-0 truncate font-medium max-md:hidden">
          {disk.refusing ? `Keel's disk does not answer since ${clock(disk.silent_since_ms!)}: nothing new is saved.` : `Keel's disk does not answer since ${clock(disk.silent_since_ms!)}.`}
        </span>
        {/* A narrow screen: both halves in fewer words, on two lines when one does not hold them. */}
        <span className="min-w-0 leading-snug md:hidden" data-testid="store-silent-narrow">
          <span className="font-medium">{disk.refusing ? "Disk not answering: nothing is saved." : `Disk not answering since ${clock(disk.silent_since_ms!)}.`}</span>{" "}
          <span className="text-muted">{disk.refusing ? "Stop, answer and restart still work." : "Work goes on, unsaved for now."}</span>
        </span>
        <span className="min-w-0 truncate text-caption text-muted max-md:hidden" data-testid="store-silent-note">
          {disk.refusing
            ? `You can still read sessions, stop a turn, answer a card and restart Keel${draining?.restart ? " (it is restarting)" : ""}. New prompts and settings are turned away.`
            : "Work goes on for now; what it writes may not be on the disk. See Errors."}
        </span>
      </div>
    );
  }
  // A line of the desktop app's about this window, until the owner has read it.
  if (shellNote && !updated) {
    return (
      <div role="status" data-testid="shell-note" className="flex h-9 shrink-0 items-center justify-center gap-3 border-b border-line bg-raised px-4 text-ui animate-in">
        <RotateCw className="size-3.5 shrink-0 text-brass" />
        <span className="truncate">{shellNote}</span>
        <button type="button" onClick={() => setUI({ shellNote: null })} className="h-7 shrink-0 rounded-md border border-line px-3 text-caption text-fg hover:bg-hover">OK</button>
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

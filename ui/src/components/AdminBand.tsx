// A band across the top of the page for the daemon's own state: a restart
// that is waiting for running turns, and a new build of the page after the
// daemon came back (the page asks before reloading, so nothing typed is lost).
import { RotateCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, onFeature, reportError, useStore } from "../lib/store.ts";

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
    }).catch((e) => reportError(e, { at: "daemon status" }));
    check();
    return onFeature({ frame: (f) => { if (f.name === "daemon") setDraining(f.data.draining); }, reconnect: check });
  }, []);
  // A request the daemon turned away while draining (reportError says so): shown for a moment.
  const [refused, setRefused] = useState(false);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const on = () => { setRefused(true); clearTimeout(t); t = setTimeout(() => setRefused(false), 4000); };
    addEventListener("keel:turned-away", on);
    return () => { removeEventListener("keel:turned-away", on); clearTimeout(t); };
  }, []);
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

// A small band at the bottom of the page for the daemon's own state: a restart
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
  const text = updated ? "Keel was updated." : draining && connected ? (draining.restart ? "Keel restarts when the running turns finish." : "Keel is stopping when the running turns finish.") : null;
  if (!text) return null;
  return (
    <div role="status" data-testid="admin-band" className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-full border border-line bg-raised py-1.5 pl-4 pr-1.5 text-ui shadow-2">
      <RotateCw className="size-3.5 text-brass" />
      <span>{text}</span>
      {updated ? (
        <button type="button" onClick={() => location.reload()} className="h-7 rounded-full bg-accent px-3 text-caption font-medium text-accent-fg hover:bg-accent-hover">Reload the page</button>
      ) : <span className="pr-2.5 text-caption text-faint">New work waits.</span>}
    </div>
  );
}

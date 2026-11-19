import { FileLock2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { onFeature } from "../lib/store.ts";
import { savePref } from "../lib/ui.ts";

// Above the composer: a repository file held until the owner trusts it, or
// protected files a call created and Keel moved to quarantine.
export function TrustCards({ sessionId }: { sessionId: string }) {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => onFeature({
    frame: (f) => {
      if (f.session_id !== sessionId) return;
      if (f.name === "trust" && f.data?.held) setMsg(`${f.data.held} file${f.data.held === 1 ? "" : "s"} of this repository ${f.data.held === 1 ? "is" : "are"} held until you trust ${f.data.held === 1 ? "it" : "them"}.`);
      if (f.name === "quarantine" && f.data?.state === "held") setMsg(`Moved to quarantine: ${f.data.paths.join(", ")}.`);
    },
  }), [sessionId]);
  if (!msg) return null;
  return (
    <div className="animate-in mb-2 flex items-center gap-2.5 rounded-2xl border border-warn/40 bg-raised px-4 py-2.5 shadow-2" data-testid="trust-card">
      <span className="grid size-6 shrink-0 place-items-center rounded-md bg-warn/15 text-warn"><FileLock2 className="size-3.5" /></span>
      <span className="min-w-0 flex-1 text-ui">{msg}</span>
      <button data-testid="trust-card-open" onClick={() => { savePref("panel", "trust"); setMsg(null); }} className="h-8 shrink-0 rounded-lg border border-line px-3 text-ui hover:bg-hover">Open Trust panel</button>
      <button onClick={() => setMsg(null)} className="grid size-7 shrink-0 place-items-center rounded-lg text-faint hover:bg-hover hover:text-fg" title="Dismiss"><X className="size-4" /></button>
    </div>
  );
}

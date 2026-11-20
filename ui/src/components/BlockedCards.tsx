import { RotateCcw, ShieldX, X } from "lucide-react";
import { useState } from "react";
import { allowRetry, refusedBy, useBlocked } from "../lib/blocked.ts";

// Calls the judge refused in this session (full auto or reviewer mode), above
// the composer: what and why, and one retry the owner can let through. Nothing
// waits on them; the session went on.
export function BlockedCards({ sessionId }: { sessionId: string }) {
  const list = useBlocked(sessionId);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [since] = useState(() => Date.now() - 10 * 60_000);
  const shown = list.filter((b) => !b.retry && !hidden.has(b.id) && (b.last ?? b.created) >= since).slice(0, 3);
  if (!shown.length) return null;
  return (
    <div className="mb-2 flex flex-col gap-2">
      {shown.map((b) => (
        <div key={b.id} className="animate-in overflow-hidden rounded-2xl border border-line bg-raised shadow-2" data-testid="blocked" data-by={b.by ?? "reviewer"}>
          <div className="flex items-center gap-2.5 px-4 pt-3">
            <span className="grid size-6 place-items-center rounded-md bg-danger-soft text-danger"><ShieldX className="size-3.5" /></span>
            <span className="text-ui font-medium">{refusedBy(b)}</span>
            <span className="font-mono text-caption text-faint">{b.tool}{b.risk !== "unknown" ? ` · risk ${b.risk}` : ""}{(b.count ?? 1) > 1 ? ` · ${b.count} times` : ""}</span>
            <button onClick={() => setHidden((s) => new Set(s).add(b.id))} className="ml-auto grid size-7 place-items-center rounded-lg text-faint hover:bg-hover hover:text-fg" title="Dismiss"><X className="size-4" /></button>
          </div>
          <pre className="mx-4 mt-2 max-h-32 overflow-auto rounded-lg bg-code px-3 py-2 font-mono text-caption whitespace-pre-wrap break-all">{b.summary}</pre>
          <div className="flex items-center gap-2 px-4 py-3">
            <p className="min-w-0 flex-1 text-caption text-muted" data-testid="blocked-reason">{b.reason}</p>
            <button
              data-testid="blocked-retry"
              onClick={() => allowRetry(sessionId, b.id)}
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-line px-3 text-ui hover:bg-hover"
            >
              <RotateCcw className="size-3.5" /> Allow one retry
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

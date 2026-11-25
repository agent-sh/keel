import { RotateCcw, ShieldX, X } from "lucide-react";
import { useRef, useState } from "react";
import { allowRetry, refusedBy, useBlocked } from "../lib/blocked.ts";
import { useNudge, usePress, useStood } from "../lib/press-hooks.tsx";
import { Spelled } from "./Spelled.tsx";

// The one retry the owner can let through. It lets a call run, so it is held like an answer on a
// request: it does nothing as it appears or within a moment of moving, and a press it refuses is
// answered (the ring, and the reason in words at the control).
function Retry({ onAllow }: { onAllow: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const stood = useStood(ref);
  const pressed = usePress(stood.now, (ok) => ok);
  const nudge = useNudge();
  return (
    <>
      <button
        ref={ref}
        data-testid="blocked-retry"
        aria-disabled={!stood.ready || undefined}
        data-nudge={nudge.mark}
        onPointerDown={pressed.onPointerDown}
        onMouseDown={pressed.onMouseDown}
        onClick={(e) => { if (pressed.said(e)) onAllow(); else nudge.refuse("Not yet: it appeared a moment ago", e.currentTarget); }}
        className="k-btn k-btn-lg k-grant shrink-0 aria-disabled:cursor-default aria-disabled:opacity-50 aria-disabled:hover:bg-transparent"
      >
        <RotateCcw className="size-3.5" /> Allow one retry
      </button>
      {nudge.line}
    </>
  );
}

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
          {/* What was refused, as it is written: a character that hides or reorders text is spelled out. */}
          <pre dir="ltr" className="mx-4 mt-2 max-h-32 overflow-auto rounded-lg bg-code px-3 py-2 font-mono text-caption whitespace-pre-wrap break-all"><Spelled text={b.summary} /></pre>
          <div className="flex items-center gap-2 px-4 py-3">
            <p className="min-w-0 flex-1 text-caption text-muted" data-testid="blocked-reason">{b.reason}</p>
            <Retry onAllow={() => allowRetry(sessionId, b.id)} />
          </div>
        </div>
      ))}
    </div>
  );
}

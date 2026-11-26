// "While you were away", at the top of the Inbox: one line that opens. What
// happened while the owner was not at a page of the daemon: a row a session
// with its state now, the turns that ended, what failed and by which class,
// what waits for the owner (approvals and questions), the agents parked, the
// spend; above them, what the daemon itself went through (it went down and
// came back, the turns that cut, its stalls). Closed, it is the
// time away and the totals; the alerts below are not said twice. Opened, it
// has been seen: the daemon lets it go, and the next absence starts a new one
// (it stays on screen until the Inbox closes). The words are the daemon's
// (src/admin/away.ts), the same as its text form.
import { ChevronRight, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { digestBrief, digestTotals, type Digest, type DigestRow } from "../../../../src/admin/away.ts";
import { dur } from "../../../../src/admin/timeline-rows.ts";
import { openSession } from "../../lib/automation.ts";
import { api, reportError } from "../../lib/store.ts";
import { clock, cn } from "../../lib/utils.ts";
import { WATCH_LABEL } from "../../lib/watch.ts";
import { Mark } from "../Mark.tsx";

const day = (ts: number) => new Date(ts).toDateString();
// "22:10 to 07:45", with the date where the two are on different days; several absences say how many.
function range(d: Digest) {
  const far = day(d.from) !== day(d.to);
  const span = `${clock(d.from, { date: far })} to ${clock(d.to, { date: far })}`;
  return d.spans.length > 1 ? `${d.spans.length} times, ${span}` : span;
}

// The row's facts, with the part that went wrong in the failure color.
function Facts({ r }: { r: DigestRow }) {
  const at = r.bad ? r.text.indexOf(r.bad) : -1;
  if (at < 0) return <>{r.text}</>;
  return <>{r.text.slice(0, at)}<span className="text-danger">{r.bad}</span>{r.text.slice(at + r.bad!.length)}</>;
}

export function AwayDigest({ onClose }: { onClose: () => void }) {
  const [d, setD] = useState<Digest | null>(null);
  const [open, setOpen] = useState(false);
  const seen = useRef(false);
  useEffect(() => {
    let live = true;
    let again: ReturnType<typeof setTimeout> | undefined;
    const load = (retry: boolean) =>
      api<{ away: Digest | null }>("/api/away").then((r) => {
        if (!live) return;
        setD(r.away);
        // An Inbox opened in the first moment after the page loaded is ahead of the page's own report of the owner: asked once more.
        if (retry && !r.away?.present) again = setTimeout(() => void load(false), 1500);
      }).catch(reportError);
    void load(true);
    return () => { live = false; clearTimeout(again); };
  }, []);
  // Shown once the owner is back: while they are away the daemon keeps the window open.
  if (!d || !d.present) return null;
  const forget = () => {
    if (seen.current) return;
    seen.current = true;
    api("/api/away", { method: "DELETE" }).catch(reportError);
  };
  const dismiss = () => { setD(null); forget(); };
  return (
    <section data-testid="away-digest" aria-label="While you were away" className="mx-2 mt-2 shrink-0 rounded-lg border border-line bg-sunken">
      <div className="flex items-center gap-1 pr-1">
        <button
          type="button"
          data-testid="away-toggle"
          aria-expanded={open}
          onClick={() => { if (!open) forget(); setOpen(!open); }}
          className="flex h-ctl-lg min-w-0 flex-1 items-center gap-2 rounded-lg pl-2 pr-1 text-left outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronRight className={cn("size-3.5 shrink-0 text-faint transition-transform", open && "rotate-90")} aria-hidden />
          <span className="shrink-0 text-caption text-fg" data-testid="away-lead">While you were away</span>
          <span className="min-w-0 flex-1 truncate text-caption text-muted tabular-nums" data-testid="away-line">
            {dur(d.away_ms)}{open ? `, ${range(d)}` : `: ${digestBrief(d)}`}
          </span>
        </button>
        <button
          type="button"
          data-testid="away-dismiss"
          aria-label="Dismiss the digest"
          title="Dismiss"
          onClick={dismiss}
          className="grid size-ctl-sm shrink-0 place-items-center rounded-md text-faint outline-none hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="size-3.5" />
        </button>
      </div>
      {open && (
        <div className="border-t border-line pt-1.5">
          {d.daemon.length > 0 && (
            <ul className="k-quote mx-3 mb-1.5 flex flex-col gap-1" data-tone="warn" data-testid="away-daemon" aria-label="What the daemon went through">
              {d.daemon.map((line, i) => <li key={i} className="text-caption leading-snug text-fg">{line}</li>)}
            </ul>
          )}
          <p className="px-3 pb-1 text-caption text-muted" data-testid="away-totals">{digestTotals(d)}</p>
          <ul className="flex max-h-[24rem] flex-col gap-px overflow-y-auto px-1 pb-1" data-testid="away-rows">
            {d.sessions.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  data-testid="away-row"
                  data-session={r.id}
                  data-watch={r.watch}
                  onClick={() => { openSession(r.id); onClose(); }}
                  className="flex w-full items-start gap-2.5 rounded-md px-2 py-1.5 text-left outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Mark w={r.watch} className="mt-[0.3125rem]" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <span className="min-w-0 flex-1 truncate text-ui text-fg">{r.title || "Untitled"}</span>
                      <span className="shrink-0 text-micro text-faint">{WATCH_LABEL[r.watch]}</span>
                    </span>
                    <span className="block text-caption leading-snug text-muted" data-testid="away-facts"><Facts r={r} /></span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {d.quiet > 0 && <p className="px-3 pb-2 text-micro text-faint" data-testid="away-quiet">{d.quiet} other session{d.quiet === 1 ? "" : "s"}: nothing happened.</p>}
        </div>
      )}
    </section>
  );
}

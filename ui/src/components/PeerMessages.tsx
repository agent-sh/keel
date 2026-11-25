// The messages a session sent to other sessions and received from them, as a
// small list in its timeline: who, when, the first words, and the one state
// the daemon keeps for each (queued, delivered, handled, dropped, held for
// the owner, waiting for its daemon) with when it reached it and why. Closed
// it is one line; nothing is shown for a session with none.
import { ArrowDownLeft, ArrowUpRight, ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { PEER_STATE_WORDS, type PeerMessageRow, type PeerState } from "../../../src/fleet/message-state.ts";
import { openSession } from "../lib/automation.ts";
import { api, onFeature, reportError, useStore } from "../lib/store.ts";
import { clock, cn, when } from "../lib/utils.ts";

// The color of a state: what still waits is quiet, what went wrong is the failure color, what is done is plain.
const TONE: Record<PeerState, string> = {
  queued: "text-st-wait", outbound: "text-st-wait", held: "text-st-need", delivered: "text-fg", handled: "text-ok", dropped: "text-st-fail",
};

export function PeerMessages({ sessionId }: { sessionId: string }) {
  const [rows, setRows] = useState<PeerMessageRow[] | null>(null);
  const [open, setOpen] = useState(false);
  const sessions = useStore((s) => s.sessions);
  useEffect(() => {
    let live = true;
    const load = () => api<{ messages: PeerMessageRow[] }>(`/api/sessions/${encodeURIComponent(sessionId)}/peer-messages`).then((r) => { if (live) setRows(r.messages); }).catch(reportError);
    setRows(null);
    void load();
    // A message's state moved, here or in the session it was sent to: read again.
    const off = onFeature({ frame: (f) => { if (f.name === "fleet_message") void load(); }, reconnect: () => void load() });
    return () => { live = false; off(); };
  }, [sessionId]);
  if (!rows?.length) return null;
  const sent = rows.filter((r) => r.direction === "sent").length;
  const waiting = rows.filter((r) => r.state === "queued" || r.state === "held" || r.state === "outbound").length;
  const dropped = rows.filter((r) => r.state === "dropped").length;
  const summary = [
    sent ? `${sent} sent` : "", rows.length - sent ? `${rows.length - sent} received` : "",
    waiting ? `${waiting} not read yet` : "", dropped ? `${dropped} dropped` : "",
  ].filter(Boolean).join(", ");
  return (
    <section className="shrink-0 border-b border-line" data-testid="peer-messages" aria-label="Messages between sessions">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} data-testid="peer-messages-toggle"
        className="flex h-8 w-full items-center gap-2 px-3 text-left text-caption outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronRight className={cn("size-3.5 shrink-0 text-faint transition-transform", open && "rotate-90")} aria-hidden />
        <span className="font-medium text-fg">Messages between sessions</span>
        <span className={cn("min-w-0 truncate tabular-nums", dropped ? "text-st-fail" : "text-muted")} data-testid="peer-messages-summary">{summary}</span>
      </button>
      {open && (
        <ul className="flex max-h-64 flex-col overflow-y-auto px-2 pb-2" data-testid="peer-messages-list">
          {rows.map((r) => {
            const other = sessions[r.other.session_id];
            const name = other?.title || r.other.title || `session ${r.other.session_id.slice(-6)}`;
            const Arrow = r.direction === "sent" ? ArrowUpRight : ArrowDownLeft;
            return (
              <li key={r.id} data-testid="peer-message" data-state={r.state} data-direction={r.direction} className="grid grid-cols-[4.5rem_1rem_minmax(0,1fr)] items-baseline gap-x-2 rounded-md px-1 py-1 text-caption">
                <time dateTime={new Date(r.created_ms).toISOString()} title={when(r.created_ms)} className="text-right text-micro tabular-nums text-muted">{clock(r.created_ms, { seconds: true })}</time>
                <Arrow className="mt-0.5 size-3.5 self-start text-faint" aria-hidden />
                <span className="min-w-0">
                  <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                    <span className="text-muted">{r.direction === "sent" ? "To" : "From"}</span>
                    {other
                      ? <button type="button" className="min-w-0 truncate rounded-sm text-fg underline decoration-line-strong underline-offset-2 outline-none hover:decoration-fg focus-visible:ring-2 focus-visible:ring-ring" onClick={() => openSession(other.id)}>{name}</button>
                      : <span className="min-w-0 truncate text-fg">{name}{r.other.machine ? ` on ${r.other.machine}` : ""}</span>}
                    <span className={cn("shrink-0 font-medium", TONE[r.state] ?? "text-fg")} data-testid="peer-message-state" title={r.state_ms ? `${PEER_STATE_WORDS[r.state] ?? r.state} ${when(r.state_ms)}` : undefined}>
                      {PEER_STATE_WORDS[r.state] ?? r.state}{r.state_ms && r.state !== "queued" ? ` ${clock(r.state_ms, { seconds: true })}` : ""}
                    </span>
                  </span>
                  {r.reason && <span className="block text-micro text-muted" data-testid="peer-message-reason">{r.reason}</span>}
                  <span dir="auto" className="block truncate text-muted">{r.text.replace(/\s+/g, " ")}{r.cut ? "…" : ""}</span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

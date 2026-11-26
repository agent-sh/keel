// The owner's switch for compaction by price on his own session (src/engine/owner-compact.ts), opened from the
// session's menu: what it does, the switch, and the session's own numbers before it was turned on and since
// (GET /api/sessions/:id/price-compaction), so he keeps it or turns it off by what it did.
import { Dialog } from "@base-ui/react/dialog";
import { useEffect, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import type { Numbers, OwnerCompactNumbers } from "../../../src/admin/owner-compact-read.ts";
import { actions, api, reportError, useStore } from "../lib/store.ts";
import { fmtCost, fmtTokens } from "../lib/utils.ts";
import { Toggle } from "./surfaces/kit.tsx";

let current: string | null = null;
const subs = new Set<() => void>();
const set = (id: string | null) => { current = id; subs.forEach((f) => f()); };

let mounted = false;
export function openPriceCompaction(sessionId: string) {
  if (!mounted) {
    mounted = true;
    const el = document.createElement("div");
    document.body.append(el);
    createRoot(el).render(<Host />);
  }
  set(sessionId);
}

type Answer = OwnerCompactNumbers & { on: boolean; on_ms?: number; off_ms?: number };

const seconds = (ms: number | null) => (ms === null ? "–" : `${(ms / 1000).toFixed(1)} s`);
const tokens = (n: number | null) => (n === null ? "–" : fmtTokens(n));
const hours = (h: number) => (h < 1 ? `${Math.round(h * 60)} min` : `${Math.round(h * 10) / 10} h`);
const ROWS: [string, (n: Numbers) => string][] = [
  ["Context, median", (n) => tokens(n.context_p50)],
  ["Context, 90th percentile", (n) => tokens(n.context_p90)],
  ["First token, median", (n) => seconds(n.first_token_p50_ms)],
  ["Dollars an hour", (n) => (n.usd_per_hour === null ? "–" : fmtCost(n.usd_per_hour))],
  ["Dollars a step", (n) => (n.usd_per_step == null ? "–" : fmtCost(n.usd_per_step))],
  ["Compactions", (n) => String(n.compactions)],
  ["Steps", (n) => String(n.steps)],
];

function Host() {
  const id = useSyncExternalStore((f) => (subs.add(f), () => void subs.delete(f)), () => current);
  const session = useStore((s) => (id ? s.sessions[id] : undefined));
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const on = session?.settings.owner_compact_by_price === true;
  const load = () => {
    if (!id) return;
    api<Answer>(`/api/sessions/${id}/price-compaction`).then(setAnswer, (e) => setError((e as Error).message));
  };
  useEffect(() => { setAnswer(null); setError(null); load(); }, [id, on]);
  const flip = async (to: boolean) => {
    if (!id) return;
    setBusy(true);
    setError(null);
    try {
      await actions.patch(id, { settings: { owner_compact_by_price: to } });
    } catch (e) {
      setError((e as Error).message);
      reportError(e, { at: "price compaction switch" });
    } finally {
      setBusy(false);
    }
  };
  const since = answer?.since;
  const cols: [string, Numbers][] = answer ? [[since ? `Before, ${hours(answer.before.hours)}` : `Last ${hours(answer.before.hours)}`, answer.before], ...(since ? [[`${answer.off_ms ? "While on" : "Since on"}, ${hours(since.hours)}`, since] as [string, Numbers]] : [])] : [];
  return (
    <Dialog.Root open={!!id} onOpenChange={(o) => !o && set(null)}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-overlay transition-opacity data-starting-style:opacity-0 data-ending-style:opacity-0" />
        <Dialog.Popup data-testid="price-compaction-dialog" className="k-dialog rounded-xl border border-line bg-raised shadow-3">
          <Dialog.Title className="k-dialog-title px-[var(--k-dialog-pad)] pt-[var(--k-dialog-pad)] text-read font-semibold">Compact by price</Dialog.Title>
          <div className="k-dialog-body mt-1.5 px-[var(--k-dialog-pad)] pb-1">
            <Dialog.Description className="text-ui text-muted">
              The session is summarized when the steps ahead would read more of its context than a summary costs, long before the window's line. A summary is written when a turn ends and takes the history's place when the next turn starts, or at a step inside a turn whose cache has lapsed (that step writes the whole context anyway); never on a warm cache inside a turn. It goes in only when it quotes every statement word for word and keeps all of your messages whole; the system prompt is never summarized.
            </Dialog.Description>
            <p className="mt-2 text-ui text-muted" data-testid="price-compaction-range">
              It saves most in a session of short turns. On replays of session shapes, with one to five steps a turn, tokens read fell to 32 to 52% and dollars to 38 to 66%; with 25 steps a turn, tokens to 56 to 66% and dollars to 63 to 79%; with 40 steps a turn or more, little or nothing, and up to 4% more dollars. The dearer a cache write is against a read, the less it saves.
            </p>
            <label className="mt-4 flex items-center justify-between gap-3 text-ui">
              <span>Compact this session by price</span>
              <Toggle on={on} onChange={(v) => void flip(v)} label="Compact this session by price" testid="price-compaction-switch" />
            </label>
            {answer && (
              <table className="mt-4 w-full text-ui tabular-nums" data-testid="price-compaction-numbers">
                <thead>
                  <tr className="text-caption text-muted">
                    <th className="py-1 text-left font-normal">This session</th>
                    {cols.map(([head]) => <th key={head} className="py-1 text-right font-normal">{head}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {ROWS.map(([label, cell]) => (
                    <tr key={label} className="border-t border-line">
                      <td className="py-1.5 text-muted">{label}</td>
                      {cols.map(([head, n]) => <td key={head} className="py-1.5 text-right">{cell(n)}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="mt-2 text-caption text-faint">
              {since ? "Before is as long as the time since it was turned on, from an hour to a day. Its own requests only: summaries included, its agents not." : "Turn it on to compare: the numbers since then show beside these. Its own requests only: summaries included, its agents not."}
            </p>
            {error && <p className="mt-2 text-caption text-danger" role="alert">{error}</p>}
          </div>
          <div className="k-dialog-foot px-[var(--k-dialog-pad)] pb-[var(--k-dialog-pad)] pt-3">
            <Dialog.Close disabled={busy} className="k-btn k-btn-lg" data-testid="price-compaction-close">Close</Dialog.Close>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

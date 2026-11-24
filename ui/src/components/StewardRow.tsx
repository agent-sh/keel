import { Eye } from "lucide-react";
import { useState } from "react";
import { failed } from "../lib/store.ts";
import { setSteward, stewardWord, useSteward } from "../lib/steward.ts";
import { cn } from "../lib/utils.ts";

const TONE = { ok: "bg-ok/12 text-ok", work: "bg-accent/12 text-accent", warn: "bg-warn/12 text-warn", off: "bg-hover text-faint" } as const;

// PR Steward on the session's pull request, in the worktree chip's popup: turn the watch on or off,
// say whether it stays after the checks pass and which bots it reads, and see what it is doing
// (src/steward/watch.ts). Shown under the pull request while it is open, or while a watch has something to say.
export function StewardRow({ sessionId, open }: { sessionId: string; open: boolean }) {
  const view = useSteward(sessionId);
  const [stay, setStay] = useState(false);
  const [bots, setBots] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const w = view?.watch ?? null;
  if (!view || (!open && !w)) return null;
  const on = w && w.state !== "ended";
  const { word, tone } = stewardWord(w);
  const lim = view.limits;
  const toggle = async () => {
    setBusy(true);
    setErr(null);
    try {
      await setSteward(sessionId, !on, { stay, bots: bots.split(/[\s,]+/).filter(Boolean) });
    } catch (e) {
      setErr(failed(e, { at: "StewardRow" }));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-1.5 rounded-lg border border-line px-2.5 py-2" data-testid="steward" data-state={on ? w!.state : w ? `ended-${w.end}` : "off"}>
      <div className="flex items-center gap-2">
        <Eye className="size-4 shrink-0 text-accent" />
        <span className="text-ui font-medium">PR Steward</span>
        <span data-testid="steward-state" className={cn("inline-flex h-[1.125rem] items-center rounded-md px-1.5 text-micro font-medium", TONE[tone])}>{word}</span>
        <button
          type="button"
          disabled={busy}
          data-testid="steward-toggle"
          onClick={toggle}
          className="ml-auto inline-flex h-7 items-center rounded-lg px-2 text-caption hover:bg-hover disabled:opacity-50"
        >
          {on ? "Stop watching" : w ? "Watch again" : "Watch this pull request"}
        </button>
      </div>
      {w ? (
        <p className="mt-1 text-caption text-muted" data-testid="steward-note">{w.note}</p>
      ) : (
        <p className="mt-1 text-caption text-muted">Fixes failing checks, conflicts and comments from people you trust, in this worktree. It pushes to this branch only and never merges.</p>
      )}
      {w && (w.turns > 0 || w.ignored > 0) && (
        <p className="mt-0.5 text-micro text-faint" data-testid="steward-counts">
          {w.turns} turn{w.turns === 1 ? "" : "s"} · fixes {w.tries} of {lim.tries} · pushes {w.pushes} of {lim.pushes}
          {w.ignored > 0 && <> · {w.ignored} comment{w.ignored === 1 ? "" : "s"} from people without write access left unread</>}
        </p>
      )}
      {!on && (
        <div className="mt-2 flex flex-col gap-1.5">
          <label className="flex items-center gap-1.5 text-caption text-muted">
            <input type="checkbox" checked={stay} onChange={(e) => setStay(e.target.checked)} data-testid="steward-stay" className="accent-[var(--accent)]" /> Stay for comments after the checks pass
          </label>
          <input value={bots} onChange={(e) => setBots(e.target.value)} placeholder="Bots to read comments from, comma separated" aria-label="Bots to read comments from" data-testid="steward-bots" className="k-field" />
        </div>
      )}
      {err && <p className="mt-1 text-caption text-danger" data-testid="steward-error">{err}</p>}
    </div>
  );
}

// On the rail, while anything waits for this machine (src/automation/machine-waits.ts: trees the load hold holds,
// calls in the heavy-command line, each tree once): one quiet line with the quiet grey mark, how many trees wait
// and the load they wait on. Its tooltip names the oldest wait, what lets it go, and that nothing is the owner's to
// do for it (a question one of them asks stays in Inbox). It opens Settings > Health. Folded, a count.
import { useLoadHold } from "../lib/load-hold.ts";
import { navigate } from "../lib/ui.ts";
import { Mark, span, useNow } from "./Mark.tsx";

const MACHINE = { watch: "wait", why: "machine" } as const;

export function LoadLine({ open }: { open: boolean }) {
  const v = useLoadHold();
  const m = v?.machine;
  const now = useNow(!!m?.trees, 30_000);
  if (!v || !m?.trees) return null;
  const n = m.trees;
  // Short enough to be read whole beside the load on a rail of any width; the tooltip has the sentences.
  const what = `${n} ${n === 1 ? "tree waits" : "trees wait"}`;
  const label = `${what} for the machine`;
  const load = v.load1 === null ? "" : `load ${Math.round(v.load1)} on ${v.threads}`;
  const oldest = m.oldest ? `The oldest: ${m.oldest.title}, ${span(now - m.oldest.since)} for ${m.oldest.cause === "load" ? "the load" : "a heavy-command slot"}; it ${m.oldest.releases}.` : "";
  const asks = m.asking ? ` ${m.asking === 1 ? "One of them also asks" : `${m.asking} of them also ask`} you something: that is in Inbox.` : "";
  const tip = [`${label}${load ? ` (${load} threads)` : ""}.`, oldest, `Nothing for you to do for the machine; your own turns go on.${asks}`].filter(Boolean).join("\n");
  const go = () => navigate({ name: "settings", section: "health" });
  if (!open) {
    return (
      <button type="button" className="k-stuck-chip" data-testid="load-hold" aria-label={`${label}. Open Health`} title={tip} onClick={go}>
        <Mark w="wait" st={MACHINE} className="!size-2" /><span className="tabular-nums">{n}</span>
      </button>
    );
  }
  return (
    <button type="button" className="k-load-line" data-testid="load-hold" aria-label={`${label}. Open Health`} title={tip} onClick={go}>
      <Mark w="wait" st={MACHINE} className="!size-2" />
      <span className="k-load-line-what">{what} for the machine</span>
      <span className="k-load-line-load tabular-nums">{load}</span>
    </button>
  );
}

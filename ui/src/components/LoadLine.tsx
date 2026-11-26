// On the rail, while agent trees wait for the machine (src/automation/load-hold.ts): one quiet line with how many
// wait and the load they wait on; its tooltip names them, and it opens Settings > Health. Folded, a count.
import { Gauge } from "lucide-react";
import { useLoadHold } from "../lib/load-hold.ts";
import { navigate } from "../lib/ui.ts";
import { span, useNow } from "./Mark.tsx";

export function LoadLine({ open }: { open: boolean }) {
  const v = useLoadHold();
  const now = useNow(!!v?.held.length, 30_000);
  if (!v?.held.length) return null;
  const n = v.held.length;
  const label = `${n} agent ${n === 1 ? "tree waits" : "trees wait"} for the machine`;
  const load = v.load1 === null ? "" : `load ${Math.round(v.load1)} on ${v.threads}`;
  const tip = [`${label}: ${load} threads. Your own turns go on.`, ...v.held.map((h) => `${h.title}, ${span(now - h.since)}`)].join("\n");
  const go = () => navigate({ name: "settings", section: "health" });
  if (!open) {
    return (
      <button type="button" className="k-stuck-chip" data-testid="load-hold" aria-label={`${label}. Open Health`} title={tip} onClick={go}>
        <Gauge /><span className="tabular-nums">{n}</span>
      </button>
    );
  }
  return (
    <button type="button" className="k-load-line" data-testid="load-hold" title={tip} onClick={go}>
      <span className="k-load-line-what">{label}</span>
      <span className="k-load-line-load tabular-nums">{load}</span>
    </button>
  );
}

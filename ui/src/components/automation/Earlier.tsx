import { ChevronsDown } from "lucide-react";
import { PAGE } from "../../lib/agent-fold.ts";

// The one row of a folded agents list: how many agents are left out, and a press that opens a page more of
// them (the newest of the left out first). `extra`: what is among them that the owner may want to know
// ("2 to land").
export function EarlierRow({ n, onMore, extra, className, testid = "agents-earlier" }: { n: number; onMore: () => void; extra?: string; className?: string; testid?: string }) {
  if (n <= 0) return null;
  const page = Math.min(PAGE, n);
  const said = `${n} earlier agent${n === 1 ? "" : "s"}${extra ? `, ${extra}` : ""}. Show ${page} more`;
  return (
    <button type="button" onClick={onMore} data-testid={testid} data-count={n} title={said} aria-label={said} className={className ?? "k-earlier"}>
      <ChevronsDown aria-hidden />
      <span className="k-earlier-n">{n}</span> earlier
      {extra && <span className="k-earlier-extra"> · {extra}</span>}
    </button>
  );
}

// The branches that wait only for a landing, across the owner's sessions: one line each (the session, the
// branch, what its checks and review say, how much it changes) with Open, which goes to the session's Landing
// panel, and Land, which the daemon takes only on the facts shown. Not a request and not counted: a part of
// Home and of the Inbox with no mark on any list row (lib/ready.ts).
import { useEffect, useRef, useState } from "react";
import type { LandCard } from "../../../src/board/card.ts";
import { landReady, openLanding, useReadyToLand } from "../lib/ready.ts";
import { cn } from "../lib/utils.ts";

// What the branch changes: files and lines over its areas.
const sizeOf = (c: LandCard) => c.areas.reduce((n, a) => ({ files: n.files + a.files, added: n.added + a.added, removed: n.removed + a.removed }), { files: 0, added: 0, removed: 0 });
const checksOf = (c: LandCard) => (c.checks.state === "known" && c.checks.passed.length ? `${c.checks.passed.join(", ")} passed` : "no checks named");

// Cards stand where they came: one that arrives joins at the end, so a row never moves under the pointer
// because another appeared above it.
function useSteady(cards: LandCard[]): LandCard[] {
  const order = useRef<string[]>([]);
  const keys = new Set(cards.map((c) => c.key));
  order.current = [...order.current.filter((k) => keys.has(k)), ...cards.map((c) => c.key).filter((k) => !order.current.includes(k))];
  return order.current.map((k) => cards.find((c) => c.key === k)!);
}

function Row({ c }: { c: LandCard }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => { if (!note) return; const t = setTimeout(() => setNote(null), 6000); return () => clearTimeout(t); }, [note]);
  const size = sizeOf(c);
  const land = async () => {
    setBusy(true);
    setNote(null);
    const why = await landReady(c);
    setBusy(false);
    if (why) setNote(why);
  };
  return (
    <div data-testid="ready-row" data-key={c.key} data-branch={c.branch} title={`${c.branch}: ${checksOf(c)}`}>
      <div className="flex min-h-ctl-md items-center gap-3 border-b border-line">
        <span dir="auto" className="min-w-5 flex-[0_1_10rem] truncate text-base font-medium text-fg" data-testid="ready-title" title={c.title}>{c.title}</span>
        <span className="hidden min-w-0 flex-1 truncate font-mono text-micro text-faint @[50rem]:inline" data-testid="ready-branch" title={c.branch}>{c.branch}</span>
        <span className="hidden min-w-0 flex-1 truncate text-micro text-muted @[34rem]:inline @[50rem]:flex-none" data-testid="ready-facts" title={c.proof || checksOf(c)}>
          {checksOf(c)} · {c.review ? "approved" : "no review"} · {size.files} {size.files === 1 ? "file" : "files"} <span className="text-ok">+{size.added}</span> <span className="text-danger">-{size.removed}</span>
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <button type="button" className="k-home-act" data-quiet data-testid="ready-open" title="Open the session's Landing panel" onClick={() => openLanding(c)}>Open</button>
          <button type="button" className="k-home-act" data-testid="ready-land" disabled={busy} title={`Queue ${c.branch}: Keel builds it on the base, checks that tree and moves the base only to what passed`} onClick={() => void land()}>{busy ? "Landing" : "Land"}</button>
        </span>
      </div>
      {note && <p role="status" className="py-1 text-caption text-muted" data-testid="ready-note">{note}</p>}
    </div>
  );
}

export const READY_WORD = "Ready to land";

// The part, or nothing. `inbox`: the list's own row and head.
export function ReadyToLand({ inbox }: { inbox?: boolean }) {
  const cards = useSteady(useReadyToLand());
  if (!cards.length) return null;
  const head = <h2 className={inbox ? "k-label" : "k-pane-empty-word"} data-testid="ready-head">{READY_WORD}<span className="ml-2 tabular-nums font-normal text-faint">{cards.length}</span></h2>;
  const rows = cards.map((c) => <Row key={c.key} c={c} />);
  return inbox
    ? <li role="presentation" className={cn("@container px-2.5 pb-1 pt-3 first:pt-1.5")} data-testid="ready-part">{head}<div className="pt-1">{rows}</div></li>
    : <section className="k-home-sec @container" data-testid="ready-part">{head}<div className="k-home-list">{rows}</div></section>;
}

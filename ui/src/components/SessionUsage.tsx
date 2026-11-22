// What one session cost and why. The answer first: the cost the header shows
// (with its agents' when it started any), and what kind of spend it was: the
// part of a request that cost the most, a compaction, cold starts, the
// dearest turn, what was spent beside the turns. Then where the money went
// (by what the tokens were, at their own prices) and the turns, each opening
// its requests as a table.
import { type LedgerCounts, requestsWords, type TurnPick } from "../../../src/admin/turn-compare.ts";
import { Seg } from "./Seg.tsx";
import type { Session, StoredEvent } from "../../../src/core/types.ts";
import { ChevronRight } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useAuto } from "../lib/automation.ts";
import { KINDS, KIND_LABEL, KIND_WORDS, sent, sum, tokensOf, turnCosts, turnsOf, whyOf, type Costs, type Turn, type Why } from "../lib/spend.ts";
import { api, reportError, useModels, useStore } from "../lib/store.ts";
import { cn, fmtCost, fmtSessionCost, fmtTokens, when } from "../lib/utils.ts";
import { PART, Split, SplitBar, type Part } from "./Stat.tsx";
import { useWholeEvents } from "../lib/whole.ts";

// Parts for a bar or a split: cut by money when it is known, else by tokens.
const parts = (tokens: Costs, costs: Costs | null, output = true): Part[] =>
  KINDS.filter((k) => output || k !== "output").map((k) => ({ label: KIND_LABEL[k], color: PART[k], value: costs ? costs[k] : tokens[k], also: costs ? fmtTokens(tokens[k]) : undefined, testid: `usage-${k}` }));
const plural = (n: number, word: string) => `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;
// The turns drawn at once: a session of a thousand turns opens on its newest, and the rest are a press away.
const TURNS_SHOWN = 100;
const pct = (share: number) => `${Math.round(100 * share)}%`;
const NONE: StoredEvent[] = [];
const h3 = "text-base font-medium";

// The requests of one turn, one row each, the cost first. Where the panel is narrow (a phone)
// the counts are short (96k), so the table is whole; where it still scrolls, its edge shows it.
const HEADS: [string, string][] = [["Request", "The request's place in the turn"], ["Cost", "At the model's price"], ["Read", "Tokens read from the cache"], ["Written", "Tokens written to the cache"], ["New", "New input, at full price"], ["Out", "Output tokens"]];
const Count = ({ n }: { n: number }) => <><span className="@[30rem]:hidden">{fmtTokens(n)}</span><span className="hidden @[30rem]:inline">{n.toLocaleString()}</span></>;
function Requests({ t }: { t: Turn }) {
  const num = "px-1.5 py-1 text-right tabular-nums";
  let n = 0;
  return (
    <div className="@container mt-2 rounded-md border border-line bg-sunken/50" data-testid="usage-requests">
      <div className="k-scroll-x" data-on="sunken">
        <table className="w-full text-caption">
          <thead>
            <tr className="border-b border-line text-faint">
              {HEADS.map(([h, full], i) => <th key={h} title={full} className={cn("px-1.5 py-1 font-normal whitespace-nowrap", i ? "text-right" : "text-left")}>{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {t.requests.map((r, i) => (
              <tr key={i} className="border-b border-line/60 text-muted last:border-0" data-what={r.what}>
                <td className="px-1.5 py-1 tabular-nums text-faint">{r.what ?? ++n}</td>
                <td className={cn(num, "text-fg")}>{r.u.cost !== undefined ? fmtCost(r.u.cost) : ""}</td>
                <td className={num}><Count n={r.u.cache_read} /></td>
                <td className={num}><Count n={r.u.cache_write} /></td>
                <td className={num}><Count n={r.u.input} /></td>
                <td className={num}><Count n={r.u.output} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Why it cost that, in one or two sentences: what drove it (a turn, with what drove the turn, or a
// kind of spend), then a compaction or the turns that started cold. A turn it names is a link to it.
const LINK = "font-medium text-fg underline decoration-line-strong underline-offset-2 hover:decoration-fg";
function WhyLine({ why, onTurn }: { why: Why; onTurn: (n: number) => void }) {
  const said: ReactNode[] = [];
  const t = why.turn;
  if (t) {
    const cause = [t.kind && `mostly ${KIND_WORDS[t.kind]}`, t.compacted && "with a compaction in it", t.cold && "on a cold cache"].filter(Boolean).join(", ");
    said.push(<span key="turn"><button type="button" className={LINK} data-testid="usage-why-turn" onClick={() => onTurn(t.n)}>Turn {t.n}</button> is {pct(t.share)} of it{cause ? `, ${cause}` : ""}.</span>);
  } else if (why.top) said.push(`${pct(why.top.share)} of it went on ${KIND_WORDS[why.top.kind]}.`);
  const next = !t?.compacted && why.compactions ? `${why.compactions.n === 1 ? "A compaction" : `${why.compactions.n} compactions`} took ${why.compactions.cost !== undefined ? fmtCost(why.compactions.cost) : "a cost not known"}.`
    : null;
  if (next) said.push(next);
  else {
    // The turns that started cold, each a link to its turn (the driver's own cold start is said with it).
    const cold = why.cold.filter((n) => !(t?.cold && n === t.n));
    const shown = cold.slice(0, 3);
    if (shown.length) said.push(
      <span key="cold" data-testid="usage-why-cold">
        {/* One turn is linked by its whole name, as the driver above is; several, each by its number. */}
        {shown.length > 1 && "Turns "}
        {shown.map((n, i) => <span key={n}>{i ? (i === shown.length - 1 && cold.length === shown.length ? " and " : ", ") : ""}<button type="button" className={LINK} onClick={() => onTurn(n)}>{shown.length > 1 ? n : `Turn ${n}`}</button></span>)}
        {cold.length > shown.length ? ` and ${cold.length - shown.length} more` : ""} started on a cold cache.
      </span>,
    );
  }
  if (!said.length) return null;
  return <p className="mt-1 text-ui leading-relaxed text-muted" data-testid="usage-why">{said.map((x, i) => <span key={i}>{i ? " " : ""}{x}</span>)}</p>;
}

type Order = "newest" | "oldest" | "dearest" | "longest";
const fmtDur = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s` : `${Math.round(ms / 60_000)} min`);

export function SessionUsage({ session }: { session: Session }) {
  // Every turn of the session, not only the part the page holds (that part shows until the rest is read).
  const held = useStore((s) => s.events[session.id]);
  const events = useWholeEvents(session.id) ?? held ?? NONE;
  // The whole listing: a turn may have run on a model no session runs on now, and its price is only there.
  const models = useModels();
  const turns = useMemo(() => turnsOf(events), [events]);
  // The session's own figure, the one the header shows: it also counts what ran beside the turns.
  const whole = session.usage.cost;
  const why = useMemo(() => whyOf(turns, (id) => models.find((m) => m.id === id)?.price, whole), [turns, models, whole]);
  const priceOf = (id?: string) => models.find((m) => m.id === id)?.price;
  // A turn's bar is cut by what it cost, as the legend above it is; by tokens only where a price is not known.
  const costs = useMemo(() => (why.costs ? turns.map((t) => turnCosts(t, priceOf)) : null), [turns, models, why.costs]);
  const priced = !!costs && costs.every(Boolean);
  const max = Math.max(priced ? 0 : 1, ...turns.map((t, i) => (priced ? sum(costs![i]!) : sent(t.total))));
  // Every row of the turns' tables, a compaction's included: the same count a turn shows.
  const requests = turns.reduce((n, t) => n + t.requests.length, 0);
  const [open, setOpen] = useState<number | null>(null);
  const [shown, setShown] = useState(TURNS_SHOWN);
  // The newest turn first: the one a person opens the panel about. The other orders answer "which was dearest" and "which took longest".
  const [order, setOrder] = useState<Order>("newest");
  const listed = useMemo(() => {
    const at = turns.map((t, i) => ({ t, i }));
    const cost = (x: { t: Turn; i: number }) => (priced ? sum(costs![x.i]!) : x.t.total.cost ?? sent(x.t.total));
    return order === "oldest" ? at : order === "newest" ? [...at].reverse() : [...at].sort((a, b) => (order === "dearest" ? cost(b) - cost(a) : (b.t.ms ?? 0) - (a.t.ms ?? 0)) || b.i - a.i);
  }, [turns, order, priced, costs]);
  // The ledger's own counts: every request attempt, the failed ones too (the events hold only the answered ones).
  const [ledger, setLedger] = useState<{ counts: LedgerCounts; turns: TurnPick[] } | null>(null);
  useEffect(() => {
    let live = true;
    api<{ counts: LedgerCounts; turns: TurnPick[] }>(`/api/telemetry/turns?session_id=${encodeURIComponent(session.id)}&limit=5000`).then((r) => { if (live) setLedger(r); }).catch(reportError);
    return () => { live = false; };
  }, [session.id, turns.length]);
  const attempts = useMemo(() => new Map((ledger?.turns ?? []).map((t) => [t.turn_event, t])), [ledger]);
  // The widest turn number sets the column every row's number, bar and figures line up on.
  const digits = `${String(Math.max(1, turns.length)).length}ch`;
  const show = (n: number) => { setOpen(n); setShown(turns.length); requestAnimationFrame(() => document.querySelector(`[data-turn="${n}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" })); };
  // What the agents this session started spent: the task's cost is both.
  // Re-read when one of them ends; their requests, not their reports, count.
  const kids = useAuto((s) => Object.values(s.agents).filter((a) => a.parent_id === session.id).map((a) => `${a.id}:${a.status}`).join(","));
  const [delegated, setDelegated] = useState<{ calls: number; cost_usd?: number } | null>(null);
  useEffect(() => {
    if (!kids) return setDelegated(null);
    api<{ total: { calls: number; cost_usd?: number } }>(`/api/usage?group=session&children_of=${encodeURIComponent(session.id)}`).then((r) => setDelegated(r.total)).catch(reportError);
  }, [session.id, kids]);
  const money = (c?: number) => (c !== undefined ? fmtCost(c) : "not priced");
  // The headline is the header's figure, digit for digit.
  const exact = (c?: number) => (c !== undefined ? fmtSessionCost(c) : "not priced");
  const task = delegated ? (whole !== undefined && delegated.cost_usd !== undefined ? whole + delegated.cost_usd : undefined) : whole;
  return (
    <div className="flex h-full flex-col gap-5 overflow-y-auto p-4" data-testid="tokens-panel">
      <section data-testid="usage-cost">
        <div className="text-caption text-muted">{delegated ? "This task cost" : "This session cost"}</div>
        <div className="mt-0.5 text-display font-semibold tabular-nums" data-testid="usage-total">{exact(task)}{session.usage.unpriced ? "+" : ""}</div>
        <p className="mt-1.5 text-ui leading-relaxed text-muted">
          {delegated && (
            <span data-testid="usage-task">
              <span data-testid="usage-direct">{money(whole)} in this session</span>, <span data-testid="usage-delegated">{money(delegated.cost_usd)} in its {plural(kids.split(",").length, "agent")} ({plural(delegated.calls, "request")})</span>.{" "}
            </span>
          )}
          {/* A mean says nothing where one turn holds most of the cost. */}
          {turns.length ? `${plural(turns.length, "turn")}, ${ledger && ledger.counts.requests >= requests ? requestsWords(ledger.counts.requests, ledger.counts.failed) : plural(requests, "request")}${whole !== undefined && turns.length > 1 && !why.turn ? `, ${fmtCost(whole / turns.length)} a turn` : ""}.` : "No turns yet."}
          {session.usage.unpriced ? ` ${plural(session.usage.unpriced, "request")} had no known price.` : ""}
        </p>
        <WhyLine why={why} onTurn={show} />
      </section>

      <section>
        <div className="mb-2.5 flex flex-wrap items-baseline gap-x-2">
          <h3 className={h3}>{why.costs ? "Where the money went" : "Where the tokens went"}</h3>
          <span className="text-caption text-faint">{fmtTokens(sum(why.tokens))} tokens in the turns</span>
        </div>
        <Split parts={parts(why.tokens, why.costs)} format={why.costs ? (v) => fmtCost(v) : fmtTokens} heads={why.costs ? ["Cost", "Tokens", "of cost"] : ["Tokens", "", "of tokens"]} testid="usage-split" />
      </section>

      <section className="min-h-0">
        <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1.5">
          <h3 className={h3}>Turns</h3>
          <span className="text-caption text-faint">open one for its requests</span>
          {turns.length > 1 && (
            <span className="ml-auto" data-testid="usage-turn-order">
              <Seg<Order> label="Order of the turns" value={order} onChange={setOrder} options={[{ value: "newest", label: "Newest" }, { value: "oldest", label: "Oldest" }, { value: "dearest", label: "Dearest" }, { value: "longest", label: "Longest" }]} />
            </span>
          )}
        </div>
        {!turns.length && <p className="k-empty">No turns yet.</p>}
        <ol className="flex flex-col" style={{ "--turn-n": digits } as React.CSSProperties}>
          {listed.slice(0, shown).map(({ t, i: ti }) => {
            const s = sent(t.total);
            // The turn's attempts as the ledger counted them: the ones that failed are said.
            const led = t.id ? attempts.get(t.id) : undefined;
            const on = open === t.n;
            const compacted = t.requests.filter((r) => r.what).length;
            return (
              <li key={t.n} data-testid="usage-turn" data-turn={t.n} className="border-t border-line first:border-0">
                <button
                  type="button"
                  aria-expanded={on}
                  title={when(t.ts)}
                  onClick={() => setOpen(on ? null : t.n)}
                  className="-mx-2 block w-[calc(100%+1rem)] rounded-md px-2 py-2 text-left outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="flex items-baseline gap-2">
                    <span className="w-[var(--turn-n)] shrink-0 text-right text-caption tabular-nums text-faint">{t.n}</span>
                    <span dir="auto" className="min-w-0 flex-1 truncate text-left text-ui text-fg">{t.prompt || "(no prompt)"}</span>
                    {t.cold && t.reused && <span className="shrink-0 rounded-sm bg-brass-soft px-1.5 py-px text-micro text-brass" data-testid="usage-cold" title={`the first request read ${fmtTokens(t.reused.read)} from cache of the ${fmtTokens(t.reused.before)} the turn before sent`}>cache cold</span>}
                    {compacted > 0 && <span className="shrink-0 rounded-sm bg-sunken px-1.5 py-px text-micro text-muted" data-testid="usage-compacted">compaction</span>}
                    <span className="shrink-0 text-ui tabular-nums text-fg" data-testid="usage-turn-cost">{t.total.cost !== undefined ? fmtCost(t.total.cost) : ""}</span>
                    <ChevronRight className={cn("size-3.5 shrink-0 self-center text-faint transition-transform", on && "rotate-90")} aria-hidden />
                  </span>
                  <span className="mt-1.5 block pl-[calc(var(--turn-n)+0.5rem)]"><SplitBar parts={parts(tokensOf(t.total), priced ? costs![ti]! : null, priced)} max={max} /></span>
                  <span className="mt-1 flex flex-wrap gap-x-3 pl-[calc(var(--turn-n)+0.5rem)] text-caption tabular-nums text-muted">
                    <span>{fmtTokens(s)} sent</span>
                    <span>{fmtTokens(t.total.output)} out</span>
                    <span data-testid="usage-turn-requests">{led && led.requests >= t.requests.length ? `${plural(led.requests, "request")}${led.failed_attempts ? `, ${led.failed_attempts} failed` : ""}` : plural(t.requests.length, "request")}</span>
                    {t.ms !== undefined && <span>{fmtDur(t.ms)}</span>}
                  </span>
                </button>
                {on && <div className="pb-2.5 pl-[calc(var(--turn-n)+0.5rem)] max-sm:pl-0"><Requests t={t} /></div>}
              </li>
            );
          })}
          {listed.length > shown && (
            <li className="border-t border-line py-2">
              <button type="button" className="rounded-sm text-caption text-muted underline decoration-line-strong underline-offset-2 outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setShown((n) => n + 400)} data-testid="usage-turns-more">
                {(listed.length - shown).toLocaleString("en-US")} more {listed.length - shown === 1 ? "turn" : "turns"}, {order === "newest" ? "older" : order === "oldest" ? "newer" : order === "dearest" ? "cheaper" : "shorter"} than these
              </button>
            </li>
          )}
          {/* What was spent outside the turns' own requests, so the rows add up to the figure at the top. */}
          {why.beside !== undefined && turns.length > 0 && (
            <li data-testid="usage-beside" className="flex items-baseline gap-2 border-t border-line py-2">
              <span className="w-[var(--turn-n)] shrink-0" aria-hidden />
              <span className="min-w-0 flex-1 text-ui text-muted">Beside the turns <span className="text-caption text-faint">side questions, readers, summaries on their own</span></span>
              <span className="shrink-0 text-ui tabular-nums text-fg" data-testid="usage-beside-cost">{fmtCost(why.beside)}</span>
              <span className="size-3.5 shrink-0" aria-hidden />
            </li>
          )}
        </ol>
      </section>
    </div>
  );
}

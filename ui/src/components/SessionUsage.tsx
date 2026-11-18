// Tokens of one session, turn by turn: what each turn sent (read from the
// provider's cache, written to it, or paid in full), what it wrote back, and
// what it cost. A turn whose cache had expired is marked: it re-sent the
// conversation at the write price.
import type { Session, StoredEvent, Usage } from "../../../src/core/types.ts";
import { useStore } from "../lib/store.ts";
import { cn, fmtCost, fmtTokens, when } from "../lib/utils.ts";

type Turn = { n: number; prompt: string; ts: number; ms?: number; requests: Usage[]; total: Usage; cold: boolean };

const zero = (): Usage => ({ input: 0, output: 0, cache_read: 0, cache_write: 0 });
const add = (a: Usage, b: Usage): Usage => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cache_read: a.cache_read + b.cache_read,
  cache_write: a.cache_write + b.cache_write,
  cost: a.cost !== undefined || b.cost !== undefined ? (a.cost ?? 0) + (b.cost ?? 0) : undefined,
});
const sent = (u: Usage) => u.input + u.cache_read + u.cache_write;

export function turnsOf(events: StoredEvent[]): Turn[] {
  const out: Turn[] = [];
  let prompt = "";
  let cur: Turn | null = null;
  for (const e of events) {
    if (e.kind === "user") prompt = String(e.data.text ?? "");
    else if (e.kind === "turn_start") cur = { n: out.length + 1, prompt, ts: e.ts, requests: [], total: zero(), cold: false };
    else if (e.kind === "assistant" && cur && e.data.usage) {
      cur.requests.push(e.data.usage);
      cur.total = add(cur.total, e.data.usage);
    } else if (e.kind === "turn_end" && cur) {
      cur.ms = e.data.ms;
      // Cold: a later turn whose first request wrote most of what it sent.
      const f = cur.requests[0];
      cur.cold = out.length > 0 && !!f && sent(f) > 2000 && f.cache_write > 0.5 * sent(f);
      out.push(cur);
      cur = null;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function Bar({ u, max }: { u: Usage; max: number }) {
  const w = (n: number) => `${max ? (100 * n) / max : 0}%`;
  return (
    <div className="flex h-2 w-full overflow-hidden rounded-full bg-sunken" aria-hidden>
      <div className="bg-accent" style={{ width: w(u.cache_read) }} />
      <div className="bg-brass" style={{ width: w(u.cache_write) }} />
      <div className="bg-danger" style={{ width: w(u.input) }} />
    </div>
  );
}

function Tile({ label, value, sub, testid }: { label: string; value: string; sub?: string; testid?: string }) {
  return (
    <div className="rounded-lg border border-line bg-raised px-3 py-2" data-testid={testid}>
      <div className="text-micro uppercase tracking-wide text-faint">{label}</div>
      <div className="mt-0.5 font-mono text-read tabular-nums text-fg">{value}</div>
      {sub && <div className="text-caption text-muted">{sub}</div>}
    </div>
  );
}

export function SessionUsage({ session }: { session: Session }) {
  const events = useStore((s) => s.events[session.id]) ?? [];
  const turns = turnsOf(events);
  const total = turns.reduce((a, t) => add(a, t.total), zero());
  const all = sent(total);
  const cached = all ? Math.round((100 * total.cache_read) / all) : 0;
  const max = Math.max(1, ...turns.map((t) => sent(t.total)));
  const requests = turns.reduce((n, t) => n + t.requests.length, 0);
  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-3" data-testid="session-usage">
      <div className="grid grid-cols-2 gap-2">
        <Tile testid="usage-sent" label="Sent" value={fmtTokens(all)} sub={`${cached}% read from cache`} />
        <Tile label="Written to cache" value={fmtTokens(total.cache_write)} sub={`${fmtTokens(total.input)} paid in full`} />
        <Tile label="Output" value={fmtTokens(total.output)} sub={`${requests} requests, ${turns.length} turns`} />
        <Tile testid="usage-cost" label="Cost" value={total.cost !== undefined ? fmtCost(total.cost) : "not priced"} sub={turns.length ? `${fmtCost((total.cost ?? 0) / turns.length)} a turn` : undefined} />
      </div>
      <div className="flex items-center gap-3 text-caption text-muted">
        <span className="flex items-center gap-1"><i className="size-2 rounded-full bg-accent" /> cache read</span>
        <span className="flex items-center gap-1"><i className="size-2 rounded-full bg-brass" /> written</span>
        <span className="flex items-center gap-1"><i className="size-2 rounded-full bg-danger" /> full price</span>
      </div>
      {!turns.length && <p className="text-ui text-muted">No turns yet.</p>}
      <ol className="flex flex-col gap-1.5">
        {turns.map((t) => {
          const s = sent(t.total);
          return (
            <li
              key={t.n}
              data-testid="usage-turn"
              className="rounded-md border border-line px-2.5 py-2"
              title={`${when(t.ts)}\n${t.requests.map((u, i) => `request ${i + 1}: ${u.cache_read} read, ${u.cache_write} written, ${u.input} full, ${u.output} out`).join("\n")}`}
            >
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-caption tabular-nums text-faint">{t.n}</span>
                <span className="min-w-0 flex-1 truncate text-ui text-fg">{t.prompt || "(no prompt)"}</span>
                {t.cold && <span className="rounded-sm bg-brass-soft px-1.5 py-px text-micro text-brass" data-testid="usage-cold">cache cold</span>}
              </div>
              <div className="mt-1.5"><Bar u={t.total} max={max} /></div>
              <div className={cn("mt-1 flex gap-3 font-mono text-micro tabular-nums text-muted")}>
                <span>{fmtTokens(s)} in</span>
                <span>{s ? Math.round((100 * t.total.cache_read) / s) : 0}% cached</span>
                <span>{fmtTokens(t.total.output)} out</span>
                <span>{t.requests.length} req</span>
                <span className="ml-auto">{t.total.cost !== undefined ? fmtCost(t.total.cost) : ""}</span>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

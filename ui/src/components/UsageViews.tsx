// The views of Settings > Usage beyond the overview: where the prompt tokens
// go (zones and how each was served from the cache), why requests fail (error
// classes per provider and model, over time), what each compaction did, and
// two ranges or two models side by side. Plain markup on the shared tokens.
import { useEffect, useState, type ReactNode } from "react";
import { api, reportError, useStore, useModels } from "../lib/store.ts";
import { navigate, setUI } from "../lib/ui.ts";
import { ago, cn, fmtTokens, when } from "../lib/utils.ts";
import { TimeChart } from "./Chart.tsx";
import { Segmented } from "./Settings.tsx";
import { fmtMs, fmtPct, fmtUsd, Panel, RANGES, Table, type Range, RANGE_OPTIONS } from "./UsagePanel.tsx";
import { TurnsCompare } from "./UsagePast.tsx";
import { Stat, Stats } from "./Stat.tsx";
import { Select } from "./Select.tsx";

type ZoneKey = "tools" | "system" | "history" | "tail";
type ZoneCache = { tokens: number; read: number; written: number; fresh: number };
type ZoneSet = Record<ZoneKey, ZoneCache>;
const ZONES: { key: ZoneKey; label: string; hint: string; color: string }[] = [
  { key: "tools", label: "Tools", hint: "the tool schemas", color: "var(--faint)" },
  { key: "system", label: "System", hint: "the system prompt and instruction files", color: "var(--series-3)" },
  { key: "history", label: "Frozen history", hint: "what the previous request already carried", color: "var(--series-1)" },
  { key: "tail", label: "Volatile tail", hint: "new since the previous request", color: "var(--series-2)" },
];

function useReport<T>(path: string | null, deps: unknown[]): T | null {
  const [r, setR] = useState<T | null>(null);
  useEffect(() => {
    if (!path) return;
    let live = true;
    let again: ReturnType<typeof setTimeout> | undefined;
    // A report the daemon answered from what it keeps while it reads its ledger again is asked for once more in a moment.
    const load = (): Promise<unknown> => api<T>(path).then((x) => { if (!live) return; setR(x); if ((x as { refreshing?: boolean }).refreshing) again = setTimeout(load, 2500); }).catch(reportError);
    load();
    const iv = setInterval(load, 30_000);
    return () => { live = false; clearInterval(iv); clearTimeout(again); };
  }, deps);
  return r;
}

const share = (n: number, of: number) => (of ? n / of : null);
const sumZones = (z: ZoneSet) => ZONES.reduce((n, k) => n + z[k.key].tokens, 0);
const openSession = (id: string, event?: string) => { if (event) setUI({ focusEvent: event }); navigate({ name: "session", id }); };

// One request's (or many requests') prompt as four segments, each split by how the cache served it.
function ZoneBar({ z, max, testid }: { z: ZoneSet; max: number; testid?: string }) {
  const total = sumZones(z);
  return (
    <div className="flex h-3 w-full overflow-hidden rounded-sm bg-sunken" data-testid={testid}
      title={ZONES.map((k) => `${k.label}: ${fmtTokens(z[k.key].tokens)} (${fmtTokens(z[k.key].read)} read from cache)`).join("\n")}>
      {ZONES.map((k) => {
        const c = z[k.key];
        if (!c.tokens) return null;
        // Read from cache solid, written lighter, sent in full lightest.
        return (
          <div key={k.key} className="flex h-full border-r border-raised last:border-0" style={{ width: `${(100 * c.tokens) / Math.max(1, max)}%` }}>
            <div style={{ flex: c.read, background: k.color }} />
            <div style={{ flex: c.written, background: k.color, opacity: 0.55 }} />
            <div style={{ flex: c.fresh, background: k.color, opacity: 0.25 }} />
          </div>
        );
      }).filter(Boolean)}
      {total < max && <div style={{ flex: max - total }} />}
    </div>
  );
}

function ZoneLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-caption text-muted">
      {ZONES.map((k) => <span key={k.key} className="flex items-center gap-1.5"><i className="size-2 rounded-sm" style={{ background: k.color }} />{k.label}</span>)}
      <span className="text-faint">Solid: read from cache. Lighter: written to it. Lightest: sent in full.</span>
    </div>
  );
}

type Tokens = {
  since_ms: number; until_ms: number; bucket_ms: number; measured_calls: number; calls: number; total: ZoneSet;
  series: { t_ms: number; last_ms?: number; calls: number; zones: ZoneSet }[];
  by_purpose: { purpose: string; calls: number; zones: ZoneSet }[];
  turns: { turn_event: string; ts_ms: number; prompt: string; prompt_event?: string; requests: number; zones: ZoneSet; per_request: { ts_ms: number; purpose: string; zones: ZoneSet }[] }[];
};

const PURPOSE: Record<string, string> = { turn: "Turn steps", summary: "Compaction summaries", side: "Side answers", reader: "Reader reads" };

export function TokensView({ range }: { range: Range }) {
  const sessions = useStore((s) => s.sessions);
  const [session, setSession] = useState<string>("");
  const r = useReport<Tokens>(`/api/telemetry/tokens?since_ms=${Date.now() - RANGES[range]}${session ? `&session_id=${session}` : ""}`, [range, session]);
  const recent = Object.values(sessions).filter((s) => !s.archived && !s.parent_id).sort((a, b) => b.updated - a.updated).slice(0, 30);
  if (!r) return <div className="text-ui text-faint">Reading the measurements.</div>;
  const total = sumZones(r.total);
  const maxReq = Math.max(1, ...r.turns.flatMap((t) => t.per_request.map((q) => sumZones(q.zones))));
  return (
    <div className="flex flex-col gap-4" data-testid="usage-tokens">
      <label className="flex items-center gap-2 text-ui text-muted">
        Sessions
        <Select data-testid="zones-session" value={session} onChange={(e) => setSession(e.target.value)} className="h-8 max-w-96 rounded-md border border-line-strong bg-raised px-2 text-ui text-fg">
          <option value="">All sessions</option>
          {recent.map((s) => <option key={s.id} value={s.id}>{s.title || "(untitled)"}</option>)}
        </Select>
        {!session && <span className="text-caption text-faint">Pick one to see its turns.</span>}
      </label>
      <Panel title="Prompt zones" hint={`${r.measured_calls} measured requests; a zone's tokens are an estimate from its bytes, scaled to what the provider counted`} testid="zones-total">
        <ZoneBar z={r.total} max={total} testid="zones-bar" />
        <div className="mt-3"><ZoneLegend /></div>
        <div className="mt-3">
          <Table
            head={["Zone", "Tokens", "Share", "Read from cache", "Written", "Sent in full"]}
            rows={ZONES.map((k) => {
              const c = r.total[k.key];
              return [<span title={k.hint}>{k.label}</span>, fmtTokens(c.tokens), fmtPct(share(c.tokens, total)), fmtPct(share(c.read, c.tokens)), fmtPct(share(c.written, c.tokens)), fmtPct(share(c.fresh, c.tokens))];
            })}
          />
        </div>
      </Panel>

      <Panel title="Zones over time" hint="prompt tokens per bucket" testid="zones-chart">
        <TimeChart
          kind="bars" label="Prompt zones over time"
          data={r.series.map((p) => ({ t: p.t_ms, at: p.last_ms, values: ZONES.map((k) => p.zones[k.key].tokens) }))}
          series={ZONES.map((k) => ({ label: k.label, color: k.color }))}
          bucket={r.bucket_ms} since={r.since_ms} until={r.until_ms} format={fmtTokens}
        />
        <div className="mt-3">
          <TimeChart
            label="Share of each bucket's prompt read from the cache"
            data={r.series.map((p) => ({ t: p.t_ms, at: p.last_ms, values: (["history", "tail"] as const).map((k) => share(p.zones[k].read, p.zones[k].tokens)) }))}
            series={[{ label: "Frozen history read from cache", color: "var(--series-1)" }, { label: "Volatile tail read from cache", color: "var(--series-2)" }]}
            bucket={r.bucket_ms} since={r.since_ms} until={r.until_ms} max={1} height={140} format={(v) => `${Math.round(v * 100)}%`}
          />
        </div>
      </Panel>

      {r.by_purpose.length > 1 && (
        <Panel title="By purpose" testid="zones-purpose">
          <Table head={["Requests for", "Calls", "Prompt tokens", "Read from cache"]} rows={r.by_purpose.map((p) => {
            const t = sumZones(p.zones);
            return [PURPOSE[p.purpose] ?? p.purpose, p.calls, fmtTokens(t), fmtPct(share(ZONES.reduce((n, k) => n + p.zones[k.key].read, 0), t))];
          })} />
        </Panel>
      )}

      {session && (
        <Panel title="Per turn" hint="each request of the last 30 turns, on one scale" testid="zones-turns">
          {!r.turns.length ? <p className="k-empty">No measured turns in this range.</p> : (
            <ol className="flex flex-col gap-2">
              {r.turns.map((t) => {
                const sum = sumZones(t.zones);
                return (
                  <li key={t.turn_event} className="rounded-md border border-line px-3 py-2" data-testid="zones-turn">
                    <div className="flex items-baseline gap-3">
                      <span className="w-12 shrink-0 text-caption tabular-nums text-faint" title={when(t.ts_ms)}>{ago(t.ts_ms)}</span>
                      <button type="button" className="k-link min-w-0 flex-1 truncate text-left text-ui hover:underline" onClick={() => openSession(session, t.prompt_event)}>{t.prompt || "(no prompt)"}</button>
                      <span className="shrink-0 text-caption tabular-nums text-muted">{t.requests} {t.requests > 1 ? "requests" : "request"}, {fmtTokens(sum)} sent</span>
                    </div>
                    <div className="mt-1.5 flex flex-col gap-1">
                      {t.per_request.map((q, i) => (
                        <div key={i} className="flex items-center gap-2">
                          <span className="w-16 shrink-0 text-micro text-faint">{q.purpose === "turn" ? `step ${i + 1}` : q.purpose === "summary" ? "summary" : q.purpose === "reader" ? "reader" : "side"}</span>
                          <ZoneBar z={q.zones} max={maxReq} />
                        </div>
                      ))}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-4 text-caption tabular-nums text-muted">
                      {ZONES.map((k) => <span key={k.key}>{k.label} {fmtTokens(t.zones[k.key].tokens)}, {fmtPct(share(t.zones[k.key].read, t.zones[k.key].tokens))} cached</span>)}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
          <div className="mt-3"><ZoneLegend /></div>
        </Panel>
      )}
    </div>
  );
}

export const CLASS: Record<string, string> = {
  rate_limit: "Rate limited", overloaded: "Overloaded", server: "Server error", stream_drop: "Stream dropped", unreachable: "Provider unreachable", context_overflow: "Context overflow",
  auth: "Sign-in or key refused", quota: "Quota or billing", refusal: "Refused", image: "Image refused", invalid_request: "Request refused as invalid", other: "Other",
};

type Report = {
  since_ms: number; until_ms: number; bucket_ms: number; total: { calls: number; errors: number; interrupted: number; failed: number; failed_share: number };
  series: { t_ms: number; last_ms?: number; calls: number; classes: Record<string, number> }[];
  error_classes: { provider: string; model: string; class: string; count: number; calls: number; rate: number; last_ms: number; last_error: string | null }[];
};

export function ErrorsView({ range }: { range: Range }) {
  const models = useModels();
  const name = (id: string) => models.find((m) => m.id === id)?.name ?? id.slice(id.indexOf(":") + 1);
  const r = useReport<Report>(`/api/telemetry?since_ms=${Date.now() - RANGES[range]}`, [range]);
  if (!r) return <div className="text-ui text-faint">Reading the measurements.</div>;
  // The three most frequent classes get a series each; the rest are summed.
  const counts = new Map<string, number>();
  for (const e of r.error_classes) counts.set(e.class, (counts.get(e.class) ?? 0) + e.count);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
  const shown = top.slice(0, 3);
  const colors = ["var(--series-1)", "var(--series-2)", "var(--series-3)"];
  const series = [...shown.map((c, i) => ({ label: CLASS[c] ?? c, color: colors[i]! })), ...(top.length > 3 ? [{ label: "Other classes", color: "var(--faint)" }] : [])];
  // The range's one failed share, the daemon's: the same figure Overview and Compare show.
  const failed = r.total.failed;
  return (
    <div className="flex flex-col gap-4" data-testid="usage-errors">
      <Stats>
        <Stat label="Requests" value={r.total.calls} sub={`${r.total.interrupted} stopped by the owner`} />
        <Stat testid="errors-failed" label="Failed or refused" value={failed} tone={failed && failed / Math.max(1, r.total.calls) >= 0.05 ? "danger" : undefined} sub={fmtPct(r.total.calls ? r.total.failed_share : null) + " of requests"} />
        <Stat label="Most frequent" value={top[0] ? counts.get(top[0])! : 0} sub={top[0] ? CLASS[top[0]] ?? top[0] : "no failures"} />
        <Stat label="Classes seen" value={top.length} sub={top.length ? top.map((c) => CLASS[c] ?? c).slice(0, 3).join(", ") : "no failures"} />
      </Stats>
      <Panel title="Failures over time" hint="by class, per bucket" testid="errors-chart">
        {failed ? (
          <TimeChart
            kind="bars" label="Failed requests by class over time"
            data={r.series.map((p) => ({ t: p.t_ms, at: p.last_ms, values: [...shown.map((c) => p.classes[c] ?? 0), ...(top.length > 3 ? [top.slice(3).reduce((n, c) => n + (p.classes[c] ?? 0), 0)] : [])] }))}
            series={series} bucket={r.bucket_ms} since={r.since_ms} until={r.until_ms} format={(v) => String(Math.round(v))}
          />
        ) : <p className="k-empty">No request failed in this range.</p>}
      </Panel>
      <Panel title="By provider and model" hint="share is of that model's requests" testid="errors-classes">
        {r.error_classes.length ? (
          <Table
            head={["Model", "Provider", "Class", "Times", "Share", "Last", "Last message"]}
            align={["l", "l", "l", "r", "r", "r", "l"]}
            rows={r.error_classes.map((e) => [
              <span title={e.model}>{name(e.model)}</span>, <span className="text-muted">{e.provider}</span>, CLASS[e.class] ?? e.class, e.count,
              <span className={e.rate >= 0.05 ? "text-danger" : undefined}>{fmtPct(e.rate)}</span>, <span title={when(e.last_ms)}>{ago(e.last_ms)}</span>,
              <span className="font-mono text-caption text-muted" title={e.last_error ?? ""}>{e.last_error ?? ""}</span>,
            ])}
          />
        ) : <p className="k-empty">No failures by any model in this range.</p>}
      </Panel>
    </div>
  );
}

type CacheRow = { ts_ms: number; prompt_tokens: number; cache_read: number; cache_write: number; hit_ratio: number | null };
type Compaction = {
  event_id: string; session_id: string; session_title?: string; session_gone: boolean; ts_ms: number; mode: string; trigger: string; ahead: boolean; focus: string | null;
  tokens_before: number | null; tokens_after: number | null; duration_ms: number | null; cost_usd: number | null; priced: boolean; input_tokens: number; output_tokens: number;
  kept: { summary_tokens: number; owner_messages: number; owner_tokens: number; verbatim_events: number } | null;
  cache: { before: CacheRow | null; after: CacheRow[] };
};
type Compactions = {
  total: { count: number; tokens_before: number; tokens_after: number; measured_after: number; paired: { count: number; tokens_before: number; tokens_after: number }; cost_usd: number; unpriced: number; duration_p50_ms: number | null; after_hit_ratio: number | null; before_hit_ratio: number | null; by_trigger: Record<string, number> };
  after_requests: number; compactions: Compaction[];
};
const TRIGGER: Record<string, string> = { threshold: "the context reached the limit", overflow: "a request did not fit", owner: "asked for", idle: "the cache expired while idle" };

export function CompactionsView({ range }: { range: Range }) {
  const r = useReport<Compactions>(`/api/telemetry/compactions?limit=50&since_ms=${Date.now() - RANGES[range]}`, [range]);
  const [open, setOpen] = useState<string | null>(null);
  if (!r) return <div className="text-ui text-faint">Reading the measurements.</div>;
  const t = r.total;
  const hits = (c: Compaction) => c.cache.after.map((a) => fmtPct(a.hit_ratio)).join(", ") || "no request yet";
  return (
    <div className="flex flex-col gap-4" data-testid="usage-compactions">
      <Stats>
        <Stat testid="compactions-count" label="Compactions" value={t.count} sub={Object.entries(t.by_trigger).map(([k, n]) => `${n} ${k}`).join(", ") || "none in this range"} />
        <Stat testid="compactions-after" label="Context after" value={t.paired.count ? fmtTokens(t.paired.tokens_after / t.paired.count) : "not yet"}
          sub={!t.count ? "no compaction" : t.paired.count ? `average, from ${fmtTokens(t.paired.tokens_before / t.paired.count)} before; ${t.paired.count} of ${t.count} measured` : `no request after any of the ${t.count} yet`} />
        <Stat label="Cost of the summaries" value={t.unpriced ? (t.cost_usd ? `${fmtUsd(t.cost_usd)}+` : "unknown") : fmtUsd(t.cost_usd)} sub={`median ${fmtMs(t.duration_p50_ms)} to write`} />
        <Stat label="Cache after" value={fmtPct(t.after_hit_ratio)} sub={`of the next ${r.after_requests} requests; ${fmtPct(t.before_hit_ratio)} before`} />
      </Stats>
      <Panel title="Each compaction" hint="newest first; open one for what it kept and how the cache came back" testid="compactions-list">
        {r.compactions.length ? (
          <Table
            head={["When", "Session", "Why", "Before", "After", "Took", "Cost", "Cache after"]}
            align={["l", "l", "l", "r", "r", "r", "r", "r"]}
            onRow={(i) => setOpen(open === r.compactions[i]!.event_id ? null : r.compactions[i]!.event_id)}
            expanded={(i) => {
              const c = r.compactions[i]!;
              if (open !== c.event_id) return null;
              return <CompactionDetail c={c} />;
            }}
            rows={r.compactions.map((c) => [
              <span title={when(c.ts_ms)}>{ago(c.ts_ms)}</span>,
              c.session_gone ? <span className="text-faint">deleted session</span> : <button type="button" className="k-link max-w-48 truncate text-accent hover:underline" onClick={(e) => { e.stopPropagation(); openSession(c.session_id, c.event_id); }}>{c.session_title || "the session"}</button>,
              c.mode === "clear" ? "cleared" : `${TRIGGER[c.trigger] ?? c.trigger}${c.ahead ? ", prepared ahead" : ""}`,
              c.tokens_before == null ? "?" : fmtTokens(c.tokens_before), c.tokens_after == null ? "not yet" : fmtTokens(c.tokens_after),
              fmtMs(c.duration_ms), c.mode === "clear" ? "none" : c.priced && c.cost_usd != null ? fmtUsd(c.cost_usd) : "unknown", hits(c),
            ])}
          />
        ) : <p className="k-empty">No compaction in this range.</p>}
      </Panel>
    </div>
  );
}

function CompactionDetail({ c }: { c: Compaction }) {
  const row = (label: string, value: ReactNode) => <div className="flex gap-3"><span className="w-40 shrink-0 text-faint">{label}</span><span className="tabular-nums">{value}</span></div>;
  return (
    <div className="flex flex-col gap-1 text-caption text-muted" data-testid="compaction-detail">
      {c.kept && row("Kept", `a summary of ${fmtTokens(c.kept.summary_tokens)}, ${c.kept.owner_messages} of the owner's messages word for word (${fmtTokens(c.kept.owner_tokens)})${c.kept.verbatim_events ? `, ${c.kept.verbatim_events} recent events as they were` : ""}`)}
      {c.focus && row("Focus asked", c.focus)}
      {c.mode !== "clear" && row("Summary request", `${fmtTokens(c.input_tokens)} in, ${fmtTokens(c.output_tokens)} out`)}
      {row("Request before", c.cache.before ? `${fmtTokens(c.cache.before.prompt_tokens)} sent, ${fmtPct(c.cache.before.hit_ratio)} read from cache` : "none")}
      {c.cache.after.map((a, i) => row(`Request ${i + 1} after`, `${fmtTokens(a.prompt_tokens)} sent, ${fmtPct(a.hit_ratio)} read from cache, ${fmtTokens(a.cache_write)} written`))}
    </div>
  );
}

type Side = {
  since_ms: number; until_ms: number; model: string | null; calls: number; errors: number; error_rate: number; failed: number; failed_share: number; interrupted: number;
  latency_p50: number | null; latency_p95: number | null; ttft_p50: number | null; ttft_p95: number | null; output_tokens_per_s: number | null;
  cache_hit_ratio: number | null; cache_hit_ratio_turns: number | null; breaks: number; compactions: number;
  priced_cost_usd: number; unpriced_calls: number; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number;
  tool_calls: number; tool_error_rate: number; classes: Record<string, number>;
};
type Mode = "ranges" | "models" | "turns";
const DAY = 86_400_000;
// Today runs from local midnight (a clock change included) and yesterday is
// the whole calendar day before; the others are rolling windows, named so.
const midnight = (t: number, daysBack = 0) => { const d = new Date(t); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - daysBack); return d.getTime(); };
const PRESETS: Record<string, { label: string; bounds: (now: number) => { a: [number, number]; b: [number, number] } }> = {
  day: { label: "Today so far against yesterday", bounds: (now) => ({ a: [midnight(now), now], b: [midnight(now, 1), midnight(now)] }) },
  week: { label: "Last 7 days against the 7 before", bounds: (now) => ({ a: [now - 7 * DAY, now], b: [now - 14 * DAY, now - 7 * DAY] }) },
  month: { label: "Last 30 days against the 30 before", bounds: (now) => ({ a: [now - 30 * DAY, now], b: [now - 60 * DAY, now - 30 * DAY] }) },
};

export function CompareView() {
  const models = useModels();
  const short = (id: string) => models.find((m) => m.id === id)?.name ?? id.slice(id.indexOf(":") + 1);
  const labels = useStore((s) => s.providerLabels);
  const provider = (id: string) => { const p = id.slice(0, id.indexOf(":")); return labels[p] ?? p; };
  const [mode, setMode] = useState<Mode>("ranges");
  const [preset, setPreset] = useState("week");
  const [range, setRange] = useState<Range>("week");
  const [used, setUsed] = useState<string[]>([]);
  const [ma, setMa] = useState("");
  const [mb, setMb] = useState("");
  useEffect(() => {
    api<{ by_model: { model: string; calls: number }[] }>(`/api/telemetry?since_ms=${Date.now() - RANGES[range]}`).then((r) => {
      const ids = r.by_model.map((m) => m.model);
      setUsed(ids);
      setMa((v) => v || ids[0] || "");
      setMb((v) => v || ids[1] || ids[0] || "");
    }).catch(reportError);
  }, [range]);
  const now = Date.now();
  const p = PRESETS[preset]!.bounds(now);
  const q = mode === "ranges"
    ? `a_since_ms=${p.a[0]}&a_until_ms=${p.a[1]}&b_since_ms=${p.b[0]}&b_until_ms=${p.b[1]}`
    : ma && mb ? `a_since_ms=${now - RANGES[range]}&b_since_ms=${now - RANGES[range]}&a_model=${encodeURIComponent(ma)}&b_model=${encodeURIComponent(mb)}` : null;
  const r = useReport<{ a: Side; b: Side }>(q && mode !== "turns" ? `/api/telemetry/compare?${q}` : null, [mode, preset, range, ma, mb]);
  // A name two used models share gets its provider, in the options and the heads.
  const name = (id: string) => (used.some((o) => o !== id && short(o) === short(id)) || (ma !== mb && short(ma) === short(mb) && (id === ma || id === mb)) ? `${short(id)} (${provider(id)})` : short(id));
  const select = (v: string, set: (v: string) => void, label: string) => (
    <Select aria-label={label} data-testid={`compare-${label}`} value={v} onChange={(e) => set(e.target.value)} className="h-8 max-w-[min(26rem,100%)] min-w-0 rounded-md border border-line-strong bg-raised px-2 text-ui text-fg">
      {used.map((id) => <option key={id} value={id}>{name(id)}</option>)}
    </Select>
  );
  const heads = mode === "ranges" ? ["This range", "The range before"] : [ma ? name(ma) : "A", mb ? name(mb) : "B"];
  const lower = new Set(["Failed or refused", "First token, median", "First token, 95th", "Request time, median", "Request time, 95th", "Cache breaks", "Tool failures", "Spend"]);
  const rows: [string, (s: Side) => number | null, (v: number | null) => string][] = [
    ["Requests", (s) => s.calls, (v) => String(v ?? 0)],
    ["Failed or refused", (s) => s.failed_share, fmtPct],
    ["First token, median", (s) => s.ttft_p50, fmtMs],
    ["First token, 95th", (s) => s.ttft_p95, fmtMs],
    ["Request time, median", (s) => s.latency_p50, fmtMs],
    ["Request time, 95th", (s) => s.latency_p95, fmtMs],
    ["Output speed", (s) => s.output_tokens_per_s, (v) => (v == null ? "none" : `${Math.round(v)} tokens/s`)],
    ["Cache hit rate", (s) => s.cache_hit_ratio, fmtPct],
    ["Cache breaks", (s) => s.breaks, (v) => String(v ?? 0)],
    ["Compactions", (s) => s.compactions, (v) => String(v ?? 0)],
    ["Tool failures", (s) => s.tool_error_rate, fmtPct],
  ];
  const rates = new Set(["Failed or refused", "Cache hit rate", "Tool failures"]);
  // Rates differ in points; counts and times by how many times; small moves in percent.
  const change = (label: string, a: number | null, b: number | null) => {
    if (a == null || b == null) return <span className="text-faint">none</span>;
    const better = (up: boolean) => (lower.has(label) ? !up : label === "Requests" || label === "Compactions" ? null : up);
    const tone = (up: boolean) => cn(better(up) === true && "text-ok", better(up) === false && "text-danger");
    if (rates.has(label)) {
      const d = Math.round((a - b) * 100);
      return d ? <span className={tone(d > 0)}>{d > 0 ? "+" : ""}{d} pts</span> : <span className="text-faint">same</span>;
    }
    if (b === 0) return a === 0 ? <span className="text-faint">same</span> : <span className="text-faint">new</span>;
    const r = a / b;
    if (Math.abs(r - 1) < 0.005) return <span className="text-faint">same</span>;
    const text = r >= 2 ? `${r < 10 ? r.toFixed(1) : Math.round(r)}x` : r <= 0.5 ? `${r < 0.1 ? r.toFixed(2) : r.toFixed(1)}x` : `${r > 1 ? "+" : ""}${Math.round((r - 1) * 100)}%`;
    return <span className={tone(r > 1)}>{text}</span>;
  };
  // Spend is known, a lower bound (some calls have no price) or unknown; a
  // ratio is claimed only between two known totals.
  const spend = (s: Side) => (s.unpriced_calls ? (s.priced_cost_usd ? `${fmtUsd(s.priced_cost_usd)}+` : "unknown") : fmtUsd(s.priced_cost_usd));
  const spendChange = (a: Side, b: Side) => (a.unpriced_calls || b.unpriced_calls ? <span className="text-faint" title="a call without a known price is in one of them">not comparable</span> : change("Spend", a.priced_cost_usd, b.priced_cost_usd));
  // A count of failures differs by how many more or fewer, not in points.
  const countChange = (a: number, b: number) => (a === b ? <span className="text-faint">same</span> : <span className={a > b ? "text-danger" : "text-ok"}>{a > b ? `${a - b} more` : `${b - a} fewer`}</span>);
  return (
    <div className="flex flex-col gap-4" data-testid="usage-compare">
      <div className="flex flex-wrap items-center gap-3">
        <Segmented<Mode> label="Compare" value={mode} onChange={setMode} options={[{ value: "ranges", label: "Two ranges" }, { value: "models", label: "Two models" }, { value: "turns", label: "Two turns" }]} />
        {mode === "turns" ? null : mode === "ranges" ? (
          <Select aria-label="ranges" data-testid="compare-preset" value={preset} onChange={(e) => setPreset(e.target.value)} className="h-8 max-w-full min-w-0 rounded-md border border-line-strong bg-raised px-2 text-ui text-fg">
            {Object.entries(PRESETS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </Select>
        ) : (
          <>
            {select(ma, setMa, "model-a")}<span className="text-ui text-muted">against</span>{select(mb, setMb, "model-b")}
            <Segmented<Range> label="Over" value={range} onChange={setRange} options={RANGE_OPTIONS} />
          </>
        )}
      </div>
      {mode === "turns" ? <TurnsCompare table={(heads, rows) => <CompareTable heads={heads} rows={rows} />} /> : (
      <Panel title="Side by side" hint={mode === "ranges" ? "this range against the one before; rates differ in points" : "the first model against the second; rates differ in points"} testid="compare-table">
        {!r ? <p className="text-ui text-faint">{mode === "models" && used.length < 1 ? "No model calls in this range." : "Reading the measurements."}</p> : (
          <CompareTable
            heads={heads}
            rows={[
              ...rows.map(([label, get, fmt]): CompareRow => [label, fmt(get(r.a)), fmt(get(r.b)), change(label, get(r.a), get(r.b))]),
              ["Spend", spend(r.a), spend(r.b), spendChange(r.a, r.b)],
              ...[...new Set([...Object.keys(r.a.classes), ...Object.keys(r.b.classes)])].map((c): CompareRow => [`${CLASS[c] ?? c}`, r.a.classes[c] ?? 0, r.b.classes[c] ?? 0, countChange(r.a.classes[c] ?? 0, r.b.classes[c] ?? 0)]),
            ]}
          />
        )}
      </Panel>
      )}
    </div>
  );
}

// The side by side table. With room it is four columns. In a panel narrower
// than 36rem (a phone, a large text size) each measurement is a block of its
// own: its name with the change beside it, then each side's value on a line
// that starts with the side's name, so nothing is read by panning. One table
// either way; the roles are written out because the narrow layout is not
// table layout.
type CompareRow = [label: string, a: ReactNode, b: ReactNode, change: ReactNode];
const SIDE = "px-4 py-1.5 text-right tabular-nums text-muted whitespace-nowrap @max-[36rem]:col-span-2 @max-[36rem]:flex @max-[36rem]:items-baseline @max-[36rem]:justify-between @max-[36rem]:gap-4 @max-[36rem]:p-0 @max-[36rem]:before:min-w-0 @max-[36rem]:before:whitespace-normal @max-[36rem]:before:text-left @max-[36rem]:before:text-caption @max-[36rem]:before:text-faint @max-[36rem]:before:content-[attr(data-side)] @max-[36rem]:before:[overflow-wrap:anywhere]";
function CompareTable({ heads, rows }: { heads: string[]; rows: CompareRow[] }) {
  return (
    <div className="@container relative -mx-4">
      <table role="table" className="w-full text-ui @max-[36rem]:block">
        <thead role="rowgroup" className="@max-[36rem]:sr-only">
          <tr role="row" className="border-b border-line text-caption text-faint">
            <th role="columnheader" className="px-4 py-1.5 text-left font-normal"><span className="sr-only">Measurement</span></th>
            {heads.map((h, i) => <th key={i} role="columnheader" className="px-4 py-1.5 text-right font-normal">{h}</th>)}
            <th role="columnheader" className="px-4 py-1.5 text-right font-normal">Change</th>
          </tr>
        </thead>
        <tbody role="rowgroup" className="@max-[36rem]:block">
          {rows.map(([label, a, b, change]) => (
            <tr key={label} role="row" className="border-b border-line/60 last:border-0 @max-[36rem]:grid @max-[36rem]:grid-cols-[minmax(0,1fr)_auto] @max-[36rem]:gap-x-4 @max-[36rem]:gap-y-1.5 @max-[36rem]:px-4 @max-[36rem]:py-3">
              <th role="rowheader" scope="row" className="max-w-64 truncate px-4 py-1.5 text-left font-normal @max-[36rem]:max-w-none @max-[36rem]:whitespace-normal @max-[36rem]:p-0 @max-[36rem]:font-medium">{label}</th>
              <td role="cell" data-side={heads[0]} className={SIDE}>{a}</td>
              <td role="cell" data-side={heads[1]} className={SIDE}>{b}</td>
              <td role="cell" className="px-4 py-1.5 text-right tabular-nums text-muted whitespace-nowrap @max-[36rem]:col-start-2 @max-[36rem]:row-start-1 @max-[36rem]:p-0">{change}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

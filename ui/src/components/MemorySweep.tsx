// The helper's daily sweep of the memory systems (src/helper/sweep.ts): how each system did over the
// last day, and up to three offered improvements. An offer changes something only when it is
// pressed; one that sends a note to the owner's memory store shows the command first.
// Settings > Usage, Memory, Sweep, and one quiet line in the helper's panel (MemorySweepLine).
import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { Card, Offer, System, SystemId } from "../../../src/helper/sweep.ts";
import { openMemory } from "../lib/integrations-ui.ts";
import { api, reportError } from "../lib/store.ts";
import { clock, fmtTokens } from "../lib/utils.ts";
import { confirmAction } from "./Confirm.tsx";
import { Cell, Empty, Group, Item, List, Row, Status, Table } from "./settings/kit.tsx";

type Answer = { card: Card | null; history: { id: string; ts: number; helped: Partial<Record<SystemId, number | null>> }[]; running: boolean };
const pct = (v: number | null) => (v === null ? null : `${Math.round(v * 100)}%`);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// What a system gave and what was used of it, in words; the numbers are the card's.
export function said(s: System): { gave: string; used: string } {
  const f = s.figures;
  if (s.id === "tacit") return { gave: `${plural(f.recalls!, "recall")}, ${plural(f.facts!, "fact")}, ${fmtTokens(f.tokens!)} tokens`, used: f.checked ? `${f.named} of ${f.checked} facts named${f.rules ? `; ${f.followed} of ${plural(f.rules, "rule")} followed, ${f.broken} broken` : ""}` : "nothing to judge yet" };
  if (s.id === "helper") return { gave: `${plural(f.recalls!, "recall")}; ${plural(f.records!, "record")} kept`, used: f.checked ? `${f.recalls_used} of ${f.checked} recalls used; ${f.stale} stale` : `nothing recalled; ${f.stale} stale` };
  if (s.id === "momentum") return { gave: plural(f.acts!, "nudge"), used: f.ended! + f.interrupted! + f.failed! ? `${f.ended} ended on their own, ${f.interrupted} stopped, ${f.failed} failed` : "nothing followed yet" };
  const m = s.measure;
  return { gave: s.on ? `loaded in ${plural(f.sessions!, "session")}; ${plural(f.notes!, "note")}` : (s.note ?? "off"), used: [m?.given ? `${m.used} of ${m.given} facts used` : "", f.sessions ? `${f.accessed ?? 0} of ${plural(f.sessions, "session")} opened its files` : ""].filter(Boolean).join("; ") || "no session loaded it" };
}

// A card made before the four figures were kept has none: its rows show nothing there.
const repeats = (s: System) => (s.measure && (s.measure.given || s.measure.mistakes) ? (s.measure.mistakes ? plural(s.measure.mistakes, "repeat") : "none") : undefined);
const cost = (s: System) => (s.measure && s.measure.tokens ? `${fmtTokens(s.measure.tokens)} tokens` : undefined);

// The helper's panel: one quiet line of the latest card, its details in Settings.
export function MemorySweepLine() {
  const [a, setA] = useState<Answer | null>(null);
  useEffect(() => { void api<Answer>("/api/memory/sweep").then(setA, reportError); }, []);
  const c = a?.card;
  const parts = (c?.systems ?? []).filter((s) => s.measure && (s.measure.given || s.measure.mistakes)).map((s) => {
    const m = s.measure!;
    return `${s.short ?? s.label} ${m.given ? `${Math.round((100 * m.used) / m.given)}%` : "none judged"}${m.mistakes ? `, ${plural(m.mistakes, "repeat")}` : ""}`;
  });
  return (
    <p className="text-caption text-muted" data-testid="sweep-line">
      <span className="text-fg">Memory</span>{" "}
      {!a ? "reading the last sweep" : !c ? "not swept yet" : parts.length ? `used yesterday: ${parts.join(", ")}` : "nothing recalled to judge yesterday"}
      {" "}<button type="button" className="k-link hover:underline" data-testid="sweep-line-open" onClick={() => openMemory(undefined, "sweep")}>Details</button>
    </p>
  );
}

function OfferItem({ o, onChange }: { o: Offer; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const base = `/api/memory/sweep/offers/${encodeURIComponent(o.id)}`;
  const apply = async () => {
    setBusy(true);
    setErr("");
    try {
      const r = await api<{ offer?: Offer; preview?: { state: string; id?: string; words?: string[]; note?: string; writer?: string; error?: string } }>(`${base}/apply`, { method: "POST", body: "{}" });
      const p = r.preview;
      if (p) {
        if (p.state !== "confirm" || !p.id) return setErr(p.error ? `The store did not take it: ${p.error.slice(0, 200)}` : `The store did not take it (${p.state}).`);
        const ok = await confirmAction({ title: "Send this note to the memory store?", body: "Keel runs the store's own command:", code: p.words, after: [p.writer ?? "", p.note ?? ""].filter(Boolean), action: "Send note", careful: true });
        if (!ok) return;
        const done = await api<{ state: string; error?: string }>(`${base}/confirm`, { method: "POST", body: JSON.stringify({ confirm: p.id }) });
        if (done.state !== "ok") return setErr(`Not sent (${done.state})${done.error ? `: ${done.error.slice(0, 200)}` : ""}.`);
      }
      onChange();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const dismiss = () => api(`${base}/dismiss`, { method: "POST", body: "{}" }).then(onChange, reportError);
  const open = o.state === "open";
  return (
    <Item name={o.title} sub={o.state === "applied" ? o.done : o.why} testid="sweep-offer" data-kind={o.kind} data-state={o.state}
      status={open ? undefined : <Status tone={o.state === "applied" ? "ok" : "quiet"}>{o.state === "applied" ? "Applied" : "Left alone"}</Status>}
      actions={open ? <>
        <button type="button" className="k-btn" data-ink disabled={busy} data-testid="sweep-apply" onClick={apply}>{busy ? "Applying" : o.kind === "tacit_note" ? "Review the note" : "Apply"}</button>
        <button type="button" className="k-btn" data-quiet disabled={busy} data-testid="sweep-dismiss" onClick={dismiss}>Leave it</button>
      </> : undefined}>
      {err && <p className="text-caption text-danger" role="alert" data-testid="sweep-error">{err}</p>}
    </Item>
  );
}

export function MemorySweep() {
  const [a, setA] = useState<Answer | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api<Answer>("/api/memory/sweep").then(setA, reportError), []);
  useEffect(() => { void load(); }, [load]);
  const run = () => { setBusy(true); api<Answer>("/api/memory/sweep/run", { method: "POST", body: "{}" }).then(setA, reportError).finally(() => setBusy(false)); };
  if (!a) return <p className="text-caption text-faint" data-testid="sweep-loading">Reading the last sweep</p>;
  const c = a.card;
  const aside = <button type="button" className="k-btn" data-quiet disabled={busy || a.running} data-testid="sweep-run" onClick={run}><RefreshCw className={busy ? "animate-spin" : undefined} />{busy ? "Sweeping" : "Sweep now"}</button>;
  if (!c) return <Group title="Daily sweep" hint="once a day, the helper reads how each memory system did" actions={aside} testid="sweep-card"><Empty testid="sweep-none">No sweep yet. The first one runs a few minutes after the daemon starts, then once a day.</Empty></Group>;
  const open = c.offers.filter((o) => o.state === "open").length;
  const cols = [{ head: "System", grow: true }, { head: "Gave", minor: true }, { head: "Used", minor: true }, { head: "Repeated", minor: true }, { head: "Cost", minor: true }, { head: "Helped", end: true }];
  return (
    <div className="flex flex-col gap-4" data-testid="sweep-card" data-offers={open}>
      <Group title="Daily sweep" hint={`${clock(c.since, { date: true })} to ${clock(c.until, { date: true })}`} actions={aside}
        help={<>The helper reads Keel's own records once a day: what each memory system gave, what the model then used of it in its next steps, the mistakes a note forbids that a session made anyway, and what the recall cost in tokens. Helped is the share used. Each system's best next step is under it. Nothing is asked of a model and nothing changes until you press an offer.</>}>
        <Table cols={cols} label="Memory systems over the last day" testid="sweep-systems">
          {c.systems.map((s) => {
            const w = said(s);
            return (
              <Row key={s.id} name={s.label} testid="sweep-system" data-system={s.id}
                detail={s.next ? <p className="text-caption text-muted" data-testid="sweep-next" data-system={s.id}>Next: {s.next.text}</p> : undefined}>
                <Cell col={cols[1]!}>{w.gave}</Cell>
                <Cell col={cols[2]!}>{w.used}</Cell>
                <Cell col={cols[3]!}><span data-testid="sweep-repeats">{repeats(s)}</span></Cell>
                <Cell col={cols[4]!}>{cost(s)}</Cell>
                <Cell col={cols[5]!}>{s.helped === null ? <Status tone="quiet">{s.on || s.figures.acts || s.figures.sessions ? "None yet" : "Off"}</Status> : <span data-testid="sweep-helped">{pct(s.helped)}</span>}</Cell>
              </Row>
            );
          })}
        </Table>
      </Group>
      <Group title="Offered" count={open} hint="each changes something only when you press it">
        {c.offers.length ? <List testid="sweep-offers">{c.offers.map((o) => <OfferItem key={o.id} o={o} onChange={load} />)}</List>
          : <Empty testid="sweep-no-offers">Nothing to offer: no stale record, unused rule or untidy index showed in this window.</Empty>}
      </Group>
    </div>
  );
}

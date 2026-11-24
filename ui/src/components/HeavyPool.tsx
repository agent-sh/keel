// Settings > Resources: the heavy-command pool (src/tools/heavy.ts). Test
// suites, builds and browsers take a slot of one pool for the whole daemon;
// with none free a command's tool call waits in line. This shows the room the
// machine has, what holds a slot, who waits and why, and the owner's patterns.
import { useEffect, useState } from "react";
import { Plus, X } from "lucide-react";
import { api, failed, useStore } from "../lib/store.ts";
import { navigate } from "../lib/ui.ts";
import { cn } from "../lib/utils.ts";
import { Stat, Stats } from "./Stat.tsx";
import { Cell, Disclosure, Group, Page, Row, Table, type Col } from "./settings/kit.tsx";
import { fmtMs } from "./UsagePanel.tsx";

type Pattern = { pattern: string; cores: number; memory_mb: number };
export type HeavyView = {
  config: { patterns: (string | Pattern)[]; load_share: number; free_mb: number; cost: { cores: number; memory_mb: number; ramp_s: number }; slots: number | null };
  machine: { cores: number; load1: number; runnable: number | null; mem_available_mb: number };
  room: { slots: number; free: number; limit: number; busy: number; cause: string; why: string };
  held: { session_id: string; who: string; command: string; pattern: string; cores: number; since: number; ms: number }[];
  line: { place: number; session_id: string; who: string; command: string; pattern: string; cores: number; since: number; ms: number }[];
  quiet_freed?: number;
};

const WHO: Record<string, string> = { owner: "you", session: "session", agent: "agent" };
const gb = (mb: number) => `${(mb / 1024).toFixed(mb < 10_240 ? 1 : 0)} GB`;
const ghost = "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-caption text-muted hover:bg-hover hover:text-fg disabled:opacity-50 [&>svg]:size-3.5";

export function HeavyPool({ v }: { v: HeavyView }) {
  const sessions = useStore((s) => s.sessions);
  const title = (id: string) => sessions[id]?.title || "a session";
  const mine = v.held.filter((h) => h.who === "owner").length;
  const theirs = v.held.length - mine;
  const rows = [...v.held.map((h) => ({ ...h, state: "running" as const, place: 0 })), ...v.line.map((l) => ({ ...l, state: "waiting" as const }))];
  const C: Record<string, Col> = { command: { head: "Command", grow: true }, session: { head: "Session" }, state: { head: "State" }, cores: { head: "Cores", end: true, minor: true }, ms: { head: "For", end: true, minor: true } };
  return (
    <Page testid="heavy-pool">
      <Group title="Heavy commands" bare hint={<>
        <p>Test suites, builds and browsers take a slot of one pool before they start. With none free, the call waits in line and spends nothing.</p>
        <Disclosure summary="Who waits and who does not">
          <p>Commands you type in a terminal pane never wait. A command your own session's model runs goes before an agent's in line, but can still wait for agents' commands that already run.</p>
          <p>A watcher or a server left up (--watch, serve, dev) takes no slot, and a command that has gone quiet while others wait gives its slot back.</p>
        </Disclosure>
      </>}>
        <Stats>
          <Stat testid="heavy-slots" label="Slots in use" value={`${theirs} of ${v.room.slots}`} sub={mine ? `and ${mine} of yours, which never wait${mine === 1 ? "s" : ""}` : v.config.slots ? "a fixed number" : "sized from the machine and each command's cost"} />
          <Stat testid="heavy-line" label="In line" value={v.line.length} sub={v.line.length ? v.room.why : v.quiet_freed ? `nobody in line; ${v.quiet_freed} quiet ${v.quiet_freed === 1 ? "command" : "commands"} gave a slot back` : "nobody in line"} />
          <Stat label="Busy cores" value={`${v.room.busy.toFixed(1)} of ${v.room.limit.toFixed(1)}`} sub={`${v.machine.cores} cores, load ${v.machine.load1.toFixed(1)}`} />
          <Stat label="Free memory" value={gb(v.machine.mem_available_mb)} sub={`keeps ${gb(v.config.free_mb)} free`} />
        </Stats>
      </Group>
      {rows.length > 0 && (
        <Group title="In the pool" count={rows.length}>
          <Table cols={Object.values(C)} label="Heavy commands">
            {rows.map((r, i) => (
              <Row key={`${r.state}-${r.session_id}-${i}`} testid={`heavy-${r.state}`} title={r.command} name={<span className="font-mono text-caption">{r.command}</span>}>
                <Cell col={C.session!}>
                  <button type="button" onClick={() => navigate({ name: "session", id: r.session_id })} className="k-link max-w-60 truncate align-bottom text-accent hover:underline">{title(r.session_id)}</button>
                  <span className="ml-1.5 text-caption text-faint">{WHO[r.who] ?? r.who}</span>
                </Cell>
                <Cell col={C.state!} className={r.state === "waiting" ? "text-warn" : "text-muted"}>{r.state === "running" ? "has a slot" : `in line, place ${r.place}`}</Cell>
                <Cell col={C.cores!} className="text-muted">{r.cores}</Cell>
                <Cell col={C.ms!} className="text-muted">{fmtMs(r.ms)}</Cell>
              </Row>
            ))}
          </Table>
        </Group>
      )}
      <Patterns patterns={v.config.patterns.map((p) => (typeof p === "string" ? { pattern: p, cores: v.config.cost.cores, memory_mb: v.config.cost.memory_mb } : p))} slots={v.config.slots} />
    </Page>
  );
}

// The owner's patterns, a regular expression a row matched from the start of
// each command of a line, each with what its command is counted at; and a
// fixed number of slots, or none to size the pool from the machine.
type Row = { pattern: string; cores: string; gb: string };
const rowsOf = (ps: Pattern[]): Row[] => ps.map((p) => ({ pattern: p.pattern, cores: String(p.cores), gb: String(Math.round((p.memory_mb / 1024) * 10) / 10) }));
function Patterns({ patterns, slots }: { patterns: Pattern[]; slots: number | null }) {
  const saved = JSON.stringify(patterns);
  const [rows, setRows] = useState<Row[]>(() => rowsOf(patterns));
  const [fixed, setFixed] = useState(slots === null ? "" : String(slots));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // What the daemon holds now, unless the owner is editing it.
  const [base, setBase] = useState(saved);
  useEffect(() => { setRows((r) => (JSON.stringify(parse(r)) === base ? rowsOf(patterns) : r)); setBase(saved); }, [saved]);
  useEffect(() => { setFixed(slots === null ? "" : String(slots)); }, [slots]);
  const edit = (i: number, k: keyof Row, val: string) => setRows((r) => r.map((x, j) => (j === i ? { ...x, [k]: val } : x)));
  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const list = parse(rows);
      const n = fixed.trim() ? Number(fixed) : null;
      await api("/api/settings", { method: "PATCH", body: JSON.stringify({ heavy: { patterns: list, slots: n } }) });
      setBase(JSON.stringify(list));
      setMsg({ ok: true, text: "Saved. It applies to the next command." });
    } catch (e) {
      setMsg({ ok: false, text: failed(e, { at: "heavy patterns" }) });
    } finally {
      setBusy(false);
    }
  };
  const cell = "k-field h-7 py-0 text-caption";
  return (
    <Group testid="heavy-patterns" title="Heavy patterns" pad hint="A regular expression a row, matched from the start of each command (wrappers such as env, nice and timeout taken off), and what the command is counted at: its peak cores and memory. A command run over ssh is not counted here.">
      <div className="grid grid-cols-[minmax(0,1fr)_3.5rem_4.5rem_2rem] items-center gap-x-2 gap-y-1.5">
        <span className="text-caption text-faint">Pattern</span><span className="text-caption text-faint">Cores</span><span className="text-caption text-faint">Memory (GB)</span><span />
        {rows.map((r, i) => (
          <div key={i} className="contents" data-testid="heavy-pattern">
            <input aria-label={`Pattern ${i + 1}`} spellCheck={false} className={cn(cell, "font-mono")} value={r.pattern} onChange={(e) => edit(i, "pattern", e.target.value)} />
            <input aria-label={`Cores of pattern ${i + 1}`} inputMode="decimal" className={cn(cell, "tabular-nums")} value={r.cores} onChange={(e) => edit(i, "cores", e.target.value.replace(/[^0-9.]/g, ""))} />
            <input aria-label={`Memory of pattern ${i + 1}`} inputMode="decimal" className={cn(cell, "tabular-nums")} value={r.gb} onChange={(e) => edit(i, "gb", e.target.value.replace(/[^0-9.]/g, ""))} />
            <button type="button" className={cn(ghost, "hover:text-danger")} aria-label={`Remove pattern ${i + 1}`} onClick={() => setRows((x) => x.filter((_, j) => j !== i))}><X /></button>
          </div>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <button type="button" className={ghost} data-testid="heavy-add" onClick={() => setRows((x) => [...x, { pattern: "", cores: "3", gb: "1" }])}><Plus />Add a pattern</button>
        <span className="flex-1" />
        <span className="flex items-center gap-2">
          <label htmlFor="heavy-fixed" className="text-ui text-muted">Slots</label>
          <input id="heavy-fixed" data-testid="heavy-fixed" inputMode="numeric" placeholder="from the machine" className="k-field w-40" value={fixed} onChange={(e) => setFixed(e.target.value.replace(/[^0-9]/g, ""))} />
        </span>
        <button type="button" className="k-btn" data-ink="" disabled={busy} onClick={save} data-testid="heavy-save">{busy ? "Saving" : "Save"}</button>
        {msg && <span className={cn("text-caption", msg.ok ? "text-muted" : "text-danger")} data-testid="heavy-msg">{msg.text}</span>}
      </div>
    </Group>
  );
}

// The rows as the daemon's patterns: an empty row left out, memory in MB.
const parse = (rows: Row[]): Pattern[] =>
  rows.filter((r) => r.pattern.trim()).map((r) => ({ pattern: r.pattern.trim(), cores: Number(r.cores) || 0, memory_mb: Math.round((Number(r.gb) || 0) * 1024) }));

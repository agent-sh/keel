// Settings > Resources: the heavy-command pool (src/tools/heavy.ts). Test
// suites, builds and browsers take a slot of one pool for the whole daemon;
// with none free a command's tool call waits in line. This shows the room the
// machine has, what holds a slot, who waits and why, and the owner's patterns.
import { useEffect, useState } from "react";
import { api, failed, useStore } from "../lib/store.ts";
import { navigate } from "../lib/ui.ts";
import { cn } from "../lib/utils.ts";
import { Stat, Stats } from "./Stat.tsx";
import { fmtMs } from "./UsagePanel.tsx";

export type HeavyView = {
  config: { patterns: string[]; load_share: number; free_mb: number; cost: { cores: number; memory_mb: number; ramp_s: number }; slots: number | null };
  machine: { cores: number; load1: number; runnable: number | null; mem_available_mb: number };
  room: { slots: number; free: number; limit: number; busy: number; cause: string; why: string };
  held: { session_id: string; who: string; command: string; pattern: string; since: number; ms: number }[];
  line: { place: number; session_id: string; who: string; command: string; pattern: string; since: number; ms: number }[];
};

const th = "px-4 py-1.5 font-normal whitespace-nowrap";
const td = "px-4 py-1.5 tabular-nums whitespace-nowrap";
const WHO: Record<string, string> = { owner: "you", session: "session", agent: "agent" };
const gb = (mb: number) => `${(mb / 1024).toFixed(mb < 10_240 ? 1 : 0)} GB`;

export function HeavyPool({ v }: { v: HeavyView }) {
  const sessions = useStore((s) => s.sessions);
  const title = (id: string) => sessions[id]?.title || "a session";
  const mine = v.held.filter((h) => h.who === "owner").length;
  const theirs = v.held.length - mine;
  const rows = [...v.held.map((h) => ({ ...h, state: "running" as const, place: 0 })), ...v.line.map((l) => ({ ...l, state: "waiting" as const }))];
  return (
    <section className="rounded-lg border border-line bg-raised p-4 shadow-1" data-testid="heavy-pool">
      <h3 className="mb-1 text-base font-medium">Heavy commands</h3>
      <p className="mb-3 text-caption text-faint">
        Test suites, builds and browsers take a slot of one pool before they start. With none free, the call waits in line and spends nothing; your own commands never wait.
      </p>
      <Stats>
        <Stat testid="heavy-slots" label="Slots in use" value={`${theirs} of ${v.room.slots}`} sub={mine ? `and ${mine} of yours, which never wait${mine === 1 ? "s" : ""}` : v.config.slots ? "a fixed number" : `at most ${Math.max(1, Math.floor(v.room.limit / v.config.cost.cores))}, sized from the machine`} />
        <Stat testid="heavy-line" label="In line" value={v.line.length} sub={v.line.length ? v.room.why : "nobody in line"} />
        <Stat label="Busy cores" value={`${v.room.busy.toFixed(1)} of ${v.room.limit.toFixed(1)}`} sub={`${v.machine.cores} cores, load ${v.machine.load1.toFixed(1)}`} />
        <Stat label="Free memory" value={gb(v.machine.mem_available_mb)} sub={`keeps ${gb(v.config.free_mb)} free`} />
      </Stats>
      {rows.length > 0 && (
        <div className="-mx-4 mt-3 overflow-x-auto">
          <table className="w-full text-ui">
            <thead>
              <tr className="border-b border-line text-left text-caption text-faint">
                <th className={th}>Command</th><th className={th}>Session</th><th className={th}>State</th><th className={cn(th, "text-right")}>For</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={`${r.state}-${r.session_id}-${i}`} className="border-b border-line/60 last:border-0" data-testid={`heavy-${r.state}`}>
                  <td className={cn(td, "max-w-96")}><div className="truncate font-mono text-caption" title={r.command}>{r.command}</div></td>
                  <td className={cn(td, "max-w-60")}>
                    <button type="button" onClick={() => navigate({ name: "session", id: r.session_id })} className="k-link truncate text-accent hover:underline">{title(r.session_id)}</button>
                    <span className="ml-1.5 text-caption text-faint">{WHO[r.who] ?? r.who}</span>
                  </td>
                  <td className={cn(td, r.state === "waiting" ? "text-warn" : "text-muted")}>{r.state === "running" ? "has a slot" : `in line, place ${r.place}`}</td>
                  <td className={cn(td, "text-right text-muted")}>{fmtMs(r.ms)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Patterns patterns={v.config.patterns} slots={v.config.slots} />
    </section>
  );
}

// The owner's patterns, one regular expression a line, matched from the start
// of each command of a line; and a fixed number of slots, or none to size the
// pool from the machine.
function Patterns({ patterns, slots }: { patterns: string[]; slots: number | null }) {
  const [text, setText] = useState(patterns.join("\n"));
  const [fixed, setFixed] = useState(slots === null ? "" : String(slots));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const saved = patterns.join("\n");
  // What the daemon holds now, unless the owner is editing it.
  const [base, setBase] = useState(saved);
  useEffect(() => { if (text === base) setText(saved); setBase(saved); }, [saved]);
  useEffect(() => { setFixed(slots === null ? "" : String(slots)); }, [slots]);
  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const list = text.split("\n").map((l) => l.trim()).filter(Boolean);
      const n = fixed.trim() ? Number(fixed) : null;
      await api("/api/settings", { method: "PATCH", body: JSON.stringify({ heavy: { patterns: list, slots: n } }) });
      setBase(list.join("\n"));
      setMsg({ ok: true, text: "Saved. It applies to the next command." });
    } catch (e) {
      setMsg({ ok: false, text: failed(e, { at: "heavy patterns" }) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-4 border-t border-line pt-4">
      <label htmlFor="heavy-patterns" className="text-ui font-medium">Heavy patterns</label>
      <p className="mt-0.5 text-caption text-muted">One regular expression a line, matched from the start of each command (wrappers such as env, nice and timeout taken off). A command run over ssh is not counted here.</p>
      <textarea
        id="heavy-patterns"
        data-testid="heavy-patterns"
        spellCheck={false}
        className="k-field mt-2 h-auto min-h-[9rem] w-full resize-y py-1.5 font-mono text-caption"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <label htmlFor="heavy-fixed" className="text-ui text-muted">Slots</label>
        <input id="heavy-fixed" data-testid="heavy-fixed" inputMode="numeric" placeholder="from the machine" className="k-field w-40" value={fixed} onChange={(e) => setFixed(e.target.value.replace(/[^0-9]/g, ""))} />
        <button type="button" className="k-btn" data-ink="" disabled={busy} onClick={save} data-testid="heavy-save">{busy ? "Saving" : "Save"}</button>
        {msg && <span className={cn("text-caption", msg.ok ? "text-muted" : "text-danger")} data-testid="heavy-msg">{msg.text}</span>}
      </div>
    </div>
  );
}

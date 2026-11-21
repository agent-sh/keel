// Side panel: every command the session ran, newest first. How each ended,
// its output with the program's colors, the ones running or in the background
// with their output streaming in, and the owner's stop, copy and re-run. A
// command line at the foot runs the owner's own command in the session's folder.
import { copyText } from "../lib/copy.ts";
import { Tabs } from "@base-ui/react/tabs";
import { Check, ChevronRight, Copy, Play, RotateCw, Square, SquareTerminal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { stripAnsiText } from "../../../src/core/ansi.ts";
import { Ansi } from "./Ansi.tsx";
import type { Session } from "../../../src/core/types.ts";
import { api, reportError, useStore } from "../lib/store.ts";
import { cn } from "../lib/utils.ts";

type Entry = {
  key: string; call_id?: string; tool?: string; by: "model" | "owner"; command: string; description?: string; cwd?: string;
  machine?: string; started: number; ended?: number; state: "running" | "background" | "ok" | "failed" | "stopped";
  exit_code?: number | null; signal?: string | null; reason?: string; job_id?: string; bytes?: number; output: string; output_from?: number; last?: string;
  log_missing?: boolean;
};
type Filter = "all" | "running" | "failed";

const live = (e: Entry) => e.state === "running" || e.state === "background";
const TONE: Record<Entry["state"], string> = { running: "bg-st-work", background: "bg-st-work", ok: "bg-st-done", failed: "bg-st-fail", stopped: "bg-st-idle" };

function took(e: Entry, now: number) {
  const ms = (e.ended ?? now) - e.started;
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 1 ? `${ms} ms` : s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}
function ending(e: Entry) {
  if (e.state === "background") return "in the background";
  if (e.state === "running") return "running";
  if (e.state === "stopped") return e.reason ?? (e.signal ? `killed by ${e.signal}` : "stopped");
  if (e.exit_code !== undefined && e.exit_code !== null) return `exit ${e.exit_code}`;
  return e.state === "failed" ? "failed" : "done";
}


// The output of one command: what the list carried, then what a running one
// prints from there on.
function Output({ session, e }: { session: string; e: Entry }) {
  // Seeded once; a command running at the start is followed from its log,
  // and the list's later copies of its tail are not added again.
  const [own, setOwn] = useState<string | null>(live(e) && e.job_id ? e.output : null);
  const at = useRef<number>((e.output_from ?? 0) + new TextEncoder().encode(e.output).length);
  const follow = own !== null;
  useEffect(() => {
    if (!follow) return;
    let stop = false;
    let t: Timer | undefined;
    // Reads go on from where the last one ended until caught up; a burst too
    // big to show is skipped with a marker that says how many bytes, never
    // joined as if its two ends were one.
    const get = (from: number) => api<{ text: string; from: number; to: number; size: number; running: boolean }>(`/api/sessions/${session}/terminal/${e.job_id}/log?from=${from}`);
    const pull = async () => {
      try {
        let r = await get(at.current);
        for (let n = 0; !stop; n++) {
          let add = r.text;
          if (r.from > at.current) add = `\n[${r.from - at.current} bytes skipped: the whole output is in the log]\n${add}`;
          if (r.to > at.current) { setOwn((m) => (m ?? "") + add); at.current = r.to; }
          if (r.to >= r.size) break;
          // Far behind: jump to the last read's worth and mark the gap.
          r = await get(n >= 15 ? Math.max(r.to, r.size - 64 * 1024) : r.to);
        }
        if (!stop && r.running) t = setTimeout(pull, 1000);
      } catch (err) { if ((err as any)?.status !== 404) reportError(err, { at: "terminal log" }); }
    };
    t = setTimeout(pull, 500);
    return () => { stop = true; clearTimeout(t); };
  }, [follow, e.job_id, session]);
  const pre = useRef<HTMLPreElement>(null);
  const text = own ?? e.output;
  useEffect(() => { const p = pre.current; if (p && follow) p.scrollTop = p.scrollHeight; }, [text, follow]);
  return (
    <pre ref={pre} data-testid="term-output" className="max-h-80 overflow-auto whitespace-pre-wrap break-words border-t border-line bg-code-bg px-3 py-2 font-mono text-micro leading-relaxed text-fg">
      {(e.output_from ?? 0) > 0 && <span className="text-faint">[earlier output is in the log]{"\n"}</span>}
      {text ? <Ansi text={text} /> : <span className="text-faint" data-testid="term-no-output">{e.log_missing ? "Output log unavailable." : live(e) ? "No output yet." : "No output."}</span>}
    </pre>
  );
}

function Row({ session, e, now, open, onToggle, onRun }: { session: string; e: Entry; now: number; open: boolean; onToggle: () => void; onRun: (cmd: string, cwd?: string) => void }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await copyText(stripAnsiText(e.output));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) { reportError(err, { at: "terminal copy" }); }
  };
  const stop = () => api(`/api/sessions/${session}/terminal/${e.job_id}/stop`, { method: "POST" }).catch(reportError);
  return (
    <li className="border-b border-line" data-testid="term-entry" data-state={e.state} data-key={e.key}>
      <div className="group flex items-start gap-2 px-3 py-2">
        <button type="button" onClick={onToggle} aria-expanded={open} data-testid="term-toggle" className="flex min-w-0 flex-1 items-start gap-2 text-left outline-none">
          <ChevronRight className={cn("mt-0.5 size-3.5 shrink-0 text-faint transition-transform", open && "rotate-90")} />
          <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", TONE[e.state], live(e) && "animate-pulse")} />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-mono text-caption text-fg" title={e.command} data-testid="term-command">{e.command}</span>
            <span className="flex flex-wrap items-center gap-x-2 text-micro text-faint">
              <span data-testid="term-ending" className={cn(e.state === "failed" && "text-danger")}>{ending(e)}</span>
              <span className="tabular-nums">{took(e, now)}</span>
              {e.by === "owner" && <span data-testid="term-by-owner" className="text-accent-ink">you</span>}
              {e.machine && <span data-testid="term-machine">on {e.machine}</span>}
              {e.description && <span className="truncate">{e.description}</span>}
            </span>
            {live(e) && e.last && <span className="mt-0.5 block truncate font-mono text-micro text-muted" data-testid="term-last">{e.last}</span>}
          </span>
        </button>
        <span className="flex shrink-0 items-center gap-0.5">
          {live(e) && e.job_id && (
            <button type="button" title="Stop" data-testid="term-stop" onClick={stop} className="grid size-6 place-items-center rounded-md text-faint hover:bg-danger-soft hover:text-danger"><Square className="size-3" /></button>
          )}
          <button type="button" title={copied ? "Copied" : "Copy the output"} data-testid="term-copy" data-copied={copied || undefined} onClick={copy} className="grid size-6 place-items-center rounded-md text-faint hover:bg-hover hover:text-fg">
            {copied ? <Check className="size-3.5 text-ok" /> : <Copy className="size-3.5" />}
          </button>
          <button type="button" title="Run it again" data-testid="term-rerun" onClick={() => onRun(e.command, e.cwd)} className="grid size-6 place-items-center rounded-md text-faint hover:bg-hover hover:text-fg"><RotateCw className="size-3.5" /></button>
        </span>
      </div>
      {open && <Output session={session} e={e} />}
    </li>
  );
}

export function TerminalPanel({ session }: { session: Session }) {
  const id = session.id;
  const [list, setList] = useState<Entry[] | null>(null);
  const [note, setNote] = useState<string>();
  const [filter, setFilter] = useState<Filter>("all");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [cmd, setCmd] = useState("");
  const [now, setNow] = useState(Date.now());
  const events = useStore((s) => s.events[id]?.length ?? 0);
  const working = useStore((s) => s.sessions[id]?.phase === "working");
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let stop = false;
    let t: Timer | undefined;
    const load = async () => {
      try {
        const r = await api<{ commands?: Entry[]; note?: string }>(`/api/sessions/${id}/terminal`);
        if (stop) return;
        const cs = r.commands ?? [];
        setList(cs);
        setNote(r.note);
        setNow(Date.now());
        if (working || cs.some(live)) t = setTimeout(load, 1500);
      } catch (e) {
        if ((e as any)?.status === 404) setList([]);
        else reportError(e, { at: "terminal" });
      }
    };
    load();
    return () => { stop = true; clearTimeout(t); };
  }, [id, events, working, tick]);
  const run = async (command: string, cwd?: string) => {
    const c = command.trim();
    if (!c) return;
    try {
      const r = await api<{ job: { id: string } }>(`/api/sessions/${id}/terminal/run`, { method: "POST", body: JSON.stringify({ command: c, cwd }) });
      setOpen((o) => new Set(o).add(r.job.id));
      setFilter("all");
      setTick((x) => x + 1);
    } catch (e) { reportError(e, { at: "terminal run" }); }
  };
  const all = list ?? [];
  const counts = { all: all.length, running: all.filter(live).length, failed: all.filter((e) => e.state === "failed").length };
  const shown = all.filter((e) => filter === "all" || (filter === "running" ? live(e) : e.state === "failed")).slice().reverse();
  const toggle = (k: string) => setOpen((o) => { const n = new Set(o); n.has(k) ? n.delete(k) : n.add(k); return n; });
  return (
    // The filters are tabs of the one list: one Tab stop on the filter
    // chosen, Left and Right move to the next one and show its commands.
    <Tabs.Root value={filter} onValueChange={(v) => setFilter(v as Filter)} className="flex h-full min-h-0 flex-col" data-testid="terminal-panel">
      <Tabs.List activateOnFocus aria-label="Which commands" className="flex items-center gap-1 border-b border-line px-3 py-2">
        {(["all", "running", "failed"] as Filter[]).map((f) => (
          <Tabs.Tab
            key={f}
            value={f}
            data-testid={`term-filter-${f}`}
            className={cn("inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-caption capitalize", filter === f ? "bg-accent-soft text-fg" : "text-muted hover:bg-hover hover:text-fg")}
          >
            {f}
            <span className={cn("tabular-nums text-micro", f === "failed" && counts.failed ? "text-danger" : "text-faint")}>{counts[f]}</span>
          </Tabs.Tab>
        ))}
      </Tabs.List>
      {note && <p className="border-b border-line px-3 py-1.5 text-micro text-warn">{note}</p>}
      <Tabs.Panel value={filter} className="k-ring-in min-h-0 flex-1 overflow-auto">
      <ul data-testid="term-list">
        {list && !shown.length && (
          <li className="flex flex-col items-center gap-2 px-6 py-10 text-center text-ui text-faint">
            <SquareTerminal className="size-5" />
            {filter === "running" ? "Nothing is running." : filter === "failed" ? "No command failed." : "No command ran in this session yet."}
          </li>
        )}
        {shown.map((e) => (
          <Row key={e.key} session={id} e={e} now={now} open={open.has(e.key) || (!!e.job_id && open.has(e.job_id))} onToggle={() => toggle(e.key)} onRun={run} />
        ))}
      </ul>
      </Tabs.Panel>
      <form
        className="flex items-center gap-2 border-t border-line px-3 py-2"
        onSubmit={(ev) => { ev.preventDefault(); run(cmd).then(() => setCmd("")); }}
      >
        <span className="font-mono text-caption text-faint">$</span>
        <input
          value={cmd}
          onChange={(ev) => setCmd(ev.target.value)}
          placeholder={`Run a command in ${session.workspace.split("/").pop() || "the session's folder"}`}
          aria-label="Command"
          data-testid="term-input"
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent font-mono text-caption text-fg outline-none placeholder:text-faint"
        />
        <button type="submit" title="Run" data-testid="term-run" disabled={!cmd.trim()} className="grid size-7 place-items-center rounded-md text-faint hover:bg-hover hover:text-fg disabled:opacity-40"><Play className="size-3.5" /></button>
      </form>
    </Tabs.Root>
  );
}

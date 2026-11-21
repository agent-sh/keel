// Settings > Bring your setup: the plan of what comes over from Claude Code,
// Codex, Hermes and the Rust Keel, picked per item, then brought in one run.
// Reading the plan writes nothing; running it again brings only what is new.
import { useEffect, useMemo, useState } from "react";
import { reportError } from "../lib/store.ts";
import { cn } from "../lib/utils.ts";
import { Card } from "./Settings.tsx";

type State = "new" | "update" | "done" | "skip" | "error";
type Item = { id: string; area: string; source: string; title: string; detail?: string; state: State; reason?: string; pick: boolean; ok?: boolean; result?: string; error?: string };
type Plan = { home: string; config: string; items: Item[] };

const AREA: Record<string, { label: string; hint: string }> = {
  instructions: { label: "Instructions", hint: "Global instruction files, added to Keel's own AGENTS.md: their imports stay links, their text comes once." },
  memory: { label: "Memory", hint: "Into tacit, through tacit's own importer; its reviewer judges each note." },
  skills: { label: "Skills", hint: "Read where they are, so an update there reaches Keel." },
  plugins: { label: "Plugins", hint: "Claude Code plugins that are turned on: their skills, commands, agents and servers." },
  mcp: { label: "MCP servers", hint: "Added to Keel's servers; the values of env entries are copied, never shown." },
  hooks: { label: "Hooks", hint: "Yours go to Keel's own hooks file and run in every session; a project's go to its .keel/hooks.json and run once you pin it in Settings > Hooks." },
  permissions: { label: "Permission rules", hint: "Allow rules whose meaning Keel's gate holds the same way; Keel's own checks still ask for risky commands. Deny and ask rules, and allows they carve exceptions from, stay out." },
  sessions: { label: "Sessions", hint: "Read-only copies. The Rust Keel's all; the others' recent ones, the rest stay in Import." },
  settings: { label: "Settings", hint: "What else the other tools keep." },
};
const STATE: Record<State, { label: string; cls: string }> = {
  new: { label: "New", cls: "bg-accent-soft text-accent-ink" },
  update: { label: "Changed", cls: "bg-accent-soft text-accent-ink" },
  done: { label: "Here", cls: "bg-sunken text-muted" },
  skip: { label: "Left out", cls: "bg-sunken text-faint" },
  error: { label: "Unreadable", cls: "bg-danger-soft text-danger" },
};
const runnable = (i: Item) => (i.state === "new" || i.state === "update") && !i.result;

function Row({ it, on, toggle }: { it: Item; on: boolean; toggle: () => void }) {
  return (
    <li className="flex items-start gap-3 border-b border-line/60 py-2.5 last:border-0" data-port-item={it.id}>
      <input type="checkbox" aria-label={`Bring ${it.title}`} className="mt-1 accent-accent" checked={on} disabled={!runnable(it)} onChange={toggle} style={{ visibility: runnable(it) ? "visible" : "hidden" }} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="shrink-0 text-caption text-faint">{it.source}</span>
          <span className="min-w-0 truncate text-ui font-medium" title={it.title}>{it.title}</span>
          {it.result ? <span className="ml-auto shrink-0 rounded-xs bg-sunken px-1.5 text-micro font-medium text-ok">Brought</span>
            : it.error ? <span className="ml-auto shrink-0 rounded-xs bg-danger-soft px-1.5 text-micro font-medium text-danger">Failed</span>
            : <span className={cn("ml-auto shrink-0 rounded-xs px-1.5 text-micro font-medium", STATE[it.state].cls)}>{STATE[it.state].label}</span>}
        </div>
        {it.detail && <div className="mt-0.5 break-words text-caption text-muted">{it.detail}</div>}
        {it.reason && <div className="mt-0.5 text-caption text-faint">{it.reason}</div>}
        {it.result && <div className="mt-0.5 text-caption text-ok" data-port-result>{it.result}</div>}
        {it.error && <div className="mt-0.5 text-caption text-danger" data-port-error>{it.error}</div>}
      </div>
    </li>
  );
}

function Sessions({ items, picked, set }: { items: Item[]; picked: Set<string>; set: (ids: string[], on: boolean) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const by = useMemo(() => {
    const m = new Map<string, Item[]>();
    for (const i of items) (m.get(i.source) ?? m.set(i.source, []).get(i.source)!).push(i);
    return [...m.entries()];
  }, [items]);
  return (
    <ul>
      {by.map(([src, list]) => {
        const run = list.filter(runnable);
        const on = run.filter((i) => picked.has(i.id)).length;
        const rest = list.filter((i) => !runnable(i));
        return (
          <li key={src} className="border-b border-line/60 py-2.5 last:border-0" data-port-source={src}>
            <div className="flex items-center gap-3">
              <input type="checkbox" aria-label={`Bring ${src} sessions`} className="accent-accent" checked={!!run.length && on === run.length} ref={(el) => { if (el) el.indeterminate = on > 0 && on < run.length; }} disabled={!run.length} onChange={(e) => set(run.map((i) => i.id), e.target.checked)} style={{ visibility: run.length ? "visible" : "hidden" }} />
              <span className="text-ui font-medium">{src}</span>
              <span className="text-caption text-muted">
                {[run.length && `${run.length} to bring`, rest.filter((i) => i.state === "done").length && `${rest.filter((i) => i.state === "done").length} here`].filter(Boolean).join(", ")}
              </span>
              <button type="button" className="k-link ml-auto text-caption text-accent hover:underline" onClick={() => setOpen(open === src ? null : src)}>{open === src ? "Hide" : "Show"}</button>
            </div>
            {rest.filter((i) => i.state === "skip").map((i) => <div key={i.id} className="ml-7 mt-1 text-caption text-faint">{i.title}: {i.reason}</div>)}
            {open === src && (
              <ul className="ml-7 mt-1">
                {list.filter((i) => i.state !== "skip").map((i) => <Row key={i.id} it={i} on={picked.has(i.id)} toggle={() => set([i.id], !picked.has(i.id))} />)}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function PortSettings() {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<"" | "reading" | "bringing">("reading");
  const [done, setDone] = useState<{ applied: number; failed: number } | null>(null);
  // Areas still being read: the plan comes one area at a time (the sessions
  // index of a fresh state takes longest), and what is in can be picked and
  // brought before the rest arrives.
  const [pending, setPending] = useState<string[]>([]);
  const read = () => {
    setBusy("reading");
    setDone(null);
    (async () => {
      const r = await fetch("/api/port?stream=1");
      if (!r.ok || !r.body) throw new Error(((await r.json().catch(() => ({}))) as any).error ?? `HTTP ${r.status}`);
      const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          const m = JSON.parse(line);
          if (m.parts) {
            setPlan({ home: m.home, config: m.config, items: [] });
            setPicked(new Set());
            setPending((m.parts as string[][]).flat());
          } else if (m.part) {
            const items = m.part.items as Item[];
            setPlan((p) => (p ? { ...p, items: [...p.items.filter((i) => !m.part.areas.includes(i.area)), ...items] } : p));
            setPicked((cur) => new Set([...cur, ...items.filter((i) => i.pick && runnable(i)).map((i) => i.id)]));
            setPending((cur) => cur.filter((a) => !m.part.areas.includes(a)));
          } else if (m.error) throw new Error(m.error);
        }
      }
    })().catch(reportError).finally(() => {
      setPending([]); // also when the read failed: nothing is being read any more
      setBusy((b) => (b === "reading" ? "" : b));
    });
  };
  useEffect(read, []);
  const set = (ids: string[], on: boolean) => setPicked((p) => { const n = new Set(p); for (const id of ids) on ? n.add(id) : n.delete(id); return n; });
  const bring = () => {
    setBusy("bringing");
    const ids = [...picked];
    fetch("/api/port", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids }) }).then(async (r) => {
      const out = await r.json();
      if (!r.ok) throw new Error(out.error ?? `HTTP ${r.status}`);
      // The results stay on the rows (only the areas brought were read again); a later read shows them as here.
      const got = new Set((out.items as Item[]).map((i) => i.area));
      setPlan((p) => (p ? { ...p, items: [...p.items.filter((i) => !got.has(i.area)), ...out.items] } : p));
      setPicked((cur) => new Set([...cur].filter((id) => !ids.includes(id))));
      setDone({ applied: out.counts.applied, failed: out.counts.failed });
    }).catch(reportError).finally(() => setBusy((b) => (b === "bringing" ? "" : b)));
  };
  const order = Object.keys(AREA);
  const areas = useMemo(() => {
    const m = new Map<string, Item[]>();
    for (const i of plan?.items ?? []) (m.get(i.area) ?? m.set(i.area, []).get(i.area)!).push(i);
    return [...m.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
  }, [plan]);
  const count = (s: State) => plan?.items.filter((i) => i.state === s).length ?? 0;
  return (
    <div className="flex flex-col gap-4" data-testid="port">
      <Card>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 py-4">
          <div className="min-w-0 flex-1">
            <div className="text-base font-medium">Bring your setup from the other tools</div>
            <div className="mt-0.5 text-ui text-muted">
              {plan ? <>Read from <span className="font-mono text-caption">{plan.home}</span>; the sources are never changed.</> : "Reading what Claude Code, Codex, Hermes and the Rust Keel hold..."}
            </div>
            {plan && (
              <div className="mt-1 text-caption tabular-nums text-faint" data-port-summary>
                {count("new")} new, {count("update")} changed, {count("done")} already here, {count("skip")} left out{count("error") ? `, ${count("error")} unreadable` : ""}
                {pending.length > 0 && <span data-port-reading> · reading {pending.map((a) => AREA[a]?.label.toLowerCase() ?? a).join(", ")}</span>}
                {done && <span className={done.failed ? "text-danger" : "text-ok"}> · brought {done.applied}{done.failed ? `, ${done.failed} failed` : ""}</span>}
              </div>
            )}
          </div>
          <button type="button" disabled={!!busy} onClick={read} className="h-8 rounded-md border border-line-strong bg-raised px-3 text-ui font-medium hover:bg-hover disabled:opacity-50">
            {busy === "reading" ? "Reading" : "Read again"}
          </button>
          <button type="button" disabled={busy === "bringing" || !picked.size} onClick={bring} className="h-8 rounded-md bg-accent px-3 text-ui font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-50">
            {busy === "bringing" ? "Bringing" : `Bring ${picked.size} over`}
          </button>
        </div>
      </Card>
      {areas.map(([area, list]) => (
        <Card key={area}>
          <div className="pt-4" data-port-area={area}>
            <div className="text-ui font-medium">{AREA[area]?.label ?? area}<span className="ml-2 font-normal tabular-nums text-faint">{list.filter(runnable).length ? `${list.filter(runnable).length} to bring` : "nothing new"}</span></div>
            <div className="mt-0.5 text-caption text-muted">{AREA[area]?.hint}</div>
          </div>
          <div className="mt-2 pb-2">
            {area === "sessions" ? <Sessions items={list} picked={picked} set={set} /> : (
              <ul>{list.map((i) => <Row key={i.id} it={i} on={picked.has(i.id)} toggle={() => set([i.id], !picked.has(i.id))} />)}</ul>
            )}
          </div>
        </Card>
      ))}
      {pending.filter((a) => !areas.some(([x]) => x === a)).map((a) => (
        <Card key={a}>
          <div className="flex items-baseline gap-2 py-4" data-port-pending={a}>
            <span className="text-ui font-medium">{AREA[a]?.label ?? a}</span>
            <span className="animate-pulse text-caption text-faint">Reading</span>
          </div>
        </Card>
      ))}
    </div>
  );
}

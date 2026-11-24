// Settings: the owner's own tools Keel works with. tacit's memory hooks, and
// momentum's report with the control socket it uses.
import { STATE_WORD } from "../../../src/core/state-words.ts";
import { useEffect, useState } from "react";
import { composing } from "../lib/keys.ts";
import { reportError } from "../lib/store.ts";
import { clock, cn } from "../lib/utils.ts";
import { Select } from "./Select.tsx";
import { Card, SettingRow } from "./Settings.tsx";

type Item = { id: string; title: string; detail?: string; at?: string };
type Report = { available: boolean; report?: { generated_at: string; counts: Record<string, number>; needs_you: Item[]; problems: Item[]; running: Item[] } };
type Info = { tacit: { available: boolean; bin: string | null; writer: string; writer_from: "TACIT_HARNESS" | "settings" }; momentum: { available: boolean; socket: string | null } };

const get = <T,>(p: string) => fetch(p).then((r) => r.json() as Promise<T>);

function Status({ on, children }: { on: boolean; children: React.ReactNode }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-ui", on ? "text-fg" : "text-muted")}>
      <span className={cn("size-2 rounded-full", on ? "bg-ok" : "bg-line-strong")} />
      {children}
    </span>
  );
}

function Items({ label, items, tone }: { label: string; items: Item[]; tone: string }) {
  if (!items.length) return null;
  return (
    <div className="border-b border-line py-3 last:border-0">
      <div className="mb-1.5 flex items-center gap-2 k-label">
        <span className={cn("size-1.5 rounded-full", tone)} />
        {label}
        <span className="tabular-nums">{items.length}</span>
      </div>
      <ul className="space-y-1">
        {items.slice(0, 5).map((i) => (
          <li key={i.id} className="k-truncate text-ui" title={i.detail}>{i.title}</li>
        ))}
        {items.length > 5 && <li className="text-caption text-faint">{items.length - 5} more in momentum's report</li>}
      </ul>
    </div>
  );
}

// The writer of the store a correction sent from the Memory panel is recorded
// under. The store's own writers are offered when it names them; when it
// does not, the name is typed, saved when the field is left or Enter is
// pressed, and one the daemon refuses is said and the field goes back.
function Writer({ info, onSaved }: { info: Info["tacit"]; onSaved: (w: string) => void }) {
  const [text, setText] = useState(info.writer);
  const [why, setWhy] = useState("");
  const [known, setKnown] = useState<string[] | null>(null);
  const fixed = info.writer_from === "TACIT_HARNESS";
  useEffect(() => { get<{ writers: string[] | null }>("/api/memory/writers").then((x) => setKnown(x.writers)).catch(reportError); }, []);
  const save = (w: string) => {
    if (fixed || w === info.writer) return;
    fetch("/api/settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ memory: { writer: w } }) })
      .then(async (r) => { if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`); setWhy(""); setText(w); onSaved(w); })
      .catch((e) => { setWhy((e as Error).message); setText(info.writer); });
  };
  const lacks = known && !known.includes(info.writer);
  return (
    <span className="flex flex-col gap-1 sm:items-end">
      {known ? (
        <Select aria-label="Writer of corrections" data-testid="memory-writer" value={info.writer} disabled={fixed} onChange={(e) => save(e.target.value)} className="w-40 font-mono text-caption">
          {lacks && <option value={info.writer}>{info.writer}</option>}
          {known.map((w) => <option key={w} value={w}>{w}</option>)}
        </Select>
      ) : (
        <input aria-label="Writer of corrections" data-testid="memory-writer" value={text} disabled={fixed} maxLength={32} onChange={(e) => setText(e.target.value)} onBlur={() => save(text.trim())} onKeyDown={(e) => { if (e.key === "Enter" && !composing(e)) e.currentTarget.blur(); }}
          className="k-field text-caption w-40 font-mono" />
      )}
      {fixed && <span className="text-caption text-faint">set by TACIT_HARNESS</span>}
      {lacks && <span className="max-w-[20rem] text-caption text-danger sm:text-right" role="status" data-testid="memory-writer-lacks">The store has no writer named {info.writer}: a correction would be refused. Pick one of its own.</span>}
      {why && <span className="max-w-[20rem] text-caption text-danger sm:text-right" role="status">{why}</span>}
    </span>
  );
}

export function IntegrationsSettings() {
  const [info, setInfo] = useState<Info | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  useEffect(() => {
    get<Info>("/api/integrations").then(setInfo).catch(reportError);
    get<Report>("/api/momentum").then(setReport).catch(reportError);
  }, []);
  const r = report?.report;
  return (
    <div className="flex flex-col gap-4" data-testid="integrations">
      <Card>
        <SettingRow
          label="Memory (tacit)"
          hint="Before each prompt and each edit, command or tool call, tacit adds the rules and decisions that apply, marked as memory. Off per session with /memory off before its first message."
        >
          <Status on={!!info?.tacit.available}>{info ? (info.tacit.available ? "On" : "Not installed") : "..."}</Status>
        </SettingRow>
        {info?.tacit.bin && (
          <SettingRow label="Binary"><span className="block max-w-[26rem] k-truncate font-mono text-caption text-muted" title={info.tacit.bin}>{info.tacit.bin}</span></SettingRow>
        )}
        {info?.tacit.available && (
          <SettingRow label="Corrections are written as" hint="A correction sent from the Memory panel is a note in the store. The store has no writer for Keel, so the note is recorded under one of the store's own writers, named here; its first sentence says it came from Keel.">
            <Writer info={info.tacit} onSaved={(w) => setInfo({ ...info, tacit: { ...info.tacit, writer: w } })} />
          </SettingRow>
        )}
      </Card>
      <Card>
        <SettingRow label="Supervisor (momentum)" hint="momentum reads every session's phase from Keel's control socket and may queue, steer or stop one; its messages are marked as momentum's.">
          <Status on={!!report?.available}>{report ? (report.available ? "Reporting" : "Not installed") : "..."}</Status>
        </SettingRow>
        {info?.momentum.socket && (
          <SettingRow label="Control socket"><span className="block max-w-[26rem] k-truncate font-mono text-caption text-muted" title={info.momentum.socket} data-testid="momentum-socket">{info.momentum.socket}</span></SettingRow>
        )}
      </Card>
      {r && (
        <Card>
          <div className="flex items-center gap-3 border-b border-line py-3">
            <span className="text-ui font-medium">momentum report</span>
            <span className="text-caption text-faint">{clock(new Date(r.generated_at).getTime())}</span>
            <span className="ml-auto flex gap-3 text-caption tabular-nums text-muted" data-testid="momentum-counts">
              {Object.entries(r.counts).map(([k, v]) => <span key={k}>{v} {k.replace("_", " ")}</span>)}
            </span>
          </div>
          <Items label={STATE_WORD.need} items={r.needs_you} tone="bg-st-need" />
          <Items label="Problems" items={r.problems} tone="bg-danger" />
          <Items label="Running" items={r.running} tone="bg-accent" />
        </Card>
      )}
    </div>
  );
}



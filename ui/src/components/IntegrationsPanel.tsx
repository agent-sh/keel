// Settings: the owner's own tools Keel works with. tacit's memory hooks, and
// momentum's report with the control socket it uses.
import { useEffect, useState } from "react";
import { reportError } from "../lib/store.ts";
import { cn } from "../lib/utils.ts";
import { Card, SettingRow } from "./Settings.tsx";

type Item = { id: string; title: string; detail?: string; at?: string };
type Report = { available: boolean; report?: { generated_at: string; counts: Record<string, number>; needs_you: Item[]; problems: Item[]; running: Item[] } };
type Info = { tacit: { available: boolean; bin: string | null }; momentum: { available: boolean; socket: string | null } };

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
      <div className="mb-1.5 flex items-center gap-2 text-caption font-medium uppercase tracking-wide text-faint">
        <span className={cn("size-1.5 rounded-full", tone)} />
        {label}
        <span className="tabular-nums">{items.length}</span>
      </div>
      <ul className="space-y-1">
        {items.slice(0, 5).map((i) => (
          <li key={i.id} className="truncate text-ui" title={i.detail}>{i.title}</li>
        ))}
        {items.length > 5 && <li className="text-caption text-faint">{items.length - 5} more in momentum's report</li>}
      </ul>
    </div>
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
          <SettingRow label="Binary"><span className="block max-w-[26rem] truncate font-mono text-caption text-muted" title={info.tacit.bin}>{info.tacit.bin}</span></SettingRow>
        )}
      </Card>
      <Card>
        <SettingRow label="Supervisor (momentum)" hint="momentum reads every session's phase from Keel's control socket and may queue, steer or stop one; its messages are marked as momentum's.">
          <Status on={!!report?.available}>{report ? (report.available ? "Reporting" : "Not installed") : "..."}</Status>
        </SettingRow>
        {info?.momentum.socket && (
          <SettingRow label="Control socket"><span className="block max-w-[26rem] truncate font-mono text-caption text-muted" title={info.momentum.socket} data-testid="momentum-socket">{info.momentum.socket}</span></SettingRow>
        )}
      </Card>
      {r && (
        <Card>
          <div className="flex items-center gap-3 border-b border-line py-3">
            <span className="text-ui font-medium">momentum report</span>
            <span className="text-caption text-faint">{new Date(r.generated_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}</span>
            <span className="ml-auto flex gap-3 text-caption tabular-nums text-muted" data-testid="momentum-counts">
              {Object.entries(r.counts).map(([k, v]) => <span key={k}>{v} {k.replace("_", " ")}</span>)}
            </span>
          </div>
          <Items label="Needs you" items={r.needs_you} tone="bg-warn" />
          <Items label="Problems" items={r.problems} tone="bg-danger" />
          <Items label="Running" items={r.running} tone="bg-accent" />
        </Card>
      )}
    </div>
  );
}



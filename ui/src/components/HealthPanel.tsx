// Settings > Health: one list of what is wrong with this installation, from
// the daemon's health check (src/admin/health.ts; `keel doctor` prints the same).
// It runs when the page opens and when asked again, never on a timer. Each row
// is well, a warning or broken, says how to fix it in a line, and links to the
// Settings section where it is fixed.
import { ArrowUpRight, CircleAlert, CircleCheck, RotateCw, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api, reportError } from "../lib/store.ts";
import { navigate } from "../lib/ui.ts";
import { cn } from "../lib/utils.ts";
import { GROUPS, GROUP_NAMES, SECTION_NAMES, type HealthReport, type Level, type Row } from "../../../src/admin/health-rows.ts";
import { Card } from "./Settings.tsx";

const MARK: Record<Level, { icon: typeof CircleCheck; tone: string; word: string }> = {
  broken: { icon: CircleAlert, tone: "text-danger", word: "Broken" },
  warning: { icon: TriangleAlert, tone: "text-warn", word: "Warning" },
  ok: { icon: CircleCheck, tone: "text-ok", word: "Well" },
};

function Tally({ level, n }: { level: Level; n: number }) {
  const m = MARK[level];
  const Icon = m.icon;
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-ui tabular-nums", n ? m.tone : "text-faint")} data-testid="health-count" data-level={level}>
      <Icon className="size-4" aria-hidden />
      <b className="font-semibold">{n}</b> {m.word.toLowerCase()}
    </span>
  );
}

function HealthRow({ r }: { r: Row }) {
  const m = MARK[r.level];
  const Icon = m.icon;
  return (
    <div className="grid grid-cols-[1rem_minmax(0,1fr)] items-start gap-x-3 gap-y-2 border-b border-line py-3 last:border-0 sm:grid-cols-[1rem_minmax(0,1fr)_auto]" data-testid="health-row" data-level={r.level} data-group={r.group} data-row={r.id}>
      <Icon className={cn("mt-0.5 size-4 shrink-0", m.tone)} aria-label={m.word} />
      <div className="min-w-0">
        <div className={cn("text-base", r.level === "ok" ? "text-muted" : "font-medium")} data-testid="health-title">{r.title}</div>
        {r.detail && <div className="mt-0.5 break-words text-ui text-muted">{r.detail}</div>}
        {r.fix && r.level !== "ok" && <div className="mt-1 text-ui" data-testid="health-fix"><span className="text-faint">Fix: </span>{r.fix}</div>}
        {r.path && r.level !== "ok" && <div className="mt-1 break-all font-mono text-caption text-faint" title={r.path}>{r.path}</div>}
        {r.how && <div className="mt-0.5 text-caption text-faint">Checked: {r.how}.</div>}
      </div>
      {r.link && r.level !== "ok" && (
        <button type="button" className="k-btn k-btn-lg col-start-2 justify-self-start sm:col-start-3 sm:row-start-1" data-testid="health-open" onClick={() => navigate({ name: "settings", section: r.link!.section })}>
          {SECTION_NAMES[r.link.section] ?? r.link.section}
          <ArrowUpRight className="size-3.5" aria-hidden />
        </button>
      )}
    </div>
  );
}

export function HealthPanel() {
  const [report, setReport] = useState<HealthReport | null>(null);
  const [busy, setBusy] = useState(false);
  const run = useCallback(() => {
    setBusy(true);
    api<HealthReport>("/api/health/check").then(setReport).catch(reportError).finally(() => setBusy(false));
  }, []);
  useEffect(run, [run]);
  if (!report) return <div className="text-ui text-faint" data-testid="health-wait">Checking.</div>;
  const c = report.counts;
  return (
    <div className="flex flex-col gap-5" data-testid="health-panel" data-state={busy ? "checking" : "done"}>
      <Card>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 py-4">
          <Tally level="broken" n={c.broken} />
          <Tally level="warning" n={c.warning} />
          <Tally level="ok" n={c.ok} />
          <span className="text-caption text-faint">Checked in {report.took_ms < 1000 ? `${report.took_ms} ms` : `${(report.took_ms / 1000).toFixed(1)} s`}. Nothing was changed or paid for.</span>
          <button type="button" disabled={busy} className="k-btn k-btn-lg ml-auto" data-testid="health-again" onClick={run}>
            <RotateCw className={cn("size-3.5", busy && "animate-spin")} aria-hidden />
            {busy ? "Checking" : "Check again"}
          </button>
        </div>
      </Card>
      {GROUPS.map((g) => {
        const rows = report.rows.filter((r) => r.group === g);
        if (!rows.length) return null;
        return (
          <section key={g} className="flex flex-col gap-2" data-testid="health-group" data-group={g}>
            <h3 className="k-label">{GROUP_NAMES[g]}</h3>
            <Card>{rows.map((r) => <HealthRow key={r.id} r={r} />)}</Card>
          </section>
        );
      })}
    </div>
  );
}

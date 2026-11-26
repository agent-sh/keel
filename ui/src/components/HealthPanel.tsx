// Settings > Health: one list of what is wrong with this installation, from
// the daemon's health check (src/admin/health.ts; `keel doctor` prints the same).
// It runs when the page opens and when asked again, never on a timer. Each row
// is well, a warning or broken, says how to fix it in a line, and links to the
// Settings section where it is fixed.
import { ArrowUpRight, CircleAlert, CircleCheck, RotateCw, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api, reportError, useStore } from "../lib/store.ts";
import { navigate, sessionLeft, useUI } from "../lib/ui.ts";
import { cn } from "../lib/utils.ts";
import { CHECK_NOTE, GROUPS, GROUP_NAMES, SECTION_NAMES, type HealthReport, type Level, type Row } from "../../../src/admin/health-rows.ts";
import { LEVEL_WORD } from "../../../src/core/state-words.ts";
import { Empty, Group, Item, List, Notice, Page, Status, type Tone } from "./settings/kit.tsx";

const MARK: Record<Level, { icon: typeof CircleCheck; tone: string; chip: Tone }> = {
  broken: { icon: CircleAlert, tone: "text-danger", chip: "broken" },
  warning: { icon: TriangleAlert, tone: "text-warn", chip: "warn" },
  // What is well asks nothing: its check is grey and its count has no ground. The colour is what is wrong.
  ok: { icon: CircleCheck, tone: "text-faint", chip: "quiet" },
};

function Tally({ level, n }: { level: Level; n: number }) {
  const tone = n ? MARK[level].chip : "quiet";
  return (
    <Status tone={tone} testid="health-count" data-level={level}>
      <b className={cn("tabular-nums", tone === "quiet" ? "font-normal" : "font-semibold")}>{n}</b> {LEVEL_WORD[level].toLowerCase()}
    </Status>
  );
}

function HealthRow({ r }: { r: Row }) {
  const m = MARK[r.level];
  const Icon = m.icon;
  return (
    <Item testid="health-row" data-level={r.level} data-group={r.group} data-row={r.id}
      lead={<Icon className={cn("size-4 shrink-0", m.tone)} aria-label={LEVEL_WORD[r.level]} />}
      name={<span className={r.level === "ok" ? "font-normal text-muted" : undefined} data-testid="health-title">{r.title}</span>}
      sub={(r.detail || (r.level !== "ok" && (r.fix || r.path)) || r.how) && <>
        {r.detail && <div className="break-words text-muted">{r.detail}</div>}
        {r.fix && r.level !== "ok" && <div className="mt-1 text-fg" data-testid="health-fix"><span className="text-faint">Fix: </span>{r.fix}</div>}
        {r.path && r.level !== "ok" && <div className="mt-1 break-all font-mono text-faint" title={r.path}>{r.path}</div>}
        {r.how && <div className="mt-0.5">Checked: {r.how}.</div>}
      </>}
      actions={r.link && r.level !== "ok" && (
        <button type="button" className="k-btn" data-testid="health-open" onClick={() => navigate({ name: "settings", section: r.link!.section })}>
          {SECTION_NAMES[r.link.section] ?? r.link.section}
          <ArrowUpRight className="size-3.5" aria-hidden />
        </button>
      )} />
  );
}

export function HealthPanel() {
  const [report, setReport] = useState<HealthReport | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The folder the owner works in: the session he came from, else the folder the start box uses; the daemon's own when neither.
  const folder = useStore((s) => (sessionLeft() && s.sessions[sessionLeft()!]?.workspace) || "");
  const chosen = useUI((s) => s.newWorkspace);
  const cwd = folder || chosen;
  const run = useCallback(() => {
    setBusy(true);
    setFailed(null);
    api<HealthReport>(`/api/health/check${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""}`)
      .then(setReport)
      .catch((e) => { setFailed(e instanceof Error ? e.message : String(e)); reportError(e); })
      .finally(() => setBusy(false));
  }, [cwd]);
  useEffect(run, [run]);
  const again = (word: string) => (
    <button type="button" disabled={busy} className="k-btn k-btn-lg" data-testid="health-again" onClick={run}>
      <RotateCw className={cn("size-3.5", busy && "animate-spin")} aria-hidden />
      {busy ? "Checking" : word}
    </button>
  );
  if (!report) {
    return failed === null
      ? <Empty testid="health-wait">Checking.</Empty>
      : <Page testid="health-failed"><Notice tone="broken" title={`The health check did not answer: ${failed}`}><div className="mt-3">{again("Try again")}</div></Notice></Page>;
  }
  const c = report.counts;
  return (
    <Page testid="health-panel" data-state={busy ? "checking" : "done"} intro={<span data-testid="health-note">{CHECK_NOTE}</span>}>
      <Group bare title="This installation" hint={`Checked in ${report.took_ms < 1000 ? `${report.took_ms} ms` : `${(report.took_ms / 1000).toFixed(1)} s`}.`} actions={again("Check again")}>
        <div className="flex flex-wrap gap-2">
          <Tally level="broken" n={c.broken} />
          <Tally level="warning" n={c.warning} />
          <Tally level="ok" n={c.ok} />
        </div>
      </Group>
      {failed !== null && <Notice tone="broken" testid="health-failed">The last check did not answer: {failed}. These rows are from the one before.</Notice>}
      {GROUPS.map((g) => {
        const rows = report.rows.filter((r) => r.group === g);
        if (!rows.length) return null;
        return (
          <Group key={g} testid="health-group" data-group={g} title={GROUP_NAMES[g]} count={rows.length}>
            <List label={GROUP_NAMES[g]}>{rows.map((r) => <HealthRow key={r.id} r={r} />)}</List>
          </Group>
        );
      })}
    </Page>
  );
}

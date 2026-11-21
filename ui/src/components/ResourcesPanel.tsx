// Settings > Resources: what the daemon and the processes it started cost the
// machine right now and over the last hour, per process and per session.
import { useEffect, useState } from "react";
import { api, reportError, useStore } from "../lib/store.ts";
import { navigate } from "../lib/ui.ts";
import { cn } from "../lib/utils.ts";
import { TimeChart } from "./Chart.tsx";
import { fmtMs } from "./UsagePanel.tsx";

export const fmtBytes = (b: number | null | undefined) => {
  if (b == null) return "none";
  if (b < 1024) return `${b} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let v = b / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${u[i]}`;
};
const fmtCpu = (v: number) => `${v < 10 ? v.toFixed(1) : Math.round(v)}%`;

type Report = {
  measured_ms: number; interval_ms: number;
  totals: { rss_bytes: number; cpu_percent: number; processes: number; threads: number; cpu_user_ms: number; cpu_system_ms: number };
  daemon: { pid: number; started_ms: number; rss_bytes: number; peak_rss_bytes: number; cpu_percent: number; cpu_user_ms: number; cpu_system_ms: number; threads: number; open_files?: number; heap_bytes: number; growth: { start_rss_bytes: number; per_hour_bytes: number | null } };
  processes: { pid: number; name: string; label: string; command: string; kind: string; session_id?: string; rss_bytes: number; cpu_percent: number; cpu_user_ms: number; cpu_system_ms: number; threads: number; open_files?: number }[];
  sessions: { session_id: string; processes: number; rss_bytes: number; cpu_percent: number; total: { cpu_user_ms: number; cpu_system_ms: number; processes: number } }[];
  disk: { path: string; free_bytes: number; total_bytes: number } | null;
  history: { ts_ms: number; cpu_percent: number; daemon_cpu_percent: number; rss_bytes: number; daemon_rss_bytes: number; processes: number }[];
};

function Tile({ label, value, sub, testid }: { label: string; value: string; sub?: string; testid?: string }) {
  return (
    <div className="rounded-lg border border-line bg-raised px-4 py-3 shadow-1" data-testid={testid}>
      <div className="text-caption text-muted">{label}</div>
      <div className="mt-1 text-title font-semibold tabular-nums tracking-[-0.01em]">{value}</div>
      {sub && <div className="mt-0.5 truncate text-caption text-faint">{sub}</div>}
    </div>
  );
}

const th = "px-4 py-1.5 font-normal whitespace-nowrap";
const td = "px-4 py-1.5 tabular-nums whitespace-nowrap";

export function ResourcesPanel() {
  const [r, setR] = useState<Report | null>(null);
  const sessions = useStore((s) => s.sessions);
  useEffect(() => {
    let live = true;
    // One request at a time (a slow answer is not piled on), and none while
    // the tab is hidden; a tab that shows again reads at once. The first
    // read asks for a fresh measurement. A request with no answer in fifteen
    // seconds is given up, so one that never settles does not end the reads.
    let busy = false, first = true;
    const load = () => {
      if (busy || document.hidden) return;
      busy = true;
      const gaveUp = new AbortController();
      const t = setTimeout(() => gaveUp.abort(), 15_000);
      api<Report>(`/api/resources?history=60${first ? "&refresh=1" : ""}`, { signal: gaveUp.signal })
        .then((x) => live && setR(x))
        .catch((e) => { if (!gaveUp.signal.aborted) reportError(e); })
        .finally(() => { clearTimeout(t); busy = false; });
      first = false;
    };
    load();
    const iv = setInterval(load, 5000);
    document.addEventListener("visibilitychange", load);
    return () => { live = false; clearInterval(iv); document.removeEventListener("visibilitychange", load); };
  }, []);
  if (!r) return <div className="text-ui text-faint">Measuring.</div>;
  const d = r.daemon;
  const span = r.history.length > 1 ? r.history.at(-1)!.ts_ms - r.history[0]!.ts_ms : 60_000;
  const bucket = Math.max(60_000, r.interval_ms);
  // One point per minute: the last sample of each.
  const perMin = new Map<number, Report["history"][number]>();
  for (const h of r.history) perMin.set(Math.floor(h.ts_ms / bucket) * bucket, h);
  const points = [...perMin.entries()];
  const since = Math.min(points[0]?.[0] ?? Date.now(), Date.now() - 60 * 60_000);
  const title = (id?: string) => (id ? sessions[id]?.title || "a session" : "");

  return (
    <div className="flex flex-col gap-4" data-testid="resources-panel">
      <div className="text-caption text-faint">
        Read from /proc every {Math.round(r.interval_ms / 1000)} s. CPU is of one core; memory is resident.
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile testid="tile-memory" label="Memory, all" value={fmtBytes(r.totals.rss_bytes)} sub={`${r.totals.processes} processes, ${r.totals.threads} threads`} />
        <Tile label="Daemon" value={fmtBytes(d.rss_bytes)} sub={d.growth.per_hour_bytes == null ? `peak ${fmtBytes(d.peak_rss_bytes)}` : `${d.growth.per_hour_bytes >= 0 ? "+" : "-"}${fmtBytes(Math.abs(d.growth.per_hour_bytes))} an hour`} />
        <Tile testid="tile-cpu" label="CPU now" value={fmtCpu(r.totals.cpu_percent)} sub={`daemon ${fmtCpu(d.cpu_percent)}, ${fmtMs(d.cpu_user_ms + d.cpu_system_ms)} in all`} />
        <Tile testid="tile-disk" label="Disk free" value={r.disk ? fmtBytes(r.disk.free_bytes) : "unknown"} sub={r.disk ? `of ${fmtBytes(r.disk.total_bytes)} under the state folder` : undefined} />
      </div>

      <section className="rounded-lg border border-line bg-raised p-4 shadow-1">
        <h3 className="mb-3 text-base font-medium">Memory <span className="text-caption font-normal text-faint">last hour</span></h3>
        <TimeChart
          label="Memory over the last hour"
          data={points.map(([t, h]) => ({ t, values: [h.rss_bytes, h.daemon_rss_bytes] }))}
          series={[{ label: "All processes", color: "var(--series-1)" }, { label: "Daemon", color: "var(--series-2)" }]}
          bucket={bucket} since={since} until={Date.now()} format={fmtBytes} height={160} unit={1024 * 1024}
        />
      </section>
      <section className="rounded-lg border border-line bg-raised p-4 shadow-1">
        <h3 className="mb-3 text-base font-medium">CPU <span className="text-caption font-normal text-faint">percent of one core, {span > 0 ? "last hour" : ""}</span></h3>
        <TimeChart
          label="CPU over the last hour"
          data={points.map(([t, h]) => ({ t, values: [h.cpu_percent, h.daemon_cpu_percent] }))}
          series={[{ label: "All processes", color: "var(--series-1)" }, { label: "Daemon", color: "var(--series-2)" }]}
          bucket={bucket} since={since} until={Date.now()} format={fmtCpu} height={160}
        />
      </section>

      <section className="rounded-lg border border-line bg-raised p-4 shadow-1" data-testid="resources-processes">
        <h3 className="mb-3 text-base font-medium">Processes</h3>
        <div className="-mx-4 overflow-x-auto">
          <table className="w-full text-ui">
            <thead>
              <tr className="border-b border-line text-left text-caption text-faint">
                <th className={th}>Process</th><th className={th}>Kind</th><th className={cn(th, "text-right")}>Memory</th><th className={cn(th, "text-right")}>CPU</th><th className={cn(th, "text-right")}>CPU time</th><th className={cn(th, "text-right")}>Threads</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-line/60">
                <td className={td}><span className="font-medium">keel</span> <span className="text-faint">daemon, pid {d.pid}</span></td>
                <td className={cn(td, "text-muted")}>daemon</td>
                <td className={cn(td, "text-right")}>{fmtBytes(d.rss_bytes)}</td>
                <td className={cn(td, "text-right text-muted")}>{fmtCpu(d.cpu_percent)}</td>
                <td className={cn(td, "text-right text-muted")}>{fmtMs(d.cpu_user_ms + d.cpu_system_ms)}</td>
                <td className={cn(td, "text-right text-muted")}>{d.threads}</td>
              </tr>
              {r.processes.map((p) => (
                <tr key={p.pid} className="border-b border-line/60 last:border-0" data-testid="process-row">
                  <td className={cn(td, "max-w-60")}>
                    <div className="truncate font-mono text-caption" title={p.command}>{p.label}</div>
                    {p.session_id && (
                      <button type="button" onClick={() => navigate({ name: "session", id: p.session_id! })} className="k-link truncate text-caption text-accent hover:underline">
                        {title(p.session_id)}
                      </button>
                    )}
                  </td>
                  <td className={cn(td, "text-muted")}>{p.kind}</td>
                  <td className={cn(td, "text-right")}>{fmtBytes(p.rss_bytes)}</td>
                  <td className={cn(td, "text-right text-muted")}>{fmtCpu(p.cpu_percent)}</td>
                  <td className={cn(td, "text-right text-muted")}>{fmtMs(p.cpu_user_ms + p.cpu_system_ms)}</td>
                  <td className={cn(td, "text-right text-muted")}>{p.threads}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {r.sessions.length > 0 && (
        <section className="rounded-lg border border-line bg-raised p-4 shadow-1" data-testid="resources-sessions">
          <h3 className="mb-3 text-base font-medium">By session <span className="text-caption font-normal text-faint">commands the session's tools started, ended ones included</span></h3>
          <div className="-mx-4 overflow-x-auto">
            <table className="w-full text-ui">
              <thead>
                <tr className="border-b border-line text-left text-caption text-faint">
                  <th className={th}>Session</th><th className={cn(th, "text-right")}>Running</th><th className={cn(th, "text-right")}>Memory</th><th className={cn(th, "text-right")}>CPU time</th><th className={cn(th, "text-right")}>Processes</th>
                </tr>
              </thead>
              <tbody>
                {r.sessions.map((s) => (
                  <tr key={s.session_id} className="border-b border-line/60 last:border-0">
                    <td className={cn(td, "max-w-80 truncate")}>
                      <button type="button" onClick={() => navigate({ name: "session", id: s.session_id })} className="k-link truncate hover:underline">{title(s.session_id)}</button>
                    </td>
                    <td className={cn(td, "text-right text-muted")}>{s.processes}</td>
                    <td className={cn(td, "text-right")}>{fmtBytes(s.rss_bytes)}</td>
                    <td className={cn(td, "text-right text-muted")}>{fmtMs(s.total.cpu_user_ms + s.total.cpu_system_ms)}</td>
                    <td className={cn(td, "text-right text-muted")}>{s.total.processes}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

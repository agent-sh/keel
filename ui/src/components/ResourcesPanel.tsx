// Settings > Resources: what the daemon and the processes it started cost the
// machine right now and over the last hour, per process and per session.
import { useEffect, useState } from "react";
import { api, reportError, useStore } from "../lib/store.ts";
import { navigate } from "../lib/ui.ts";
import { TimeChart } from "./Chart.tsx";
import { Stat, Stats } from "./Stat.tsx";
import { fmtMs } from "./UsagePanel.tsx";
import { HeavyPool, type HeavyView } from "./HeavyPool.tsx";
import { Cell, Empty, Group, Notice, Page, Row, Table, type Col } from "./settings/kit.tsx";

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
  daemon: { pid: number; started_ms: number; rss_bytes: number; peak_rss_bytes: number; cpu_percent: number; cpu_user_ms: number; cpu_system_ms: number; threads: number; open_files?: number; heap_bytes: number; growth: { start_rss_bytes: number; per_hour_bytes: number | null }; swap?: { process_bytes: number; unit_bytes?: number; unit_limit_bytes?: number; unit?: string; own?: boolean } };
  processes: { pid: number; name: string; label: string; command: string; kind: string; session_id?: string; rss_bytes: number; cpu_percent: number; cpu_user_ms: number; cpu_system_ms: number; threads: number; open_files?: number }[];
  sessions: { session_id: string; processes: number; rss_bytes: number; cpu_percent: number; total: { cpu_user_ms: number; cpu_system_ms: number; processes: number } }[];
  disk: { path: string; free_bytes: number; total_bytes: number } | null;
  // What commands left running in their job scopes hold, and the job scopes of other daemons (never touched).
  left?: { scopes: number; memory_bytes: number; others: { scopes: number; memory_bytes: number }; at: number };
  history: { ts_ms: number; cpu_percent: number; daemon_cpu_percent: number; rss_bytes: number; daemon_rss_bytes: number; processes: number }[];
  heavy?: HeavyView; // absent from a daemon before the heavy-command pool
};

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
  if (!r) return <Empty>Measuring.</Empty>;
  const d = r.daemon;
  const span = r.history.length > 1 ? r.history.at(-1)!.ts_ms - r.history[0]!.ts_ms : 60_000;
  const bucket = Math.max(60_000, r.interval_ms);
  // One point per minute: the last sample of each.
  const perMin = new Map<number, Report["history"][number]>();
  for (const h of r.history) perMin.set(Math.floor(h.ts_ms / bucket) * bucket, h);
  const points = [...perMin.entries()];
  const since = Math.min(points[0]?.[0] ?? Date.now(), Date.now() - 60 * 60_000);
  const title = (id?: string) => (id ? sessions[id]?.title || "a session" : "");
  // What of the daemon itself is in swap, else of its own unit (the unit holds its commands too). A
  // daemon started from a terminal runs in the terminal's scope: what else is in swap there is not its own.
  const sw = d.swap;
  const swapped = sw?.process_bytes || (sw?.own ? sw.unit_bytes : 0) || 0;

  const P: Record<string, Col> = { name: { head: "Process", grow: true }, kind: { head: "Kind", minor: true }, mem: { head: "Memory", end: true }, cpu: { head: "CPU", end: true }, time: { head: "CPU time", end: true, minor: true }, threads: { head: "Threads", end: true, minor: true } };
  const S: Record<string, Col> = { session: { head: "Session", grow: true }, running: { head: "Running", end: true, minor: true }, mem: { head: "Memory", end: true }, time: { head: "CPU time", end: true, minor: true }, procs: { head: "Processes", end: true, minor: true } };

  return (
    <Page testid="resources-panel" intro={`Read from /proc every ${Math.round(r.interval_ms / 1000)} s. CPU is of one core; memory is resident.`}>
      <Stats>
        <Stat testid="tile-memory" label="Memory, all" value={fmtBytes(r.totals.rss_bytes)} sub={`${r.totals.processes} processes, ${r.totals.threads} threads`} />
        <Stat label="Daemon" value={fmtBytes(d.rss_bytes)} sub={d.growth.per_hour_bytes == null ? `peak ${fmtBytes(d.peak_rss_bytes)}` : `${d.growth.per_hour_bytes >= 0 ? "+" : "-"}${fmtBytes(Math.abs(d.growth.per_hour_bytes))} an hour`} />
        <Stat testid="tile-cpu" label="CPU now" value={fmtCpu(r.totals.cpu_percent)} sub={`daemon ${fmtCpu(d.cpu_percent)}, ${fmtMs(d.cpu_user_ms + d.cpu_system_ms)} in all`} />
        <Stat testid="tile-left" label="Left running" value={r.left?.at ? fmtBytes(r.left.memory_bytes) : "not measured yet"}
          sub={r.left?.at ? <button type="button" className="k-link k-truncate hover:underline" data-testid="tile-left-open" onClick={() => navigate({ name: "settings", section: "leftovers" })}
            title={r.left.others.scopes ? `${fmtBytes(r.left.others.memory_bytes)} more in ${r.left.others.scopes} job scopes of other Keel daemons, which this one leaves alone` : undefined}>
            {r.left.scopes} {r.left.scopes === 1 ? "command" : "commands"}{r.left.others.scopes ? `, others ${fmtBytes(r.left.others.memory_bytes)}` : ""}
          </button> : undefined} />
        <Stat testid="tile-disk" label="Disk free" value={r.disk ? fmtBytes(r.disk.free_bytes) : "unknown"} sub={r.disk ? `of ${fmtBytes(r.disk.total_bytes)} under the state folder` : undefined} />
      </Stats>
      {swapped > 0 && (
        <Notice tone="warn" testid="resources-swap">
          {fmtBytes(swapped)} of the daemon{sw?.process_bytes ? "" : `'s unit${sw?.unit ? ` (${sw.unit})` : ""}`} is in swap. A page there is read back from the disk when it is next used, and every session waits meanwhile.
          {sw?.own
            ? sw.unit_limit_bytes === 0 ? "" : ` To keep it out, add MemorySwapMax=0 under [Service] of the unit (systemctl --user edit ${sw.unit}) and restart it.`
            : ` It was started from a terminal${sw?.unit ? ` (it runs in ${sw.unit})` : ""}, where nothing keeps it out of swap: a service unit with MemorySwapMax=0 does.`}
        </Notice>
      )}

      {r.heavy && <HeavyPool v={r.heavy} />}

      <Group title="Memory" hint="Last hour." pad>
        <TimeChart
          label="Memory over the last hour"
          data={points.map(([t, h]) => ({ t, values: [h.rss_bytes, h.daemon_rss_bytes] }))}
          series={[{ label: "All processes", color: "var(--series-1)" }, { label: "Daemon", color: "var(--series-2)" }]}
          bucket={bucket} since={since} until={Date.now()} format={fmtBytes} height={160} unit={1024 * 1024}
        />
      </Group>
      <Group title="CPU" hint={`Percent of one core${span > 0 ? ", last hour" : ""}.`} pad>
        <TimeChart
          label="CPU over the last hour"
          data={points.map(([t, h]) => ({ t, values: [h.cpu_percent, h.daemon_cpu_percent] }))}
          series={[{ label: "All processes", color: "var(--series-1)" }, { label: "Daemon", color: "var(--series-2)" }]}
          bucket={bucket} since={since} until={Date.now()} format={fmtCpu} height={160}
        />
      </Group>

      <Group testid="resources-processes" title="Processes">
        <Table cols={Object.values(P)} label="Processes">
          <Row name={<span className="font-medium">keel</span>} after={<span className="ml-1.5 text-faint">daemon, pid {d.pid}</span>}>
            <Cell col={P.kind!} className="text-muted">daemon</Cell>
            <Cell col={P.mem!}>{fmtBytes(d.rss_bytes)}</Cell>
            <Cell col={P.cpu!} className="text-muted">{fmtCpu(d.cpu_percent)}</Cell>
            <Cell col={P.time!} className="text-muted">{fmtMs(d.cpu_user_ms + d.cpu_system_ms)}</Cell>
            <Cell col={P.threads!} className="text-muted">{d.threads}</Cell>
          </Row>
          {r.processes.map((p) => (
            <Row key={p.pid} testid="process-row" title={p.command}
              name={<span className="font-mono text-caption">{p.label}</span>}
              after={p.session_id && (
                <button type="button" onClick={() => navigate({ name: "session", id: p.session_id! })} className="k-link ml-2 max-w-full k-truncate text-caption text-accent hover:underline">
                  {title(p.session_id)}
                </button>
              )}>
              <Cell col={P.kind!} className="text-muted">{p.kind}</Cell>
              <Cell col={P.mem!}>{fmtBytes(p.rss_bytes)}</Cell>
              <Cell col={P.cpu!} className="text-muted">{fmtCpu(p.cpu_percent)}</Cell>
              <Cell col={P.time!} className="text-muted">{fmtMs(p.cpu_user_ms + p.cpu_system_ms)}</Cell>
              <Cell col={P.threads!} className="text-muted">{p.threads}</Cell>
            </Row>
          ))}
        </Table>
      </Group>

      {r.sessions.length > 0 && (
        <Group testid="resources-sessions" title="By session" hint="Commands the session's tools started, ended ones included.">
          <Table cols={Object.values(S)} label="By session">
            {r.sessions.map((s) => (
              <Row key={s.session_id} name={<button type="button" onClick={() => navigate({ name: "session", id: s.session_id })} className="k-link max-w-full k-truncate hover:underline">{title(s.session_id)}</button>}>
                <Cell col={S.running!} className="text-muted">{s.processes}</Cell>
                <Cell col={S.mem!}>{fmtBytes(s.rss_bytes)}</Cell>
                <Cell col={S.time!} className="text-muted">{fmtMs(s.total.cpu_user_ms + s.total.cpu_system_ms)}</Cell>
                <Cell col={S.procs!} className="text-muted">{s.total.processes}</Cell>
              </Row>
            ))}
          </Table>
        </Group>
      )}
    </Page>
  );
}

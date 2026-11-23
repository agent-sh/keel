// Settings > Network: what left this machine today, by host and by session,
// from the outward ledger (src/safety/egress.ts). A host first seen today is
// marked. With the sandbox off the page says what it cannot see.
import { Fragment, useCallback, useEffect, useState } from "react";
import type { EgressReport } from "../../../src/safety/egress-report.ts";
import { every } from "../lib/clock.ts";
import { api, reportError, useStore } from "../lib/store.ts";
import { navigate } from "../lib/ui.ts";
import { clock, cn, fmtSize, when } from "../lib/utils.ts";
import { Stat, Stats } from "./Stat.tsx";

type Report = EgressReport & { sandbox: { available: boolean; default: string; reason?: string } };

const th = "px-4 py-1.5 font-normal whitespace-nowrap";
const td = "px-4 py-1.5 tabular-nums whitespace-nowrap";
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const list = (s: string) => s.split(",").filter(Boolean);
const ports = (s: string) => list(s).map(Number).sort((a, b) => a - b).join(", ");
const OUTCOME: Record<string, string> = { sent: "sent", refused: "refused", failed: "did not connect" };

export function NetworkPanel() {
  const [r, setR] = useState<Report | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const sessions = useStore((s) => s.sessions);
  const load = useCallback(() => {
    api<Report>("/api/egress?recent=100").then(setR).catch(reportError);
  }, []);
  // Read again every half minute while the page shows (the page's one clock).
  useEffect(() => { load(); return every(30_000, load); }, [load]);
  if (!r) return <div className="text-ui text-faint">Reading the ledger.</div>;
  const title = (id: string | null) => (id ? sessions[id]?.title || r.sessions.find((s) => s.session_id === id)?.title || "a session" : "Keel itself");
  const t = r.totals;
  const off = !r.sandbox.available || r.sandbox.default === "off";
  const pairs = (host: string) => r.pairs.filter((p) => p.host === host);

  return (
    <div className="flex flex-col gap-4" data-testid="network-panel">
      <p className="text-caption text-faint">
        Every transfer Keel made or carried since {when(r.since)}: model requests, the web tools, MCP servers over HTTP, the fleet, exports, the OTLP export, phone pushes, its own git pushes, and what a sandboxed command sent through the sandbox's proxy. Bytes are what was sent out.
      </p>
      <Stats>
        <Stat testid="network-transfers" label="Transfers" value={t.rows.toLocaleString()} sub={t.refused ? `${t.refused} refused` : "none refused"} />
        <Stat testid="network-bytes" label="Sent out" value={fmtSize(t.bytes)} />
        <Stat testid="network-hosts" label="Hosts" value={t.hosts.toLocaleString()} sub={t.new_hosts ? `${t.new_hosts} never seen before today` : "all seen before"} />
        <Stat label="Sessions" value={t.sessions.toLocaleString()} />
      </Stats>

      <section className={cn("rounded-lg border p-4 text-ui", off ? "border-warn/40 bg-raised" : "border-line bg-raised")} data-testid="network-unseen">
        <h3 className={cn("mb-1 text-base font-medium", off && "text-warn")}>{off ? "The sandbox is off: commands' own connections are not here" : "What this page cannot see"}</h3>
        <p className="text-muted">
          {off
            ? `${r.sandbox.available ? "Sessions run their commands unconfined by default" : `The sandbox is not available on this machine${r.sandbox.reason ? ` (${r.sandbox.reason})` : ""}`}, so a command connects by itself (curl, git, a package manager, a script) and Keel never sees it. Only what Keel itself sends is listed.`
            : "A sandboxed command reaches the network only through Keel's proxy, so its connections are here. A session with its sandbox turned off connects by itself and is not."}
          {" "}Nor are an MCP server that runs as a program on this machine, or the further connections of a web tool's helper program beyond the address it reports.
        </p>
      </section>

      <section className="rounded-lg border border-line bg-raised p-4 shadow-1" data-testid="network-by-host">
        <h3 className="mb-3 text-base font-medium">By host</h3>
        {!r.hosts.length ? <p className="k-empty">Nothing left this machine today.</p> : (
          <div className="-mx-4 overflow-x-auto">
            <table className="w-full text-ui">
              <thead>
                <tr className="border-b border-line text-left text-caption text-faint">
                  <th className={th}>Host</th><th className={th}>Ports</th><th className={cn(th, "text-right")}>Transfers</th><th className={cn(th, "text-right")}>Sent out</th><th className={cn(th, "text-right")}>Refused</th><th className={cn(th, "text-right")}>Sessions</th><th className={th}>By</th><th className={cn(th, "text-right")}>Last</th>
                </tr>
              </thead>
              <tbody>
                {r.hosts.map((h) => (
                  <Fragment key={h.host}>
                    <tr className="cursor-pointer border-b border-line/60 last:border-0 hover:bg-hover" onClick={() => setOpen(open === h.host ? null : h.host)} data-testid="network-host" data-host={h.host} data-new={h.new || undefined}>
                      <td className={cn(td, "max-w-80")}>
                        <span className="truncate font-mono text-caption">{h.host}</span>
                        {h.new && <span className="ml-2 rounded-xs bg-brass-soft px-1.5 py-px text-caption text-brass" title="No transfer went to this host before today" data-testid="network-new">new today</span>}
                      </td>
                      <td className={cn(td, "font-mono text-caption text-muted")}>{ports(h.ports) || "?"}</td>
                      <td className={cn(td, "text-right")}>{h.rows.toLocaleString()}</td>
                      <td className={cn(td, "text-right")}>{fmtSize(h.bytes)}{h.unknown_bytes > 0 && <span className="text-faint" title={`${plural(h.unknown_bytes, "transfer")} whose bytes are not counted (a git push, a body sent as a stream)`}> +?</span>}</td>
                      <td className={cn(td, "text-right", h.refused ? "text-st-fail" : "text-faint")}>{h.refused || "none"}</td>
                      <td className={cn(td, "text-right text-muted")}>{h.sessions}</td>
                      <td className={cn(td, "max-w-60 truncate text-caption text-muted")} title={list(h.tools).join(", ")}>{list(h.tools).join(", ")}</td>
                      <td className={cn(td, "text-right text-caption text-muted")}>{clock(h.last)}</td>
                    </tr>
                    {open === h.host && (
                      <tr className="border-b border-line/60 bg-sunken" data-testid="network-host-sessions">
                        <td colSpan={8} className="px-4 py-2">
                          <ul className="flex flex-col gap-1 text-caption">
                            {pairs(h.host).map((p) => (
                              <li key={p.session_id ?? ""} className="flex gap-3">
                                {p.session_id ? <button type="button" className="k-link truncate text-accent hover:underline" onClick={() => navigate({ name: "session", id: p.session_id! })}>{title(p.session_id)}</button> : <span className="text-muted">Keel itself</span>}
                                <span className="tabular-nums text-muted">{plural(p.rows, "transfer")}, {fmtSize(p.bytes)}{p.refused ? `, ${p.refused} refused` : ""}</span>
                                <span className="truncate text-faint">{list(p.tools).join(", ")}</span>
                              </li>
                            ))}
                          </ul>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {r.sessions.length > 0 && (
        <section className="rounded-lg border border-line bg-raised p-4 shadow-1" data-testid="network-by-session">
          <h3 className="mb-3 text-base font-medium">By session <span className="text-caption font-normal text-faint">an agent is listed by itself, under its parent's name</span></h3>
          <div className="-mx-4 overflow-x-auto">
            <table className="w-full text-ui">
              <thead>
                <tr className="border-b border-line text-left text-caption text-faint">
                  <th className={th}>Session</th><th className={cn(th, "text-right")}>Transfers</th><th className={cn(th, "text-right")}>Sent out</th><th className={cn(th, "text-right")}>Refused</th><th className={th}>Hosts</th>
                </tr>
              </thead>
              <tbody>
                {r.sessions.map((s) => (
                  <tr key={s.session_id ?? ""} className="border-b border-line/60 last:border-0" data-testid="network-session" data-session={s.session_id ?? ""}>
                    <td className={cn(td, "max-w-80")}>
                      {s.session_id ? <button type="button" onClick={() => navigate({ name: "session", id: s.session_id! })} className="k-link truncate hover:underline">{title(s.session_id)}</button> : <span className="text-muted">Keel itself</span>}
                      {s.parent_id && <span className="ml-2 text-caption text-faint">agent of {title(s.parent_id)}</span>}
                    </td>
                    <td className={cn(td, "text-right")}>{s.rows.toLocaleString()}</td>
                    <td className={cn(td, "text-right")}>{fmtSize(s.bytes)}</td>
                    <td className={cn(td, "text-right", s.refused ? "text-st-fail" : "text-faint")}>{s.refused || "none"}</td>
                    <td className={cn(td, "max-w-96 truncate font-mono text-caption text-muted")} title={list(s.hosts).join(", ")}>{list(s.hosts).join(", ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {r.recent.length > 0 && (
        <section className="rounded-lg border border-line bg-raised p-4 shadow-1" data-testid="network-recent">
          <h3 className="mb-3 text-base font-medium">Latest <span className="text-caption font-normal text-faint">the last {r.recent.length}</span></h3>
          <ol className="flex flex-col text-caption">
            {r.recent.map((x, i) => (
              <li key={i} className="flex items-baseline gap-3 border-b border-line/60 py-1 last:border-0" data-testid="network-row">
                <span className="w-12 shrink-0 tabular-nums text-faint">{clock(x.ts)}</span>
                <span className={cn("w-24 shrink-0", x.outcome === "refused" ? "text-st-fail" : x.outcome === "failed" ? "text-warn" : "text-muted")}>{OUTCOME[x.outcome] ?? x.outcome}</span>
                <span className="min-w-0 max-w-72 shrink truncate font-mono">{x.host}{x.port ? `:${x.port}` : ""}</span>
                <span className="w-20 shrink-0 text-right tabular-nums">{x.bytes_out === null ? "?" : fmtSize(x.bytes_out)}</span>
                <span className="w-40 shrink-0 truncate text-muted">{x.tool}{x.via ? <span className="text-faint">, {x.via}</span> : null}</span>
                <span className="min-w-0 flex-1 truncate text-faint" title={x.why ?? undefined}>{x.session_id ? title(x.session_id) : "Keel itself"}{x.why ? `: ${x.why}` : ""}</span>
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}

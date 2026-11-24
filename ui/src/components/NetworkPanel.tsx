// Settings > Network: what left this machine today, by host and by session,
// from the outward ledger (src/safety/egress.ts). A host first seen today is
// marked. With the sandbox off the page says what it cannot see.
import { useCallback, useEffect, useState } from "react";
import type { EgressReport } from "../../../src/safety/egress-report.ts";
import { every } from "../lib/clock.ts";
import { filterSaid } from "../lib/seccomp.ts";
import { api, reportError, useStore } from "../lib/store.ts";
import { navigate } from "../lib/ui.ts";
import { clock, fmtSize, when } from "../lib/utils.ts";
import { Stat, Stats } from "./Stat.tsx";
import { Cell, Empty, Group, Item, List, Notice, Page, Row, Status, Table, type Col } from "./settings/kit.tsx";

type Report = EgressReport & { sandbox: { available: boolean; default: string; reason?: string; seccomp?: boolean; seccompReason?: string } };

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
  if (!r) return <Empty>Reading the ledger.</Empty>;
  const title = (id: string | null) => (id ? sessions[id]?.title || r.sessions.find((s) => s.session_id === id)?.title || "a session" : "Keel itself");
  const t = r.totals;
  const off = !r.sandbox.available || r.sandbox.default === "off";
  const pairs = (host: string) => r.pairs.filter((p) => p.host === host);

  const H: Record<string, Col> = { host: { head: "Host", grow: true }, ports: { head: "Ports", minor: true }, rows: { head: "Transfers", end: true }, bytes: { head: "Sent out", end: true }, refused: { head: "Refused", end: true }, sessions: { head: "Sessions", end: true, minor: true }, by: { head: "By", minor: true }, last: { head: "Last", end: true, minor: true } };
  const S: Record<string, Col> = { session: { head: "Session", grow: true }, rows: { head: "Transfers", end: true }, bytes: { head: "Sent out", end: true }, refused: { head: "Refused", end: true }, hosts: { head: "Hosts", minor: true } };

  return (
    <Page testid="network-panel" intro={`Every transfer Keel made or carried since ${when(r.since)}: model requests, the web tools, MCP servers over HTTP, the fleet, exports, the OTLP export, phone pushes, its own git pushes, and what a sandboxed command sent through the sandbox's proxy. Bytes are what was sent out.`}>
      <Stats>
        <Stat testid="network-transfers" label="Transfers" value={t.rows.toLocaleString()} sub={t.refused ? `${t.refused} refused` : "none refused"} />
        <Stat testid="network-bytes" label="Sent out" value={fmtSize(t.bytes)} />
        <Stat testid="network-hosts" label="Hosts" value={t.hosts.toLocaleString()} sub={t.new_hosts ? `${t.new_hosts} never seen before today` : "all seen before"} />
        <Stat label="Sessions" value={t.sessions.toLocaleString()} />
      </Stats>

      <Notice testid="network-unseen" tone={off ? "warn" : undefined} title={off ? "The sandbox is off: commands' own connections are not here" : "What this page cannot see"}>
        {off
          ? `${r.sandbox.available ? "Sessions run their commands unconfined by default" : `The sandbox is not available on this machine${r.sandbox.reason ? ` (${r.sandbox.reason})` : ""}`}, so a command connects by itself (curl, git, a package manager, a script) and Keel never sees it. Only what Keel itself sends is listed.`
          : "A sandboxed command reaches the network only through Keel's proxy, so its connections are here. A session with its sandbox turned off connects by itself and is not."}
        {" "}Nor are an MCP server that runs as a program on this machine, or the further connections of a web tool's helper program beyond the address it reports.
      </Notice>

      <Group testid="network-by-host" title="By host" count={r.hosts.length || undefined} hint={r.hosts.length ? "A host's row opens the sessions that reached it." : undefined}>
        {!r.hosts.length ? <Empty>Nothing left this machine today.</Empty> : (
          <Table cols={Object.values(H)} label="By host">
            {r.hosts.map((h) => (
              <Row key={h.host} testid="network-host" data-host={h.host} data-new={h.new || undefined} title={h.host}
                name={<span className="font-mono text-caption">{h.host}</span>}
                after={h.new && <span className="ml-2"><Status tone="new" title="No transfer went to this host before today" testid="network-new">new today</Status></span>}
                open={open === h.host} onOpen={() => setOpen(open === h.host ? null : h.host)} detailTestid="network-host-sessions"
                detail={
                  <ul className="flex flex-col gap-1 text-caption">
                    {pairs(h.host).map((p) => (
                      <li key={p.session_id ?? ""} className="flex flex-wrap gap-x-3">
                        {p.session_id ? <button type="button" className="k-link k-truncate text-accent hover:underline" onClick={() => navigate({ name: "session", id: p.session_id! })}>{title(p.session_id)}</button> : <span className="text-muted">Keel itself</span>}
                        <span className="tabular-nums text-muted">{plural(p.rows, "transfer")}, {fmtSize(p.bytes)}{p.refused ? `, ${p.refused} refused` : ""}</span>
                        <span className="k-truncate text-faint">{list(p.tools).join(", ")}</span>
                      </li>
                    ))}
                  </ul>
                }>
                <Cell col={H.ports!} className="font-mono text-caption text-muted">{ports(h.ports) || "?"}</Cell>
                <Cell col={H.rows!}>{h.rows.toLocaleString()}</Cell>
                <Cell col={H.bytes!}>{fmtSize(h.bytes)}{h.unknown_bytes > 0 && <span className="text-faint" title={`${plural(h.unknown_bytes, "transfer")} whose bytes are not counted (a git push, a body sent as a stream)`}> +?</span>}</Cell>
                <Cell col={H.refused!} className={h.refused ? "text-st-fail" : "text-faint"}>{h.refused || "none"}</Cell>
                <Cell col={H.sessions!} className="text-muted">{h.sessions}</Cell>
                <Cell col={H.by!} className="max-w-60 k-truncate text-caption text-muted" title={list(h.tools).join(", ")}>{list(h.tools).join(", ")}</Cell>
                <Cell col={H.last!} className="text-caption text-muted">{clock(h.last)}</Cell>
              </Row>
            ))}
          </Table>
        )}
      </Group>

      {r.sessions.length > 0 && (
        <Group testid="network-by-session" title="By session" count={r.sessions.length} hint="An agent is listed by itself, under its parent's name.">
          <Table cols={Object.values(S)} label="By session">
            {r.sessions.map((x) => (
              <tr key={x.session_id ?? ""} data-testid="network-session" data-session={x.session_id ?? ""}>
                <Cell col={S.session!}>
                  {x.session_id ? <button type="button" onClick={() => navigate({ name: "session", id: x.session_id! })} className="k-link k-truncate hover:underline">{title(x.session_id)}</button> : <span className="text-muted">Keel itself</span>}
                  {x.parent_id && <span className="ml-2 text-caption text-faint">agent of {title(x.parent_id)}</span>}
                </Cell>
                <Cell col={S.rows!}>{x.rows.toLocaleString()}</Cell>
                <Cell col={S.bytes!}>{fmtSize(x.bytes)}</Cell>
                <Cell col={S.refused!} className={x.refused ? "text-st-fail" : "text-faint"}>{x.refused || "none"}</Cell>
                <Cell col={S.hosts!} className="max-w-96 k-truncate font-mono text-caption text-muted" title={list(x.hosts).join(", ")}>{list(x.hosts).join(", ")}</Cell>
              </tr>
            ))}
          </Table>
        </Group>
      )}

      {r.recent.length > 0 && (
        <Group testid="network-recent" title="Latest" count={`the last ${r.recent.length}`}>
          <List label="Latest" dense>
            {r.recent.map((x, i) => (
              <Item key={i} testid="network-row" mono name={`${x.host}${x.port ? `:${x.port}` : ""}`}
                sub={<span className="block k-truncate" title={x.why ?? undefined}>{x.tool}{x.via ? `, ${x.via}` : ""}. {x.session_id ? title(x.session_id) : "Keel itself"}{x.why ? `: ${x.why}` : ""}</span>}
                status={x.outcome === "sent" ? undefined : <Status tone={x.outcome === "refused" ? "broken" : "warn"}>{OUTCOME[x.outcome] ?? x.outcome}</Status>}
                meta={<>
                  <span className="w-16 text-right">{x.bytes_out === null ? "?" : fmtSize(x.bytes_out)}</span>
                  <span className="w-12 text-right text-faint">{clock(x.ts)}</span>
                </>} />
            ))}
          </List>
        </Group>
      )}
    </Page>
  );
}

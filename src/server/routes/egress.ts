// GET /api/egress?since_ms=&until_ms=&session_id=&recent=
// What left the daemon: every outward transfer it made or carried, by host and
// by session, with the hosts first seen in the range marked (src/safety/egress.ts).
// The range is today (from local midnight) unless it is named. The report is
// read on the read thread. `sandbox`: whether commands are confined by
// default, since with the sandbox off a command's own connections are not seen.
import { noteDetached, noteOutward, outwardLabel, setEgressSink, tagFor, tagged, tapFetch } from "../../safety/egress.ts";
import { dayStart, endpointOf, pushFailure } from "../../safety/egress-count.ts";
import { onGitPush } from "../../core/git.ts";
import { EGRESS_SCHEMA } from "../../safety/egress-report.ts";
import { onProxyConn } from "../../safety/net-proxy.ts";
import { sandboxStatus } from "../../safety/sandbox.ts";
import { registerHooks } from "../../engine/hooks.ts";
import { errorScope } from "../../core/errors.ts";
import { setCallEnv } from "../../tools/jobs.ts";
import type { RouteModule } from "../app.ts";
import { readsOf } from "../reads.ts";
import { gate } from "./permissions.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });
let untap: (() => void) | undefined;

export const egressRoutes: RouteModule = ({ store }) => {
  store.migrate(EGRESS_SCHEMA);
  // A row waits with the other side writes and is made in their commit (src/core/side.ts).
  // The ledger of a store from before the sealed record has no `prev` column.
  if (!store.columnExists("egress", "prev")) store.db.exec("ALTER TABLE egress ADD COLUMN prev BLOB");
  setEgressSink((o) => store.side.later("an outward transfer's row", () => store.addEgress(o)));
  // (A hot reload taps the fetch it finds again: the old tap is taken away first.)
  untap?.();
  untap = tapFetch();
  // A sandboxed command's connections, from the proxies' thread: the call is the one its relay's tag names.
  onProxyConn((c) => {
    const t = tagged(c.tag);
    noteDetached({ tool: t?.tool ?? "sandboxed command", via: "sandbox proxy", session: t?.session ?? null, call: t?.call ?? null, turn: t?.turn ?? null, host: c.host, port: c.port, bytes: c.bytes, outcome: c.outcome, why: c.why ?? null, at: c.at });
  });
  // The daemon's own git pushes (a landing, a tool that pushes): git connects by itself, so the bytes are not counted.
  // A failed one is kept as its class: git's own words name the remote's path, and can hold a token.
  onGitPush(({ to, ok, err }) => {
    const end = endpointOf(to);
    if (!end) return;
    noteOutward({ tool: outwardLabel()?.tool ?? "git push", via: "git push", host: end.host, port: end.port, bytes: null, outcome: ok ? "sent" : "failed", ...(ok ? {} : { why: pushFailure(err) }) });
  });
  registerHooks({
    // Every shell call's commands carry its tag: the sandbox's relay puts it before each connection.
    beforeTool: (s, call) => {
      if (call.tool.kind !== "shell") return;
      const turn = errorScope.getStore();
      setCallEnv(s.id, call.id, { KEEL_EGRESS_TAG: tagFor({ session: s.id, call: call.id, tool: call.tool.name, turn: turn?.session === s.id ? turn.turn ?? null : null }) });
    },
  });
  return {
    "/api/egress": {
      GET: async (req: Request) => {
        const q = new URL(req.url).searchParams;
        const num = (k: string) => (q.get(k) === null || q.get(k) === "" ? undefined : Number(q.get(k)));
        const since = num("since_ms") ?? dayStart(Date.now());
        const until = num("until_ms");
        const recent = num("recent");
        if (!Number.isFinite(since) || (until !== undefined && !Number.isFinite(until)) || (recent !== undefined && !(recent >= 0))) return json({ error: "since_ms, until_ms and recent are numbers" }, 400);
        const report = await readsOf(store).run("egress.report", { since, ...(until !== undefined ? { until } : {}), ...(q.get("session_id") ? { session: q.get("session_id")! } : {}), ...(recent !== undefined ? { recent } : {}) });
        const sb = sandboxStatus();
        const by = gate?.defaultSandbox() ?? "off";
        // (The syscall filter's state, once the sandbox reports one: src/safety/sandbox.ts.)
        const f = sb as { seccomp?: boolean; seccompReason?: string };
        return json({ ...report, sandbox: { available: sb.available, default: sb.available ? by : "off", ...(sb.available ? {} : { reason: sb.reason }), ...(sb.available && typeof f.seccomp === "boolean" ? { seccomp: f.seccomp, ...(f.seccompReason ? { seccompReason: f.seccompReason } : {}) } : {}) } });
      },
    },
  };
};

import { expect, test } from "./isolate.ts";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ErrorRecord, StoredEvent } from "../../src/core/types.ts";
import { exited, ownDaemon, ownEnv } from "./peer.ts";
import { choose, shoot } from "./shots.ts";

// Feature: what the owner reads about the past is true and complete. A small
// workload on a daemon of the spec's own (the scripted stand-in, a collector
// of its own for the exported spans, nothing of the caller's environment):
// failures of one kind in two sessions, a failure a retry healed, a slow
// request, a declined turn, a session of several turns, an agent, a stopped
// turn, a command that failed and printed a key, a message between sessions,
// an approval left open and a tool left running. Then the daemon is killed
// and started again, and each statement is checked against the API and the
// text forms: the Errors list, the away digest and the daemon's log, spend
// and time, Activity, times and words, search, messages, and what a
// collector received.
const ROOT = join(process.env.HOME!, ".cache/keel-work/bun/e2e-state");
const script = (calls: unknown[]) => `script:calls ${JSON.stringify(calls)}`;
const bash = (command: string) => ({ name: "Bash", input: { command } });
// Put together here, so this file holds nothing a scanner reads as a key.
const KEY = ["sk", "ant", "api03", "PLANTEDKEY0123456789abcdefghijklmnopqrstuvwxyzABCDEFGH"].join("-");

// What a failing command prints that is no secret: hashes, ids, paths and assignments. It reaches the model as it was printed.
const PLAIN = [
  "commit 74d3746b32778b32a6cede971201681baeab64ed", "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  "/srv/app/sk-learn-notebooks-2026/readme.md: No such file or directory", "sketch-book-of-drawings-and-other-things.pdf was not found",
  "monkey=banana and key=value pairs", "session 01a2023d-1cda-7373-8409-6d94cb93121f failed at /home/user/project/src/skill.md:12",
];

const made: string[] = [];
test.afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

// What the workload left, for every test below: one daemon, killed once and started again.
async function build() {
  const state = join(ROOT, `past-truth-${Date.now()}`);
  made.push(state);
  mkdirSync(state, { recursive: true });
  // A collector for the exported spans: every span it was sent, by id.
  const spans = new Map<string, { parent?: string; name: string; interrupted: boolean }>();
  const collector = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url?.endsWith("/v1/traces")) {
        for (const rs of JSON.parse(body).resourceSpans ?? []) for (const ss of rs.scopeSpans ?? []) for (const s of ss.spans ?? []) {
          spans.set(s.spanId, { parent: s.parentSpanId || undefined, name: s.name, interrupted: (s.attributes ?? []).some((a: any) => a.key === "keel.interrupted") });
        }
      }
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  await new Promise<void>((r) => collector.listen(0, "127.0.0.1", r));
  const collectorUrl = `http://127.0.0.1:${(collector.address() as { port: number }).port}`;
  const env = { KEEL_RESUME_GAP_MS: "0" };
  let d = await ownDaemon(state, 0, env);
  const call = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
    fetch(d.url + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async (r) => {
      const t = await r.text();
      try { return JSON.parse(t); } catch { return t; }
    }) as Promise<any>;
  const text = (path: string) => fetch(d.url + path).then((r) => r.text());
  const keel = (...args: string[]) => {
    const r = spawnSync("bun", ["src/main.ts", ...args, "--url", d.url], { env: ownEnv(state), encoding: "utf8" });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  // Where the run is, in the log of a run that stops part way.
  const t0 = Date.now();
  const mark = (what: string) => console.log(`[past-truth] ${((Date.now() - t0) / 1000).toFixed(1)} s: ${what}`);
  // Where the run is, in the log of a run that stops part way.
  const close = async () => {
    // (A daemon the test already killed has no exit code, only its signal: it is not waited for again.)
    if (d.proc.exitCode === null && d.proc.signalCode === null) { d.proc.kill("SIGKILL"); await exited(d.proc); }
    collector.closeAllConnections();
    await new Promise((r) => collector.close(r));
  };
  try {
    const ids: Record<string, string> = {};
    const open = async (title: string, mode = "full-auto") => {
      const { session } = await call("/api/sessions", { model: "scripted:stand-in", title });
      await call(`/api/sessions/${session.id}/permissions`, { mode }, "PUT");
      return (ids[title] = session.id as string);
    };
    const send = (title: string, text: string) => call(`/api/sessions/${ids[title]}/messages`, { text });
    const view = (id: string) => call(`/api/sessions/${id}`);
    const idle = (title: string) => expect.poll(async () => (await view(ids[title]!)).running, { timeout: 60_000 }).toBe(false);
    const run = async (title: string, text: string) => { await send(title, text); await idle(title); mark(`ran ${title}`); };

    // The collector is set by a settings change: its line in the log names what changed and not the address.
    await call("/api/settings", { observe: { otlp_endpoint: `${collectorUrl}/v1/traces` } }, "PATCH");

    // --- the workload
    for (const t of ["Billing A", "Billing B"]) { await open(t); for (let i = 1; i <= 2; i++) await run(t, `Round ${i} script:billing`); }
    await open("Overloaded"); await run("Overloaded", "script:overloaded");
    await open("Slow provider"); await run("Slow provider", "script:slow");
    await open("Refuses"); await run("Refuses", "script:refuse");
    await open("Many turns");
    for (let i = 0; i < 6; i++) await run("Many turns", i === 3 ? `Turn ${i} ${script([bash("echo first"), bash("echo second"), bash("echo third")])}` : `Turn ${i} script:say Reply ${i}.`);
    await open("Push"); await run("Push", `Push it\n${script([bash("git push origin main 2>&1; exit 1")])}`);
    await open("Private marker"); await run("Private marker", `Deploy\n${script([bash(`echo tool-marker ${KEY}; exit 5`)])}`);
    await open("Plain failure"); await run("Plain failure", `Build\n${script([bash(`printf '%s\\n' ${PLAIN.map((l) => `'${l}'`).join(" ")}; exit 3`)])}`);
    await open("Coordinator");
    await run("Coordinator", script([{ name: "spawn_agent", input: { message: "Lane\nscript:say The lane is done.", isolation: "none" } }, { name: "wait_agent", input: { timeout_ms: 30000 } }]));
    await open("Stopped");
    await send("Stopped", script([bash("sleep 60; echo never")]));
    await expect.poll(async () => (await view(ids.Stopped!)).running, { timeout: 30_000 }).toBe(true);
    await call(`/api/sessions/${ids.Stopped}/interrupt`, { by: "owner" });
    await idle("Stopped");
    // A message to a session that is at work: queued, then read, then handled.
    await open("Receiver"); await send("Receiver", script([bash("sleep 4; echo busy-done")]));
    await open("Sender"); await run("Sender", script([{ name: "keel__session_send", input: { to: ids.Receiver, text: "Tell me when the build is green." } }]));
    const sentAs = async () => (await call(`/api/sessions/${ids.Sender}/peer-messages`)).messages as { state: string; direction: string; other: { title: string }; state_ms: number | null }[];
    const sentFirst = (await sentAs()).map((m) => [m.direction, m.other.title, m.state]);
    await expect.poll(async () => (await sentAs())[0]!.state, { timeout: 60_000 }).toBe("handled");
    // What the kill will find open: an approval that waits on the owner, and a command still running.
    await open("Needs approval", "default");
    await send("Needs approval", `Touch a file\n${script([bash("touch approval-marker.txt && rm -rf ./build-out")])}`);
    const approval = async () => (await call(`/api/sessions/${ids["Needs approval"]}/approvals`)).approvals[0] as { id: string; created: number } | undefined;
    await expect.poll(async () => !!(await approval()), { timeout: 30_000 }).toBe(true);
    const askedAlert = async () => ((await call("/api/alerts?limit=100")).alerts as any[]).find((a) => a.kind === "approval" && a.session_id === ids["Needs approval"]);
    await expect.poll(async () => !!(await askedAlert()), { timeout: 15_000 }).toBe(true);
    const asked = { approval: (await approval())!.created, alert: (await askedAlert()).ts as number };
    await open("Long tool");
    await send("Long tool", `Run it\n${script([bash("sleep 12; echo slept")])}`);
    await expect.poll(async () => ((await view(ids["Long tool"]!)).events as StoredEvent[]).some((e) => e.kind === "assistant" && (e.data.blocks as any[]).some((b) => b.type === "tool_use")), { timeout: 30_000 }).toBe(true);
    await call("/api/debug/export/flush", {});

    mark("the workload is done");
    // --- the kill, and the next start
    const since = Date.now() - 10 * 60_000;
    const downAt = Date.now();
    d.proc.kill("SIGKILL");
    await exited(d.proc);
    // Before the next start the collector holds spans whose parents it never got: the turns the kill cut.
    const orphans = () => [...spans.entries()].filter(([, s]) => s.parent && !spans.has(s.parent)).map(([id, s]) => `${s.name} ${id}`);
    expect(orphans().length).toBeGreaterThan(0);
    d = await ownDaemon(state, d.port, env);
    await expect.poll(async () => !!(await call("/api/daemon")).last_start?.settled_ms, { timeout: 60_000 }).toBe(true);

    mark("the daemon is back");
    // The wait on the owner as the daemon tells it after the restart, and the digest that counts it.
    // Then the owner denies it, so its turn ends and every span has an end.
    await expect.poll(async () => !!(await approval()), { timeout: 30_000 }).toBe(true);
    await expect.poll(async () => !!(await askedAlert()), { timeout: 15_000 }).toBe(true);
    const back = { approval: (await approval())!.created, alert: (await askedAlert()).ts as number, state: (await call("/api/state")).states[ids["Needs approval"]!] as { watch: string; since: number } };
    const away = await text(`/api/away?since=${since}&format=text`);
    const digest = (await call(`/api/away?since=${since}`)).away;
    await call(`/api/sessions/${ids["Needs approval"]}/approvals/${(await approval())!.id}`, { choice: "deny", reason: "not now" });
    for (const t of ["Needs approval", "Long tool"]) await idle(t);
    const log = async (q: string) => ((await call(`/api/logs?limit=2000&q=${encodeURIComponent(q)}`)).lines as { text: string; ts: number; session?: string }[]);
    // A stop that was asked for, and the next start: the last test's.
    const stopAndStart = async () => { d.proc.kill("SIGTERM"); await exited(d.proc); d = await ownDaemon(state, d.port, env); };
    return { url: () => d.url, state, collectorUrl, call, text, keel, log, ids, since, downAt, spans, orphans, asked, back, away, digest, sentFirst, sentAs, stopAndStart, close };

  } catch (e) {
    await close();
    throw e;
  }
}

// One test a feature, over the same workload: a failure names what is not true. (They read; only the
// last one stops the daemon. After a failure the worker starts again and builds the workload anew.)
test.describe("after a kill", () => {
  test.describe.configure({ timeout: 300_000 });
  let W: Awaited<ReturnType<typeof build>>;
  test.beforeAll(async () => { W = await build(); });
  test.afterAll(async () => { await W?.close(); });

  test("a wait on the owner keeps the time it was first asked, and a message its true state", async () => {
    const { asked, back, sentFirst, sentAs, call, ids } = W;
    // --- 5: the alert, the card and the session's state all count from when it was first asked, across the restart
    expect([back.alert, back.approval]).toEqual([asked.alert, asked.approval]);
    expect([back.state.watch, back.state.since]).toEqual(["need", asked.approval]);
    // --- 7: a message sent to a session at work was queued, then handled, and both sides say so
    expect(sentFirst).toEqual([["sent", "Receiver", "queued"]]);
    expect((await sentAs()).map((m) => m.state)).toEqual(["handled"]);
    const got = (await call(`/api/sessions/${ids.Receiver}/peer-messages`)).messages;
    expect([got[0].direction, got[0].other.title, got[0].state]).toEqual(["received", "Sender", "handled"]);
  });

  test("a repeated error lists each session it happened in, and a healed one is recovered", async () => {
    const { call, text, keel, ids, url } = W;
    // --- 1: errors
    const errors = (await call("/api/errors")).errors as ErrorRecord[];
    const billing = errors.find((e) => e.message.includes("credit balance"))!;
    // One kind, four times, in two sessions: each listed with its own count, its own turn and span.
    expect(billing.count).toBe(4);
    expect(billing.sites!.map((s) => [s.title, s.count, s.healed]).sort()).toEqual([["Billing A", 2, 0], ["Billing B", 2, 0]]);
    const siteA = billing.sites!.find((s) => s.session_id === ids["Billing A"])!;
    expect(siteA.turn_event && siteA.span_id).toBeTruthy();
    expect((await call(`/api/debug/spans/${siteA.span_id}`)).span.session_id).toBe(ids["Billing A"]);
    // Opened from Billing A it is Billing A's failure, though it last happened in Billing B.
    expect(billing.session_id).toBe(ids["Billing B"]);
    const bundle = await text(`/api/debug/bundle?error_id=${billing.id}&session_id=${ids["Billing A"]}`);
    expect(bundle).toContain(`- Session \`${ids["Billing A"]}\` "Billing A"`);
    expect(bundle).toContain(`- Turn \`${siteA.turn_event}\``);
    expect(bundle).toContain(`span \`${siteA.span_id}\``);
    expect(bundle).not.toContain(`- Session \`${ids["Billing B"]}\``);
    // It says the kind's own count and, beside it, this session's.
    expect(bundle).toMatch(/- Seen 4 times in all: first [^\n]+, last [^\n]+\n- In this session: 2 times, last /);
    // Asked with a session the kind never happened in, there is no failure of that session to bundle.
    const never = await fetch(`${url()}/api/debug/bundle?error_id=${billing.id}&session_id=${ids.Push}`);
    expect([never.status, (await never.json()).error]).toEqual([404, expect.stringMatching(/^that error did not happen in this session; it happened in "Billing [AB]", "Billing [AB]"$/)]);
    expect(((await call(`/api/errors?session=${ids["Billing A"]}`)).errors as ErrorRecord[]).map((e) => e.id)).toContain(billing.id);
    // A failure a retry healed is recovered: read, and not among the open ones.
    const healed = errors.find((e) => e.message.includes("529 overloaded"))!;
    expect([!!healed.recovered_ts, !!healed.read_ts, healed.sites![0]!.healed, healed.sites![0]!.count]).toEqual([true, true, healed.count, healed.count]);
    expect(billing.recovered_ts).toBeUndefined();
    const listed = keel("debug", "errors");
    expect(listed.out).toMatch(/^\d+ open, 1 recovered \(a retry passed\)\. Times are local \(UTC[+-]?[\d:]*\)\./);
    expect(listed.out).toMatch(new RegExp(`2x  Billing A, last \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d:\\d\\d  \\(keel debug ${billing.id.slice(-12)} --session ${ids["Billing A"]!.slice(-12)}\\)`));
    expect(keel("debug", billing.id.slice(-12), "--session", ids["Billing A"]!.slice(-12)).out).toContain(`"Billing A"`);

  });

  test("no stored failure text holds a key a tool printed, and no exported span lacks its parent", async () => {
    const { call, text, ids, spans, orphans } = W;
    const errors = (await call("/api/errors")).errors as ErrorRecord[];
    // --- 8: no stored failure text holds the key a tool printed; no exported span lacks its parent
    const mine = await call(`/api/errors?session=${ids["Private marker"]}`);
    expect(JSON.stringify(mine.failures)).toContain("tool-marker <redacted>");
    const trace = (await call(`/api/debug/traces?session_id=${ids["Private marker"]}`)).traces[0];
    const toolSpan = ((await call(`/api/debug/traces/${trace.trace_id}`)).spans as any[]).find((s) => s.kind === "tool")!;
    expect(toolSpan.error).toContain("tool-marker <redacted>");
    for (const stored of [JSON.stringify(mine), JSON.stringify(errors), JSON.stringify(toolSpan), await text(`/api/debug/bundle?session_id=${ids["Private marker"]}`)]) expect(stored).not.toContain("PLANTEDKEY");
    // A failing command's output that holds no secret is in its tool result byte for byte, and in what is kept of the failure.
    const plain = ((await call(`/api/sessions/${ids["Plain failure"]}`)).events as StoredEvent[]).filter((e) => e.kind === "tool_result").flatMap((e) => e.data.results as { content: unknown }[]);
    expect(plain).toHaveLength(1);
    expect(String(plain[0]!.content)).toContain(PLAIN.join("\n"));
    const kept = JSON.stringify([await call(`/api/errors?session=${ids["Plain failure"]}`), ((await call(`/api/debug/traces/${(await call(`/api/debug/traces?session_id=${ids["Plain failure"]}`)).traces[0].trace_id}`)).spans as any[]).find((x) => x.kind === "tool")]);
    expect(kept).toContain(PLAIN[0]);
    expect(kept).not.toContain("<redacted>");
    await call("/api/debug/export/flush", {});
    await expect.poll(async () => { await call("/api/debug/export/flush", {}); return orphans(); }, { timeout: 30_000 }).toEqual([]);
    expect([...spans.values()].filter((s) => s.interrupted).length).toBeGreaterThanOrEqual(2);

  });

  test("the away digest and the daemon's log tell what the daemon went through", async () => {
    const { call, keel, log, ids, away, digest, state, url, collectorUrl } = W;
    // --- 2: the away digest and the daemon's log
    const first = away.split("\n")[0]!;
    expect(first).toMatch(/^From \d\d:\d\d:\d\d to \d\d:\d\d:\d\d UTC([+-]\d\d:\d\d)? \(1\d min\): the daemon went down and came back after \d+ (ms|s), 2 turns cut; /);
    expect(first).toContain("1 approval waits");
    expect(away.split("\n")[1]).toMatch(/^The daemon went down without stopping \(killed, or the machine went down\) at about \d\d:\d\d:\d\d and came back at \d\d:\d\d:\d\d UTC([+-]\d\d:\d\d)? \(down \d+ (ms|s)\); 2 turns were cut: /);
    expect(away.length).toBeLessThan(3000); // read in under a minute
    expect(keel("status", "--away", "--since", "10m").out.split("\n")[0]).toContain("the daemon went down and came back after");
    expect([digest.daemon.length, digest.totals.approvals, typeof digest.daemon_brief]).toEqual([1, 1, "string"]);
    // The log: a start, what it found, the settings change, the owner's Stop, the agent, and (below) a clean stop. One line each.
    const starts = await log("[daemon] started");
    expect(starts).toHaveLength(2);
    expect(starts[1]!.text).toMatch(new RegExp(`^\\[daemon\\] started: Keel \\S+, pid \\d+, at ${url()}; state ${state}; config ${join(state, "config")}$`));
    await expect.poll(async () => (await log("[daemon] providers found")).length, { timeout: 30_000 }).toBe(2);
    expect((await log("[daemon] providers found"))[1]!.text).toMatch(/^\[daemon\] providers found: .*scripted \(\d+ models\)/);
    await expect.poll(async () => (await log("[daemon] MCP servers")).length, { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
    const changed = await log("[daemon] settings changed");
    expect(changed.map((l) => l.text)).toEqual(["[daemon] settings changed: observe.otlp_endpoint set"]);
    expect(JSON.stringify(await log("127.0.0.1"))).not.toContain(collectorUrl);
    const stopped = await log("[turn] stopped by the owner");
    expect(stopped.map((l) => l.session)).toEqual([ids.Stopped]);
    const agentLines = (await log("[agent]")).filter((l) => l.session === ids.Coordinator).map((l) => l.text.replace(/ after .*$/, "").replace(/ \[agent session .*$/, ""));
    expect(agentLines).toEqual(['[agent] started: "Lane" (general-purpose, in the background)', '[agent] ended: "Lane" reported']);
    expect((await log("spans the last daemon left running")).length + (await log("span the last daemon left running")).length).toBe(1);
    const printed = keel("debug", "log", "--grep", "[daemon] started");
    expect(printed.err).toMatch(/Times are local \(UTC[+-]?[\d:]*\); the files and --json keep UTC/);
    expect(printed.out.split("\n")[0]).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3} INFO  \[daemon\] started: /);

  });

  test("spend is ranked by session and agent tree, the slowest requests are listed, and two turns compare", async () => {
    const { call, keel, ids, since } = W;
    // --- 3: spend and time
    const ranked = await call(`/api/usage?group=session&sort=cost&since_ms=${since}`);
    expect(ranked.buckets[0].key).toBe(ids["Many turns"]);
    expect(ranked.sessions[ids["Many turns"]!].title).toBe("Many turns");
    const costs = ranked.buckets.map((b: any) => b.priced_cost_usd);
    expect(costs).toEqual([...costs].sort((a, b) => b - a));
    const trees = await call(`/api/usage?group=tree&sort=cost&since_ms=${since}`);
    const tree = trees.buckets.find((b: any) => b.key === ids.Coordinator);
    const own = ranked.buckets.find((b: any) => b.key === ids.Coordinator).priced_cost_usd;
    expect([tree.agents, tree.own_cost_usd, tree.priced_cost_usd > own]).toEqual([1, own, true]);
    expect(Math.abs(tree.priced_cost_usd - tree.own_cost_usd - tree.agents_cost_usd)).toBeLessThan(1e-9);
    const usage = keel("usage", "--hours", "1");
    expect(usage.out).toMatch(/Spend by session, the last 1 hour, dearest first:\n +1\. +\$[\d.]+ +\d+ requests  Many turns  \[session=[0-9a-f]{12}\]/);
    expect(usage.out).toMatch(/Spend by agent tree \(a session with the agents under it\):[\s\S]*Coordinator, \$[\d.]+ of it in 1 agent/);
    // The slowest requests of the last hour, across sessions: the slow provider's first.
    const slow = await call("/api/telemetry/slowest?period=hour&limit=5");
    expect(slow.requests[0].session_id).toBe(ids["Slow provider"]);
    expect(slow.requests[0].latency_ms).toBeGreaterThanOrEqual(2900);
    expect(slow.requests.map((q: any) => q.latency_ms)).toEqual([...slow.requests.map((q: any) => q.latency_ms)].sort((a, b) => b - a));
    expect(keel("usage", "--hours", "1", "--slow", "3").out.split("\n")[1]).toMatch(/^ +3\.\d\d s  first word .*Slow provider  \[session=/);
    expect((await call("/api/telemetry?period=hour")).total.calls).toBe((await call(`/api/telemetry?since_ms=${since}`)).total.calls);
    // Two turns side by side: the turn with three commands against the one before it.
    const turns = await call(`/api/telemetry/turns?session_id=${ids["Many turns"]}`);
    expect([turns.counts.turns, turns.turns[0].n, turns.turns.at(-1).n]).toEqual([6, 6, 1]);
    const [t4, t3] = [turns.turns.find((t: any) => t.n === 4), turns.turns.find((t: any) => t.n === 3)];
    const pair = await call(`/api/telemetry/turns?session_id=${ids["Many turns"]}&a=${t4.turn_event}&b=${t3.turn_event}`);
    expect([pair.a.n, pair.b.n, pair.a.requests, pair.b.requests, pair.a.tool_calls]).toEqual([4, 3, 4, 1, 3]);
    expect(pair.diff.cost).toMatch(/^Turn 4 cost \$[\d.]+ more than turn 3 \(\$[\d.]+ against \$[\d.]+\): /);
    expect(pair.diff.time).toMatch(/^Turn 4 took .* longer than turn 3 /);
    expect(pair.diff.also.join(" ")).toContain("Turn 4 made 4 requests; turn 3 1 request.");
    // A turn's request count holds its failed attempts and says so; the session's count is the ledger's.
    const over = await call(`/api/telemetry/turns?session_id=${ids.Overloaded}`);
    expect([over.turns[0].requests, over.turns[0].failed_attempts, over.counts.requests, over.counts.failed]).toEqual([3, 2, 3, 2]);
    expect(over.counts.requests).toBe((await call(`/api/telemetry?session_id=${ids.Overloaded}`)).total.calls);

  });

  test("one range shows one failed share, a chart's bucket says when its data was, and a refusal is Declined", async () => {
    const { call, ids, since, downAt } = W;
    // --- 5: one failed share for a range in every Usage view; a chart's bucket says when its data was
    const report = await call(`/api/telemetry?since_ms=${since}`);
    const compare = await call(`/api/telemetry/compare?a_since_ms=${since}&a_until_ms=${report.until_ms}&b_since_ms=${since - 1000}&b_until_ms=${since}`);
    expect(report.total.failed).toBe(report.error_classes.reduce((n: number, e: any) => n + e.count, 0));
    expect(compare.a.failed).toBe(report.total.failed);
    expect(compare.a.failed_share).toBe(report.total.failed / compare.a.calls);
    for (const p of report.series) expect(p.last_ms >= p.t_ms && p.last_ms < p.t_ms + report.bucket_ms && p.last_ms >= downAt - 10 * 60_000).toBe(true);
    // A turn the model declined is Declined in the Inbox, never Finished.
    const refused = ((await call("/api/alerts?limit=100")).alerts as any[]).filter((a) => a.session_id === ids.Refuses);
    expect(refused.map((a) => [a.kind, a.title])).toEqual([["declined", "Declined: Refuses"]]);

  });

  test("Activity is one row a turn, with failures, a time range, a session and a text form", async () => {
    const { call, keel, ids, downAt } = W;
    // --- 4: activity
    const many = (await call(`/api/activity?session_id=${ids["Many turns"]}&limit=100`)).items as any[];
    // One row a turn, each with what the turn said at its end; the alert of its end is no row of its own.
    expect(many.filter((a) => a.kind === "turn").map((a) => a.said)).toEqual([5, 4, 3, 2, 1, 0].map((i) => (i === 3 ? expect.stringContaining("Done with 3 calls") : `Many turns: Reply ${i}.`)));
    expect(many.filter((a) => a.kind === "alert" && a.sub === "finished")).toEqual([]);
    const capped = (await call("/api/activity?cap=3&limit=200")).items as any[];
    const ofMany = capped.filter((a) => a.session_id === ids["Many turns"]);
    expect([ofMany.length, ofMany.at(-1).more]).toEqual([3, many.length - 3]);
    const wrong = (await call("/api/activity?only=failures&limit=200")).items as any[];
    expect(wrong.length).toBeGreaterThanOrEqual(6);
    expect(wrong.every((a) => (a.kind === "turn" && ["error", "refusal", "max_tokens"].includes(a.sub)) || a.kind === "daemon" || a.kind === "agent" || a.kind === "alert" || (a.kind === "approval" && a.sub === "denied"))).toBe(true);
    expect(wrong.some((a) => a.kind === "daemon" && a.sub === "killed")).toBe(true);
    expect(wrong.find((a) => a.session_id === ids.Refuses).text).toBe("Refuses: turn declined by the model");
    expect(((await call(`/api/activity?since=${downAt}&limit=200`)).items as any[]).every((a) => a.ts >= downAt)).toBe(true);
    expect(((await call(`/api/activity?until=${downAt}&session_id=${ids["Billing A"]}`)).items as any[]).filter((a) => a.kind === "turn")).toHaveLength(2);
    const activity = keel("activity", "--failures", "--since", "1h");
    expect(activity.out.split("\n")[0]).toMatch(/^Activity, failures only, since \d{4}-\d\d-\d\d \d\d:\d\d:\d\d, newest first\. Times are local \(UTC[+-]?[\d:]*\)\.$/);
    expect(activity.out).toMatch(/\n  \d\d:\d\d:\d\d  turn     Billing A: turn failed \(HTTP 402: Scripted: your credit balance is too low/);

  });

  test("a search hit says when it happened, and a search is limited in its own words", async () => {
    const { call, keel, ids, since, url } = W;
    // --- 6: search
    const hits = (q: string) => call(`/api/search?q=${encodeURIComponent(q)}&limit=20`);
    const pushed = await hits("git push in:commands since:today");
    expect(pushed.limits).toEqual(["commands", expect.stringMatching(/^since \d{4}-\d\d-\d\d 00:00 UTC([+-]\d\d:\d\d)?$/)]);
    // since: is from then on: what since:today finds, since:yesterday finds too, in either order of the limits.
    const n = async (q: string) => (await hits(q)).hits.length;
    expect([await n("git push since:yesterday"), await n("git push since:yesterday until:today"), await n("git push until:today since:yesterday")]).toEqual(Array(3).fill(await n("git push since:today")));
    expect(await n("git push since:today")).toBeGreaterThan(1);
    // on: is the day alone: nothing happened yesterday on this daemon.
    expect([await n("git push on:yesterday"), await n("git push on:today")]).toEqual([0, await n("git push since:today")]);
    // A limit that is not understood is refused with what it takes, not searched as a word.
    for (const q of ["git push since:lastweek", "git push state:bogus", "git push since:99999999999d"]) {
      const r = await fetch(`${url()}/api/search?q=${encodeURIComponent(q)}`);
      const body = await r.json();
      expect([q, r.status, body.limit, /NaN/.test(body.error)]).toEqual([q, 400, true, false]);
      expect(body.error).toMatch(/is not a limit this search knows\. (since: and until: take|state: takes) /);
    }
    expect(pushed.hits.map((h: any) => [h.session_id, h.kind, h.ts >= since])).toEqual([[ids.Push, "tool_use", true]]);
    expect((await hits("git push")).hits.length).toBeGreaterThan(1); // the prompt and the output too
    expect((await hits("git push in:commands until:2026-01-01")).hits).toEqual([]);
    expect((await hits("git push in:commands state:done")).hits.map((h: any) => h.session_id)).toEqual([ids.Push]);
    expect((await hits("git push in:commands state:failed")).hits).toEqual([]);
    const found = keel("search", "git push", "--commands", "--since", "today");
    expect(found.out).toMatch(/^1 hit for "git push", limited to commands, since \d{4}-\d\d-\d\d 00:00 UTC([+-]\d\d:\d\d)?, the newest first\. Times are local \(UTC[+-]?[\d:]*\)\.\n\d{4}-\d\d-\d\d \d\d:\d\d:\d\d  \$ Bash git push origin main/);
    expect(found.out).toContain(`Push  [session=${ids.Push!.slice(-12)}]`);

  });

  test("the pages show it: Errors, the palette, Activity, Usage and Tokens", async ({ page }) => {
    const { call, ids, url } = W;
    const turns = await call(`/api/telemetry/turns?session_id=${ids["Many turns"]}`);
    const [t4, t3] = [turns.turns.find((t: any) => t.n === 4), turns.turns.find((t: any) => t.n === 3)];
    // --- the pages, in both themes
    await page.setViewportSize({ width: 1920, height: 1040 });
    await page.goto(`${url()}/`);
    await page.getByTestId("errors-button").click();
    const row = page.getByTestId("error-row").filter({ hasText: "credit balance" });
    await row.locator("summary").click();
    await expect(row.getByTestId("error-site")).toHaveCount(2);
    await expect(row.getByTestId("error-site").filter({ hasText: "Billing A" }).getByTestId("error-site-count")).toHaveText("2x");
    await expect(page.getByTestId("errors-panel").getByRole("tab", { name: /Recovered/ })).toContainText("1");
    await shoot(page, "past-truth-01-errors");
    await row.getByTestId("error-site").filter({ hasText: "Billing A" }).getByTestId("error-site-open").click();
    await expect(page).toHaveURL(new RegExp(`/s/${ids["Billing A"]}`));
    // The palette gives the keyboard back to where it was when it opened, unless the person moved it while it closed.
    const menu = page.getByTestId("panel-menu"), box = page.getByTestId("composer");
    await menu.focus();
    await page.keyboard.press("Control+k");
    await expect(page.getByTestId("palette-input")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(menu).toBeFocused();
    await page.keyboard.press("Control+k");
    await expect(page.getByTestId("palette-input")).toBeFocused();
    await page.keyboard.press("Escape");
    await box.focus();
    await expect(page.getByTestId("palette")).toHaveCount(0);
    await page.waitForTimeout(300);
    await expect(box).toBeFocused();
    // The palette: activity, and a search limited in its own words, each hit with its time.
    await page.keyboard.press("Control+k");
    await page.getByTestId("palette-input").fill("git push in:commands since:today");
    const hit = page.getByRole("option").filter({ hasText: "origin main" });
    await expect(hit).toHaveCount(1);
    await expect(hit).toContainText(/\d\d:\d\d · Command · Push/);
    await expect(page.getByTestId("palette-limits")).toContainText("Limited to commands, since");
    await shoot(page, "past-truth-02-search");
    // A limit half typed is a hint in the list, and no client error.
    await page.getByTestId("palette-input").fill("git push since:lastweek");
    await expect(page.getByTestId("palette-refused")).toContainText("since:lastweek is not a limit this search knows");
    await page.getByTestId("palette-input").fill("activity");
    await page.getByRole("option", { name: /Show activity/ }).click();
    await expect(page.getByTestId("activity-item").first()).toBeVisible();
    await expect(page.getByTestId("activity-more").filter({ hasText: "Many turns" })).toContainText(/^\d+ more in Many turns$/);
    await shoot(page, "past-truth-03-activity");
    await page.getByTestId("activity-failures").click();
    await expect(page.getByTestId("activity-item").filter({ hasText: "Reply" })).toHaveCount(0);
    await expect(page.getByTestId("activity-item").filter({ hasText: "Billing A, turn failed" }).first()).toBeVisible();
    await shoot(page, "past-truth-04-activity-failures");
    // A turn's row leads with what the turn said; how it ended stands beside the session's name, said once.
    const failedRow = page.getByTestId("activity-item").filter({ hasText: "Billing A, turn failed" }).first();
    await expect(failedRow.getByTestId("activity-said")).toContainText("credit balance is too low");
    expect((await failedRow.innerText()).match(/Billing A/g)).toHaveLength(1);
    await page.setViewportSize({ width: 390, height: 844 });
    await shoot(page, "past-truth-04-activity-failures-phone");
    await page.setViewportSize({ width: 1920, height: 1040 });
    await page.keyboard.press("Escape");
    // Usage: spend ranked by session, and two turns side by side.
    await page.goto(`${url()}/settings/usage`);
    await page.getByTestId("usage-go-sessions").click();
    await expect(page.getByTestId("usage-rank").getByTestId("rank-open").first()).toHaveText("Many turns");
    await page.getByRole("radio", { name: "Agent trees" }).click();
    await expect(page.getByTestId("rank-agents")).toHaveText(/of it in 1 agent$/);
    await shoot(page, "past-truth-05-usage-rank");
    // A phone has room for three columns: the tokens and requests stand under the name.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId("rank-phone").first()).toBeVisible();
    await expect(page.getByTestId("rank-phone").first()).toHaveText(/^[\d.]+k? tokens, \d+ requests?$/);
    await shoot(page, "past-truth-05-usage-rank-phone");
    await page.setViewportSize({ width: 1920, height: 1040 });
    await expect(page.getByTestId("rank-phone").first()).toBeHidden();
    await page.getByTestId("usage-panel").getByRole("radio", { name: "Compare" }).click();
    await page.getByRole("radio", { name: "Two turns" }).click();
    await choose(page.getByTestId("compare-session"), ids["Many turns"]!);
    await choose(page.getByTestId("compare-turn-a"), t4.turn_event);
    await choose(page.getByTestId("compare-turn-b"), t3.turn_event);
    await expect(page.getByTestId("compare-why")).toContainText("Turn 4 cost");
    await expect(page.getByTestId("compare-why")).toContainText("Turn 4 made 4 requests; turn 3 1 request.");
    await shoot(page, "past-truth-06-two-turns");
    // Every turn can be picked: by its number, or by words of its prompt.
    await page.getByTestId("compare-turn-b").click();
    await expect(page.getByTestId("turn-option")).toHaveCount(6);
    await page.getByTestId("turn-picker-input").fill("2");
    await expect(page.getByTestId("turn-option")).toHaveCount(1);
    await shoot(page, "past-truth-06-turn-picker");
    await page.getByTestId("turn-picker-input").fill("turn 1 script");
    await expect(page.getByTestId("turn-option")).toHaveCount(1);
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("compare-why")).toContainText("turn 2");
    // Another session: its own turns are asked, and nothing is reported as a failure of the page.
    const clientErrors = async () => ((await call("/api/errors")).errors as ErrorRecord[]).filter((e) => e.source === "client").reduce((n, e) => n + (e.count ?? 1), 0);
    const before = await clientErrors();
    await choose(page.getByTestId("compare-session"), ids.Overloaded!);
    await expect(page.getByTestId("compare-table")).toContainText("This session has one turn");
    await choose(page.getByTestId("compare-session"), ids["Billing A"]!);
    await expect(page.getByTestId("compare-why")).toContainText("Turn 2");
    expect(await clientErrors()).toBe(before);
    await choose(page.getByTestId("compare-session"), ids["Many turns"]!);
    await choose(page.getByTestId("compare-turn-a"), t4.turn_event);
    await choose(page.getByTestId("compare-turn-b"), t3.turn_event);
    await page.setViewportSize({ width: 390, height: 844 });
    await shoot(page, "past-truth-07-two-turns-narrow");
    await page.setViewportSize({ width: 1920, height: 1040 });
    // The Tokens panel opens at the newest turn and can be sorted; its request count is the ledger's.
    await page.goto(`${url()}/s/${ids.Overloaded}`);
    await page.getByTestId("panel-menu").click();
    await page.getByTestId("panel-pick-usage").click();
    await expect(page.getByTestId("usage-cost")).toContainText("3 requests, 2 of them failed attempts");
    await expect(page.getByTestId("usage-turn-requests").first()).toHaveText("3 requests, 2 failed");
    await page.goto(`${url()}/s/${ids["Many turns"]}`);
    await page.getByTestId("panel-menu").click();
    await page.getByTestId("panel-pick-usage").click();
    await expect(page.getByTestId("usage-turn").first()).toHaveAttribute("data-turn", "6");
    await page.getByTestId("usage-turn-order").getByRole("radio", { name: "Dearest" }).click();
    await expect(page.getByTestId("usage-turn").first()).toHaveAttribute("data-turn", "4");
    await shoot(page, "past-truth-08-tokens");
    await page.setViewportSize({ width: 390, height: 844 });
    await shoot(page, "past-truth-08-tokens-phone");
    await page.setViewportSize({ width: 1920, height: 1040 });

  });

  test("a stop that was asked for is in the log, and the digest never says the daemon went down for it", async () => {
    const { call, text, log, since, stopAndStart } = W;
    // --- a clean stop is in the log of the next start
    await stopAndStart();
    expect((await log("[daemon] draining for a stop (a stop signal)")).length).toBe(1);
    expect((await log("[daemon] stopping cleanly after")).length).toBe(1);
    expect(await log("[daemon] started")).toHaveLength(3);
    // The window holds a kill and a stop that was asked for: the kill is told as going down, the stop is not.
    await expect.poll(async () => !!(await call("/api/daemon")).last_start?.settled_ms, { timeout: 60_000 }).toBe(true);
    const lines = (await text(`/api/away?since=${since}&format=text`)).split("\n");
    // The stop came as a stop signal from outside: said as one, with its downtime, never as the daemon going down.
    expect(lines[0]).toMatch(/: the daemon went down and came back after \d+ (ms|s), 2 turns cut; was stopped by a signal, down \d+ (ms|s); /);
    expect(lines[1]).toMatch(/^The daemon went down without stopping /);
    expect(lines[2]).toMatch(/^The daemon was stopped by a signal at \d\d:\d\d:\d\d and came back at .* \(down \d+ (ms|s)\); no turn was cut\.$/);
    expect(lines.filter((l) => /went down|stopped by itself/.test(l)).length).toBe(2);
  });
});

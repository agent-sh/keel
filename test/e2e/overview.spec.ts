import { expect, test } from "./isolate.ts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TEXT_TOKENS, tokensOf, type Overview } from "../../src/admin/overview.ts";
import type { StoredEvent } from "../../src/core/types.ts";
import { exited, ownDaemon, ownEnv } from "./peer.ts";
import { shoot, SHOTS } from "./shots.ts";

// Feature: every session at once. One route, one command and the sessions
// tool say, for twenty sessions in under 1.5k tokens, what needs the owner,
// what failed and why, what runs and for how long, and the turns and spend
// since a time, in the states the page shows, without a word of a prompt or
// a tool's output. The spec runs its own daemon on a scratch state folder, on
// the scripted stand-in, with nothing of the caller's environment but the path.
const ROOT = join(process.env.HOME!, ".cache/keel-work/bun/e2e-state");
const daemon = async (state: string, more: Record<string, string> = {}, port = 0) => ({ ...(await ownDaemon(state, port, { KEEL_RESUME_GAP_MS: "0", ...more })), env: ownEnv(state) });
const script = (calls: unknown[]) => `script:calls ${JSON.stringify(calls)}`;
// Words of prompts and commands: none may reach the report.
const PRIVATE = ["overview-prompt-marker", "overview-tool-marker", "script:", "credit balance"];
const made: string[] = [];
test.afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

test("one report tells every session's state, failure, run time and spend, as the page shows them", async ({ page }) => {
  test.setTimeout(300_000);
  const state = join(ROOT, `overview-${Date.now()}`);
  made.push(state);
  mkdirSync(state, { recursive: true });
  let d = await daemon(state);
  const call = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
    fetch(d.url + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => r.json() as any);
  const gate = join(state, "go");
  try {
    const open = async (title: string, mode = "full-auto") => {
      const { session } = await call("/api/sessions", { model: "scripted:stand-in", title });
      await call(`/api/sessions/${session.id}/permissions`, { mode }, "PUT");
      return session.id as string;
    };
    const send = (id: string, text: string) => call(`/api/sessions/${id}/messages`, { text });
    const view = (id: string) => call(`/api/sessions/${id}`);
    const ends = async (id: string) => ((await view(id)).events as StoredEvent[]).filter((e) => e.kind === "turn_end").length;
    const ended = (id: string, n: number) => expect.poll(() => ends(id), { timeout: 60_000 }).toBe(n);
    const waitsFor = `until [ -f ${gate} ]; do sleep 0.2; done; echo overview-tool-marker`;
    const short = (id: string) => id.slice(-12);

    // Twenty sessions: two need the owner, three work, three failed, one was stopped, nine are done, two never started.
    const need = [await open("Parser refactor", "ask"), await open("Release notes", "ask")];
    for (const id of need) await send(id, `overview-prompt-marker ${script([{ name: "Bash", input: { command: "rm overview-tool-marker.txt" } }])}`);
    const answering = await open("Slow provider");
    await send(answering, `overview-prompt-marker script:hold ${gate}`);
    const tooling = await open("Index rebuild");
    await send(tooling, script([{ name: "Bash", input: { command: waitsFor } }]));
    const parent = await open("Coordinator");
    await send(parent, script([{ name: "spawn_agent", input: { message: `Slow helper\n${script([{ name: "Bash", input: { command: waitsFor } }])}`, isolation: "none" } }]));
    const failed = [await open("Billing check"), await open("Nightly eval"), await open("Rate limited fetch")];
    await send(failed[0]!, "overview-prompt-marker script:billing");
    await send(failed[1]!, "script:billing");
    await send(failed[2]!, "script:rate-limit-long");
    const stopped = await open("Stopped by me");
    await send(stopped, "script:long-tool");
    const done: string[] = [];
    for (const t of ["Changelog", "Lint cleanup", "Typo sweep", "Readme pass", "Flag removal", "Cache key audit", "Logger rename", "Test names", "Docs index"]) done.push(await open(t));
    for (const id of done) await send(id, "overview-prompt-marker say something");
    await send(done[0]!, "and once more");
    await open("Not yet begun");
    await open("Parked idea");

    for (const id of done.slice(1)) await ended(id, 1);
    await ended(done[0]!, 2);
    for (const id of failed) await ended(id, 1);
    await ended(parent, 1);
    await expect.poll(async () => (await call(`/api/sessions/${parent}/agents`)).agents[0]?.status, { timeout: 30_000 }).toBe("running");
    for (const id of need) await expect.poll(async () => (await call(`/api/sessions/${id}/approvals`)).approvals.filter((a: any) => a.state === "pending").length, { timeout: 30_000 }).toBe(1);
    await expect.poll(async () => (await call(`/api/sessions/${stopped}/timeline`)).now.lines[0]?.text, { timeout: 30_000 }).toBe("Running a turn started by the owner: step 1, running Bash");
    await call(`/api/sessions/${stopped}/interrupt`, { by: "owner" });
    await ended(stopped, 1);
    await expect.poll(async () => (await call(`/api/sessions/${tooling}/timeline`)).now.lines[0]?.text, { timeout: 30_000 }).toBe("Running a turn started by the owner: step 1, running Bash");

    // The text: every state, each with its reason, in one screen of words.
    const text = await (await fetch(`${d.url}/api/overview?since=1h&format=text`)).text();
    const o = (await call("/api/overview?since=1h")) as Overview;
    writeFileSync(join(SHOTS, "overview-01-report.txt"), text); // kept with the screenshots, to read and to count
    // Under 1.5k tokens, counted from the text's shape, never under what a local BPE measured (src/admin/overview.ts).
    expect(tokensOf(text)).toBeLessThan(TEXT_TOKENS);
    // The turns counted are the sessions' own (the agent's is its own row's); no agent ended yet.
    expect(text).toMatch(/^Sessions, read \d{4}-\d\d-\d\d \d\d:\d\d UTC: 20 open\. Since \d\d:\d\d \(1 h\): 15 of the sessions' own turns ended, 3 failed; \$\d+\.\d+ spent in all\.\n/);
    const lines = text.trimEnd().split("\n");
    const group = (head: string) => { const at = lines.findIndex((l) => l.startsWith(head)); const rest = lines.slice(at + 1); const to = rest.findIndex((l) => !l.startsWith("  ")); return at < 0 ? [] : rest.slice(0, to < 0 ? rest.length : to); };
    expect(group("Needs you (2):")).toHaveLength(2);
    // A card is "an approval": the tool it asks for is the session's own business. A row names its session by its short id.
    for (const id of need) expect(text).toMatch(new RegExp(`": an approval waits, for \\d+ m?s; \\$\\d+\\.\\d+  \\[session=${short(id)}\\]`));
    const work = group("Working (3):");
    expect(work).toHaveLength(3);
    expect(work.join("\n")).toMatch(new RegExp(`"Slow provider": step 1, [a-z ]+, for \\d+ m?s(; \\$\\d+\\.\\d+)?  \\[session=${short(answering)}\\]`));
    expect(work.join("\n")).toMatch(/"Index rebuild": step 1, running Bash, for \d+ m?s/);
    // A parent whose own turn ended is working while its agent is: the agent is counted, not named.
    expect(work.join("\n")).toMatch(new RegExp(`"Coordinator": 1 agent at work, for \\d+ m?s; 1 turn; \\$\\d+\\.\\d+  \\[session=${short(parent)}\\]`));
    expect(text).not.toContain("Slow helper");
    const bad = group("Failed (3):");
    expect(bad).toHaveLength(3);
    expect(bad.filter((l) => /: quota or billing, \d+ m?s ago; 1 turn, 1 failed \(quota or billing\)  \[session=[0-9a-f]{12}\]$/.test(l))).toHaveLength(2);
    expect(bad.filter((l) => /"Rate limited fetch": rate limit, .* 1 failed \(rate limit\)/.test(l))).toHaveLength(1);
    // The turn and the error of a failure are in its session's timeline, not in this text.
    expect(text).not.toMatch(/turn=|error=/);
    expect(group("Stopped (1):")[0]).toMatch(/"Stopped by me": stopped \d+ m?s ago; 1 turn/);
    expect(group("Done (9):")).toHaveLength(9);
    expect(text).toMatch(/"Changelog": finished \d+ m?s ago; 2 turns; \$\d+\.\d+  \[session=/);
    expect(text).toContain('Not started (2): "Parked idea", "Not yet begun"');
    expect(lines.at(-1)).toMatch(/^Most spent since then: "[^"]+" \$\d+\.\d+, "[^"]+" \$\d+\.\d+, "[^"]+" \$\d+\.\d+\.$/);
    for (const word of PRIVATE) expect(text).not.toContain(word);
    // Without the ids, for a reader that only reads.
    const bare = await (await fetch(`${d.url}/api/overview?since=1h&format=text&ids=0`)).text();
    expect(bare).not.toContain("[session=");
    expect(bare.split("\n")).toHaveLength(text.split("\n").length);
    // The short id opens the session: the timeline route and the commands take it.
    expect((await call(`/api/sessions/${short(failed[0]!)}/timeline?only=failures`)).session_id).toBe(failed[0]);
    // The JSON keeps what the text leaves out: the failed turn of each failed session.
    expect(o.sessions.filter((r) => r.watch === "fail").every((r) => /^[0-9a-f-]{36}$/.test(r.failed?.turn ?? ""))).toBe(true);

    // The spend is what the sessions spent: every request of this run is inside the hour.
    const all = (await call("/api/sessions")).sessions as { id: string; usage: { cost?: number } }[];
    expect(o.totals.cost).toBeCloseTo(all.reduce((n, s) => n + (s.usage.cost ?? 0), 0), 6);
    expect(o.totals).toMatchObject({ turns: 15, failed: 3, agents: {} });
    // A window that holds nothing says so, and the states stay.
    const later = (await call("/api/overview?since=2099-01-01T00:00:00Z")) as Overview;
    expect(later.totals).toEqual({ turns: 0, failed: 0, agents: {}, cost: 0 });
    expect(later.sessions.map((r) => r.watch).sort()).toEqual(o.sessions.map((r) => r.watch).sort());
    expect((await fetch(`${d.url}/api/overview?since=soon`)).status).toBe(400);
    // A window is at most a week: a longer read would hold the daemon for its length.
    const far = await fetch(`${d.url}/api/overview?since=30d`);
    expect(far.status).toBe(400);
    expect((await far.json()).error).toBe("since is at most 7 d back");
    expect((await fetch(`${d.url}/api/overview?since=7d`)).status).toBe(200);
    // Fewer are listed on request, the ones that need the owner first, and the rest are counted.
    const few = await (await fetch(`${d.url}/api/overview?since=1h&format=text&max=3`)).text();
    expect(few).toContain("Needs you (2):");
    expect(few.trimEnd().split("\n").at(-2)).toBe("17 more sessions not listed, the quietest.");

    // The page says the same of every session: the word on its row is the report's.
    await page.setViewportSize({ width: 1920, height: 1040 });
    await page.goto(`${d.url}/s/${done[0]}`);
    const list = page.getByTestId("session-list");
    await expect(list.locator('[data-testid="session-row"]').first()).toBeVisible();
    for (const more of await list.locator(".k-more").all()) await more.click();
    expect(o.sessions).toHaveLength(20);
    for (const r of o.sessions) await expect(list.locator(`[data-testid="session-row"][data-session="${r.id}"]`), r.title).toHaveAttribute("data-watch", r.watch);
    await expect(list.locator(`[data-testid="session-row"][data-session="${parent}"]`).getByTestId("row-state")).toHaveText("Working · 1 agent");
    expect(Object.fromEntries(["need", "work", "fail", "stop", "done", "idle"].map((w) => [w, o.sessions.filter((r) => r.watch === w).length]))).toEqual({ need: 2, work: 3, fail: 3, stop: 1, done: 9, idle: 2 });
    await shoot(page, "overview-01-twenty-sessions");

    // The command prints the route's text, with nothing of a title's own reaching the terminal as a control.
    const keel = (...args: string[]) => execFileSync("bun", ["src/main.ts", ...args, "--url", d.url], { env: d.env, encoding: "utf8" });
    const cli = keel("status", "--sessions", "--since", "1h");
    const body = (t: string) => t.trimEnd().split("\n").slice(1).map((l) => l.replace(/\d+ (ms|s|min)( ago)?/g, "T"));
    expect(body(cli)).toEqual(body(await (await fetch(`${d.url}/api/overview?since=1h&format=text`)).text()));
    expect(cli.split("\n")[0]).toMatch(/^Sessions, read .* UTC: 20 open\./);
    expect(keel("status", "--sessions", "--max", "3")).toContain("17 more sessions not listed");
    await call(`/api/sessions/${done[1]}`, { title: "Lint \u001b[31mcleanup\u0007" }, "PATCH");
    const raw = keel("status", "--sessions", "--since", "1h");
    expect(raw).toContain('"Lint cleanup"');
    expect(raw).not.toMatch(/[\u001b\u0007]/);
    expect(keel("debug", "timeline", short(failed[2]!), "--only", "failures")).toContain(`(${failed[2]}), newest first`);

    // The sessions tool, asked for the report: the asking session's agents first, then the other sessions,
    // twenty rows in all unless it asks for another number.
    const tool = (input: Record<string, unknown>) => ({ name: "keel__sessions_list", input: { report: true, ...input } });
    await send(parent, script([tool({ since: "1h" }), tool({ since: "soon" }), tool({ max: 3 }), tool({ max: 0 }), tool({ since: "30d" })]));
    await ended(parent, 2);
    const results = ((await view(parent)).events as StoredEvent[]).flatMap((e) => (e.kind === "tool_result" ? (e.data.results as { content: string; is_error?: boolean }[]) : [])).slice(-5);
    const told = results[0]!.content;
    expect(results[0]!.is_error ?? false).toBe(false);
    expect(told).toMatch(/UTC: 19 open\. Since/);
    const agent = (await call(`/api/sessions/${parent}/agents`)).agents[0] as { id: string; session_id: string };
    // Its own agent is named, with the id the timeline tool takes.
    expect(told).toMatch(new RegExp(`Your agents \\(1\\):\n  "Slow helper": step 1, running Bash, for \\d+ m?s; \\$\\d+\\.\\d+  \\[agent=${agent.id}\\]`));
    expect(told).toContain("Needs you (2):");
    expect(told).not.toContain(`session=${short(parent)}`);
    expect(told.split("\n").filter((l) => /\[(session|agent)=/.test(l)).length).toBeLessThanOrEqual(20);
    expect(tokensOf(told)).toBeLessThan(TEXT_TOKENS);
    for (const word of PRIVATE) expect(told).not.toContain(word);
    expect(results[1]).toMatchObject({ is_error: true, content: expect.stringContaining("since is a span back from now") });
    expect(results[2]!.content).toContain("17 more sessions not listed");
    expect(results[3]).toMatchObject({ is_error: true, content: expect.stringContaining("max is a whole number") });
    expect(results[4]).toMatchObject({ is_error: true, content: "since is at most 7 d back" });

    // A turn a daemon restart cut and the daemon went on with is not a failure: this daemon is stopped
    // while a tool runs, and the session's two turns (the cut one, the one that continued it) count as turns only.
    const cut = await open("Cut and continued");
    await send(cut, "script:long-tool");
    await expect.poll(async () => (await call(`/api/sessions/${cut}/timeline`)).now.lines[0]?.text, { timeout: 30_000 }).toBe("Running a turn started by the owner: step 1, running Bash");
    writeFileSync(gate, "go\n");
    d.proc.kill("SIGTERM");
    await exited(d.proc);
    d = await daemon(state, {}, d.port);
    await ended(cut, 2);
    expect(((await view(cut)).events as StoredEvent[]).filter((e) => e.kind === "turn_end").map((e) => e.data.reason)).toEqual(["restart", "end_turn"]);
    const after = (await call("/api/overview?since=1h")) as Overview;
    const row = after.sessions.find((r) => r.id === cut)!;
    expect(row).toMatchObject({ watch: "done", did: { turns: 2, failed: {} } });
    expect(await (await fetch(`${d.url}/api/overview?since=1h&format=text`)).text()).toMatch(/"Cut and continued": finished \d+ m?s ago; 2 turns; /);
    expect((await (await fetch(`${d.url}/api/overview?since=1h&format=text`)).text())).not.toContain("cut by a restart");
  } finally {
    if (!existsSync(gate)) writeFileSync(gate, "go\n");
    d.proc.kill("SIGTERM");
    await exited(d.proc);
  }
});

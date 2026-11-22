import { expect, test } from "./isolate.ts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { digestBrief, digestTotals, type Digest } from "../../src/admin/away.ts";
import { TEXT_TOKENS, tokensOf, type Overview } from "../../src/admin/overview.ts";
import type { StoredEvent } from "../../src/core/types.ts";
import { exited, ownDaemon, ownEnv } from "./peer.ts";
import { shoot, SHOTS } from "./shots.ts";

// Feature: every session at once. One route, one command and the sessions
// tool say, for twenty sessions in under 1.5k tokens, what needs the owner,
// what failed and why, what runs and for how long, and the turns and spend
// since a time, in the states the page shows, without a word of a prompt or
// a tool's output; and "while you were away" is one digest of the same read,
// from the last time a page of the daemon had focus, in the Inbox and as
// text. The spec runs its own daemon on a scratch state folder, on the
// scripted stand-in, with nothing of the caller's environment but the path.
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

    // Twenty sessions: two need the owner, three work, two failed, one waits for a rate limit to pass, one was stopped, nine are done, two never started.
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
    expect(text).toMatch(/^Sessions, read \d{4}-\d\d-\d\d \d\d:\d\d UTC(?:[+-]\d\d:\d\d)?: 20 open\. Since \d\d:\d\d \(1 h\): 15 of the sessions' own turns ended, 3 failed; \$\d+\.\d+ spent in all\.\n/);
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
    // A row that names why it failed does not name the same class again after its count.
    const bad = group("Failed (2):");
    expect(bad).toHaveLength(2);
    expect(bad.filter((l) => /: billing, \d+ m?s ago; 1 turn, 1 failed  \[session=[0-9a-f]{12}\]$/.test(l))).toHaveLength(2);
    // A turn the provider asked to wait for continues by itself: the session waits, and its row says for what, until when, and what failed in it.
    expect(group("Waiting (1):")).toHaveLength(1);
    expect(group("Waiting (1):")[0]).toMatch(/"Rate limited fetch": resumes by itself when the wait the provider asked for is over, for \d+ m?s, due in 1[45] min; 1 turn, 1 failed \(rate limit\)  \[session=[0-9a-f]{12}\]$/);
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
    // The ones left out are not all at rest: the line says what they are and what they did.
    expect(few.trimEnd().split("\n").at(-2)).toMatch(/^17 more sessions not listed: 9 done, 2 working, 4 more \(\d+ turns, \$\d+\.\d+\), the busiest: "[^"]+"\.$/);

    // The page says the same of every session: the word on its row is the report's.
    await page.setViewportSize({ width: 1920, height: 1040 });
    await page.goto(`${d.url}/s/${done[0]}`);
    const list = page.getByTestId("session-list");
    await expect(list.locator('[data-testid="session-row"]').first()).toBeVisible();
    for (const more of await list.locator(".k-more").all()) await more.click();
    expect(o.sessions).toHaveLength(20);
    for (const r of o.sessions) await expect(list.locator(`[data-testid="session-row"][data-session="${r.id}"]`), r.title).toHaveAttribute("data-watch", r.watch);
    await expect(list.locator(`[data-testid="session-row"][data-session="${parent}"]`).getByTestId("row-state")).toHaveText("Working · 1 agent");
    expect(Object.fromEntries(["need", "work", "wait", "fail", "stop", "done", "idle"].map((w) => [w, o.sessions.filter((r) => r.watch === w).length]))).toEqual({ need: 2, work: 3, wait: 1, fail: 2, stop: 1, done: 9, idle: 2 });
    await shoot(page, "overview-01-twenty-sessions");

    // The command prints the route's text, with nothing of a title's own reaching the terminal as a control.
    const keel = (...args: string[]) => execFileSync("bun", ["src/main.ts", ...args, "--url", d.url], { env: d.env, encoding: "utf8" });
    const cli = keel("status", "--sessions", "--since", "1h");
    const body = (t: string) => t.trimEnd().split("\n").slice(1).map((l) => l.replace(/\d+ (ms|s|min)( ago)?/g, "T"));
    expect(body(cli)).toEqual(body(await (await fetch(`${d.url}/api/overview?since=1h&format=text`)).text()));
    expect(cli.split("\n")[0]).toMatch(/^Sessions, read .* UTC(?:[+-]\d\d:\d\d)?: 20 open\./);
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
    expect(told).toMatch(/UTC(?:[+-]\d\d:\d\d)?: 19 open\. Since/);
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

    // A turn a daemon restart cut and the daemon went on with is not a failure, and it did not end: this daemon
    // is stopped while a tool runs, and of the session's two turns the one that continued it ended; the cut one is said apart.
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
    expect(row).toMatchObject({ watch: "done", did: { turns: 1, cut: 1, failed: {} } });
    const cutText = await (await fetch(`${d.url}/api/overview?since=1h&format=text`)).text();
    expect(cutText).toMatch(/"Cut and continued": finished \d+ m?s ago; 1 turn, 1 cut; /);
    // The first line says what cut it, once for every row; it is no failure of any.
    expect(cutText.split("\n")[0]).toMatch(/ of the sessions' own turns ended, 3 failed, \d cut by a restart; /);
  } finally {
    if (!existsSync(gate)) writeFileSync(gate, "go\n");
    d.proc.kill("SIGTERM");
    await exited(d.proc);
  }
});

test("while the owner is away, one digest tells what each session did, what waits and what it cost", async ({ page }) => {
  test.setTimeout(420_000);
  const state = join(ROOT, `away-${Date.now()}`);
  made.push(state);
  mkdirSync(state, { recursive: true });
  // An absence is 25 seconds with no input in a page (five minutes on a daemon of the owner's):
  // longer than the 20 s between a page's reports.
  const d = await daemon(state, { KEEL_AWAY_MS: "25000" });
  const call = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
    fetch(d.url + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => r.json() as any);
  const textOf = async (path: string) => (await fetch(d.url + path)).text();
  try {
    const open = async (title: string, mode = "full-auto") => {
      const { session } = await call("/api/sessions", { model: "scripted:stand-in", title });
      await call(`/api/sessions/${session.id}/permissions`, { mode }, "PUT");
      return session.id as string;
    };
    const send = (id: string, text: string) => call(`/api/sessions/${id}/messages`, { text });
    const events = async (id: string) => (await call(`/api/sessions/${id}`)).events as StoredEvent[];
    const ended = (id: string, n: number) => expect.poll(async () => (await events(id)).filter((e) => e.kind === "turn_end").length, { timeout: 60_000 }).toBe(n);
    const away = async () => (await call("/api/away")).away as Digest | null;
    const quiet = await open("Untouched notes");
    const desk = await open("Seen at the desk");
    const fine = await open("Changelog");
    const billing = await open("Billing check");
    const declined = await open("Policy text");
    const asks = await open("Parser refactor", "ask");
    const parent = await open("Coordinator");
    // The owner at the page: they move the pointer. A page that is only open says nothing of them.
    let x = 600;
    const here = async (at = quiet) => {
      if (!page.url().startsWith(d.url)) await page.goto(`${d.url}/s/${at}`);
      await page.mouse.move((x += 7), 400);
    };
    const leaves = () => page.goto("about:blank");
    // The daemon has heard of the owner's input after a session's last turn ended (a page says so within five seconds).
    const seenAfter = async (id: string) => {
      const end = (await events(id)).findLast((e) => e.kind === "turn_end")!.ts;
      await expect.poll(async () => { await here(); return (await call("/api/away")).last_seen as number; }, { timeout: 30_000 }).toBeGreaterThan(end);
    };

    await page.setViewportSize({ width: 1920, height: 1040 });
    await page.goto(`${d.url}/s/${quiet}`);
    await expect(page.getByTestId("inbox-button")).toBeVisible();
    await page.waitForTimeout(1500);
    expect((await call("/api/away")).last_seen).toBeNull();
    await here();
    await expect.poll(async () => (await call("/api/away")).last_seen, { timeout: 30_000 }).not.toBeNull();
    expect(await call("/api/away")).toMatchObject({ away: null, gap_ms: 25_000 });
    expect(await textOf("/api/away?format=text")).toMatch(/^No absence to tell of: the owner was at a page of the daemon \d+ m?s ago\./);
    // A turn that ends while the owner is there is theirs to have seen: no digest will tell it.
    await send(desk, "overview-prompt-marker say something");
    await ended(desk, 1);
    await seenAfter(desk);
    await page.getByTestId("inbox-button").click();
    await expect(page.getByTestId("inbox-list")).toBeVisible();
    await expect(page.getByTestId("away-digest")).toHaveCount(0);

    // They leave, and the sessions go on: two turns end well, one fails for billing, one is declined,
    // one asks for approval, and a coordinator's agent parks on a timer of its own.
    await leaves();
    await send(fine, "overview-prompt-marker say something");
    await ended(fine, 1);
    await send(fine, "and once more");
    await send(billing, "overview-prompt-marker script:billing");
    await send(declined, "script:refuse");
    await send(asks, script([{ name: "Bash", input: { command: "rm overview-tool-marker.txt" } }]));
    await send(parent, script([{ name: "spawn_agent", input: { message: `Watch the queue\n${script([{ name: "wait_for", input: { kind: "timer", seconds: 600, note: "overview-prompt-marker" } }])}`, isolation: "none" } }]));
    await ended(fine, 2);
    await ended(billing, 1);
    await ended(declined, 1);
    await expect.poll(async () => (await call(`/api/sessions/${asks}/approvals`)).approvals.filter((a: any) => a.state === "pending").length, { timeout: 30_000 }).toBe(1);
    await expect.poll(async () => (await call(`/api/sessions/${parent}/agents`)).agents[0]?.status, { timeout: 30_000 }).toBe("waiting");
    await expect.poll(async () => (await call(`/api/sessions/${parent}`)).running, { timeout: 30_000 }).toBe(false);

    // Still away: the digest runs from their last input to now.
    await expect.poll(async () => (await away())?.present, { timeout: 60_000 }).toBe(false);
    const open1 = (await away())!;
    const row = (g: Digest, id: string) => g.sessions.find((r) => r.id === id);
    expect(open1.spans).toHaveLength(1);
    // It matches the events: each session's turns that ended inside the absence, as its events hold them.
    for (const id of [fine, billing, declined, asks, parent]) {
      const n = (await events(id)).filter((e) => e.kind === "turn_end" && e.ts >= open1.from && e.ts <= open1.to).length;
      expect(row(open1, id)?.turns, id).toBe(n);
    }
    expect(row(open1, fine)).toMatchObject({ watch: "done", turns: 2, failed: {}, approvals: 0, parked: 0 });
    expect(row(open1, billing)).toMatchObject({ watch: "fail", turns: 1, failed: { "billing": 1 }, bad: "1 failed (billing)" });
    expect(row(open1, declined)).toMatchObject({ watch: "declined", turns: 1, failed: { declined: 1 } });
    expect(row(open1, asks)).toMatchObject({ watch: "need", turns: 0, approvals: 1, text: expect.stringMatching(/^1 approval waits/) });
    // Its own turn ended and its agent waits on a timer: the session waits, it does not work.
    expect(row(open1, parent)).toMatchObject({ watch: "wait", parked: 1, text: expect.stringContaining("1 agent parked") });
    // Neither the session nothing happened in nor the one whose turn ended at the desk.
    expect(row(open1, quiet)).toBeUndefined();
    expect(row(open1, desk)).toBeUndefined();
    expect(open1.quiet).toBe(2);
    expect(open1.totals).toMatchObject({ failed: 2, approvals: 1, parked: 1 });
    const away1 = await textOf("/api/away?format=text");
    writeFileSync(join(SHOTS, "overview-02-away.txt"), away1);
    expect(tokensOf(away1)).toBeLessThan(TEXT_TOKENS);
    expect(away1).toMatch(/^While you are away, since \d\d:\d\d:\d\d UTC([+-]\d\d:\d\d)? \(\d+ s\): \d of the sessions' own turns ended in 4 sessions, 2 failed; 1 approval waits; 1 agent parked; \$\d+\.\d+ spent in all\.\n/);
    expect(away1).toMatch(new RegExp(`  "Billing check", failed: 1 turn ended, 1 failed \\(billing\\)  \\[session=${billing.slice(-12)}\\]`));
    expect(away1).toMatch(/  "Changelog", done: 2 turns ended; \$\d+\.\d+  \[session=/);
    expect(away1).toContain("2 other sessions: nothing happened.");
    for (const word of PRIVATE) expect(away1).not.toContain(word);
    const keel = (...args: string[]) => execFileSync("bun", ["src/main.ts", ...args, "--url", d.url], { env: d.env, encoding: "utf8" });
    const cli = keel("status", "--away", "--no-ids");
    expect(cli).toMatch(/^While you are away, since /);
    expect(cli).toContain('  "Policy text", declined: 1 turn ended, 1 failed (declined)');
    expect(cli).not.toContain("[session=");

    // They come back: the absence closes at their first input, and the Inbox has one line for it.
    await here();
    await expect.poll(async () => (await away())?.present, { timeout: 30_000 }).toBe(true);
    const back = (await away())!;
    expect(back.spans).toHaveLength(1);
    expect(back.from).toBe(open1.from);
    expect(back.sessions.map((r) => [r.id, r.text])).toEqual(open1.sessions.map((r) => [r.id, r.text]));
    await page.getByTestId("inbox-button").click();
    const block = page.getByTestId("away-digest");
    await expect(block).toBeVisible();
    await expect(block.getByTestId("away-line")).toContainText(digestBrief(back));
    expect(digestBrief(back)).toMatch(/^\d turns ended, 2 failed; 1 approval waits$/);
    await expect(block.getByTestId("away-row")).toHaveCount(0);
    await page.mouse.move(1200, 600);
    await shoot(page, "overview-02-away-line");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("inbox-panel")).toHaveCount(0);

    // The owner stays a while, and a turn ends under their eyes. Then they are away again, and nothing
    // happens. The digest, not opened yet, has two absences, and the turn that ended between them is in neither.
    await here();
    await send(fine, "a third time, with the owner there");
    await ended(fine, 3);
    await seenAfter(fine);
    await leaves();
    await expect.poll(async () => (await away())?.spans.length, { timeout: 60_000 }).toBe(2);
    await here();
    await expect.poll(async () => (await away())?.present, { timeout: 30_000 }).toBe(true);
    const twice = (await away())!;
    expect(twice.spans).toHaveLength(2);
    expect(twice.spans[0]).toEqual(back.spans[0]);
    expect(row(twice, fine)).toMatchObject({ turns: 2 });
    expect(twice.sessions.map((r) => [r.id, r.turns, r.failed])).toEqual(back.sessions.map((r) => [r.id, r.turns, r.failed]));
    expect(await textOf("/api/away?format=text")).toMatch(/^While you were away, 2 times between \d\d:\d\d:\d\d and \d\d:\d\d:\d\d UTC([+-]\d\d:\d\d)? \(\d+ s in all\): /);

    // Opened, a row a session, in the daemon's own words. Opening it is seeing it: the daemon lets it go,
    // and it stays on screen until the Inbox closes.
    await page.getByTestId("inbox-button").click();
    await expect(block).toBeVisible();
    await block.getByTestId("away-toggle").click();
    await expect(block.getByTestId("away-totals")).toHaveText(digestTotals(twice));
    await expect(block.getByTestId("away-row")).toHaveCount(5);
    for (const r of twice.sessions) {
      const el = block.locator(`[data-testid="away-row"][data-session="${r.id}"]`);
      await expect(el).toHaveAttribute("data-watch", r.watch);
      await expect(el.getByTestId("away-facts")).toHaveText(r.text);
    }
    await expect(block.locator(`[data-session="${billing}"] .text-danger`)).toHaveText("1 failed (billing)");
    await expect(block.getByTestId("away-quiet")).toHaveText("2 other sessions: nothing happened.");
    await expect.poll(away).toBeNull();
    await page.mouse.move(1200, 600);
    await shoot(page, "overview-03-away-open");
    await page.setViewportSize({ width: 900, height: 1040 });
    await shoot(page, "overview-03-away-open-narrow");
    await page.setViewportSize({ width: 1920, height: 1040 });
    // A row opens its session, and the Inbox opened again has no digest left.
    await block.locator(`[data-testid="away-row"][data-session="${billing}"]`).click();
    await expect(page).toHaveURL(new RegExp(`/s/${billing}$`));
    await expect(page.getByTestId("inbox-panel")).toHaveCount(0);
    await page.getByTestId("inbox-button").click();
    await expect(page.getByTestId("inbox-list")).toBeVisible();
    await page.waitForTimeout(2500); // past the block's second look
    await expect(block).toHaveCount(0);
    await page.keyboard.press("Escape");

    // An absence in which nothing happened leaves nothing to tell: no digest, no block.
    await here();
    await leaves();
    await page.waitForTimeout(27_000);
    expect(await textOf("/api/away?format=text")).toBe("Nothing happened while you were away.\n");
    await here();
    await expect.poll(async () => Date.now() - (await call("/api/away")).last_seen, { timeout: 30_000 }).toBeLessThan(10_000);
    expect(await away()).toBeNull();
    await page.getByTestId("inbox-button").click();
    await expect(page.getByTestId("inbox-list")).toBeVisible();
    await page.waitForTimeout(2500); // past the block's second look
    await expect(block).toHaveCount(0);
    // A window that is asked for is told whether or not the owner was away, up to a week back.
    expect(await textOf("/api/away?since=1h&format=text")).toMatch(/^From \d\d:\d\d:\d\d to \d\d:\d\d:\d\d UTC([+-]\d\d:\d\d)? \(1 h\): \d of the sessions' own turns ended in 5 sessions, 2 failed; /);
    expect((await fetch(`${d.url}/api/away?since=30d`)).status).toBe(400);
  } finally {
    d.proc.kill("SIGTERM");
    await exited(d.proc);
  }
});

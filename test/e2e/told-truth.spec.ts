import { expect, test } from "./isolate.ts";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { shoot } from "./shots.ts";

// Feature: what a coordinating model and the owner are told about sessions,
// agents, restarts and tools is true. A coordinator with twelve agents in
// every state, sessions that fail, wait on the owner and run long commands;
// the daemon is killed twice and stopped once. Every statement the product
// then makes (the sessions report, the timeline, receipts, agent reports,
// notices, the restart record, the result of a call a restart cut) is checked
// against the store through the API. Own daemons, scratch state, the
// scripted stand-in.
const ROOT = join(process.env.HOME!, ".cache/keel-work/bun/e2e-state");

function daemon(state: string): Promise<{ proc: ChildProcess; url: string }> {
  const proc = spawn("bun", ["src/main.ts", "serve", "--bind", "127.0.0.1:0", "--state-dir", state, "--workspace", state], {
    env: { KEEL_CONFIG_DIR: join(state, "config"), ...process.env, KEEL_SCRIPTED_PROVIDER: "1", KEEL_DRAIN_MS: "300", KEEL_DEFAULT_MODEL: "scripted:stand-in" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    let out = "";
    const t = setTimeout(() => reject(new Error(`no listen line:\n${out}`)), 30_000);
    const on = (d: Buffer) => {
      out += d;
      const m = out.match(/keel listening on (http:\/\/\S+?)\/? /);
      if (m) { clearTimeout(t); resolve({ proc, url: m[1]!.replace(/\/$/, "") }); }
    };
    proc.stdout!.on("data", on);
    proc.stderr!.on("data", on);
  });
}
const exited = (p: ChildProcess) => new Promise<void>((r) => (p.exitCode !== null ? r() : p.once("exit", () => r())));

const made: string[] = [];
test.afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

test("what a coordinator and the owner are told about agents, restarts and tools is true", async ({ page }) => {
  test.setTimeout(540_000);
  const state = join(ROOT, `told-${Date.now()}`);
  made.push(state);
  mkdirSync(state, { recursive: true });
  let d = await daemon(state);
  const call = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
    fetch(d.url + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => r.json() as any);
  const text = (path: string) => fetch(d.url + path).then((r) => r.text());
  const open = async (title: string, mode = "full-auto") => {
    const { session } = await call("/api/sessions", { model: "scripted:stand-in", title });
    await call(`/api/sessions/${session.id}/permissions`, { mode }, "PUT");
    return session.id as string;
  };
  const send = (id: string, t: string) => call(`/api/sessions/${id}/messages`, { text: t });
  const events = async (id: string) => (await call(`/api/sessions/${id}`)).events as any[];
  const str = (r: any): string => (typeof r.content === "string" ? r.content : r.content.map((c: any) => c.text ?? "").join("\n"));
  const results = async (id: string) => (await events(id)).filter((e) => e.kind === "tool_result").flatMap((e) => e.data.results as any[]);
  const inputs = async (id: string) => (await events(id)).filter((e) => e.kind === "user").map((e) => String(e.data.text)).join("\n\n");
  const idle = (id: string, timeout = 60_000) => expect.poll(async () => (await call(`/api/sessions/${id}?events=0`)).running, { timeout }).toBe(false);
  const atTool = (id: string) => expect.poll(async () => (await call(`/api/sessions/${id}?events=0`)).status?.kind, { timeout: 30_000 }).toBe("tool");
  const calls = (c: unknown[]) => `script:calls ${JSON.stringify(c)}`;
  const bash = (command: string) => ({ name: "Bash", input: { command } });
  const agent = (message: string) => ({ name: "spawn_agent", input: { message, isolation: "none" } });
  const record = async () => (await call("/api/daemon")).last_start;
  const restart = async (signal: "SIGKILL" | "SIGTERM") => {
    d.proc.kill(signal);
    await exited(d.proc);
    d = await daemon(state);
    await expect.poll(async () => (await record())?.settled_ms ?? 0, { timeout: 120_000 }).toBeGreaterThan(0);
    return record();
  };
  const status = () => {
    const said = spawnSync("bun", ["src/main.ts", "status", "--url", d.url], { encoding: "utf8", env: { ...process.env, KEEL_CONFIG_DIR: join(state, "config") } });
    expect(said.status, said.stderr).toBe(0);
    return said.stdout;
  };
  const jobsOf = async (id: string) => (await call(`/api/sessions/${id}/jobs`)).jobs as any[];
  const commands: string[] = []; // sessions whose commands outlive a daemon: stopped at the end
  // The two long commands, each with a length of its own for this run: the processes of them that run on the machine.
  const tag = String(Date.now() % 100_000).padStart(5, "0");
  const HUNG = `sleep 600.${tag}`, STOPPED = `sleep 601.${tag}`;
  const processes = (command: string) => spawnSync("ps", ["-eo", "pid,ppid,stat,args"], { encoding: "utf8" }).stdout.split("\n").filter((l) => l.trimEnd().endsWith(` ${command}`));

  try {
    // --- sessions in every state
    const five = await open("Five tool calls");
    await send(five, `Run the five checks\n${calls([
      bash("echo ok-one"), bash("echo 'fatal: remote rejected the push (protected branch)' >&2; exit 3"),
      { name: "Read", input: { file_path: "/nonexistent/told-missing.txt" } }, bash("echo 'error: no upstream configured' >&2; exit 1"),
      { name: "NoSuchTool", input: { x: 1 } },
    ])}`);
    const approval = await open("Needs approval", "ask");
    await send(approval, calls([bash(`echo asked >> ${join(state, "asked.txt")}`)]));
    const question = await open("Asks a question");
    await send(question, calls([{ name: "AskUserQuestion", input: { questions: [{ header: "Store", question: "Which database should hold the queue?", options: [{ label: "SQLite" }, { label: "Valkey" }], multiSelect: false }] } }]));
    // The one that spends most: long replies, done before the report is read.
    const spender = await open("Big spender");
    const spending = (async () => { for (let i = 0; i < 2; i++) { await send(spender, `Turn ${i} script:count`); await idle(spender, 90_000); } })();
    const stream = await open("Held stream");
    await send(stream, `Draft the summary script:hold ${join(state, "gate")}`);
    const hung = await open("Hung tool");
    await send(hung, `Wait on the lock\n${calls([bash(`${HUNG}; echo unlocked`)])}`);
    commands.push(hung);
    const fail3 = (i: number) => bash(`echo 'error: lane ${i} build failed at step ${i}' >&2; exit 2`);
    const coord = await open("Dozen lanes");
    await send(coord, `Run twelve lanes\n${calls([
      ...[1, 2, 3, 4].map((i) => agent(`Quota lane ${i}\nscript:billing`)),
      ...[1, 2, 3].map((i) => agent(`Tool lane ${i}\n${calls([fail3(i), fail3(i), fail3(i), bash("echo recovered")])}`)),
      ...[1, 2].map((i) => agent(`Good lane ${i}\n${calls([bash(`echo built-${i}`), { name: "Write", input: { file_path: join(state, `good-${i}.txt`), content: "built\n" } }])}`)),
      ...[1, 2].map((i) => agent(`Slow lane ${i}\n${calls([bash(`sleep 60${i}; echo slow-${i}`)])}`)),
      agent(`Parked lane\n${calls([{ name: "wait_for", input: { kind: "timer", seconds: 1800, note: "wait for CI" } }])}`),
      bash("echo started-all"),
    ])}`);
    const agents = async () => (await call(`/api/sessions/${coord}/agents`)).agents as any[];
    const tally = async () => { const by: Record<string, number> = {}; for (const a of await agents()) by[a.status] = (by[a.status] ?? 0) + 1; return by; };
    await expect.poll(tally, { timeout: 120_000 }).toEqual({ failed: 4, completed: 5, running: 2, waiting: 1 });
    await idle(coord, 60_000);
    await idle(five);
    await spending;
    const lanes = await agents();
    const lane = (title: string) => lanes.find((a) => a.title === title)!;
    commands.push(lane("Slow lane 1").session_id, lane("Slow lane 2").session_id);

    // --- item 3: the report a coordinator reads, through its own tool; item 6: what is new since its last read
    await send(coord, calls([
      { name: "keel__sessions_list", input: { report: true, max: 11 } },
      { name: "keel__session_timeline", input: { new: true } },
      { name: "keel__session_timeline", input: { new: true } },
    ]));
    await idle(coord);
    const [report, first, again] = (await results(coord)).slice(-3).map(str) as [string, string, string];
    const lines = report.split("\n");
    // Every agent is counted, the failed ones are all listed, and the ones not listed are said. It read "Your agents (10)" of twelve.
    expect(lines[1]).toBe("Your agents (12; 2 not listed: 2 reported):");
    const listed = lines.slice(2, 12);
    expect(listed.filter((l) => /: failed .* ago: quota or billing/.test(l))).toHaveLength(4);
    for (const a of lanes.filter((x) => x.status === "failed")) expect(report).toContain(`[agent=${a.id}]`);
    // Eleven rows asked for: ten are the agents', one a session that needs the owner. The session that spent most is not
    // among them, and still leads "Most spent"; the line of what is left out says what those sessions did.
    expect(report).not.toContain('"Big spender":');
    const spent = (await call(`/api/sessions/${spender}?events=0`)).session.usage.cost as number;
    expect(spent).toBeGreaterThan(0.01);
    expect(lines.at(-1)!.startsWith(`Most spent since then: "Big spender" $${spent.toFixed(2)}, `), lines.at(-1)).toBe(true);
    const left = lines.at(-2)!.match(/^(\d+) more sessions not listed: .* \((\d+) turns, \$[\d.]+\)\.$/);
    expect(left, lines.at(-2)).not.toBeNull();
    expect(Number(left![2])).toBeGreaterThanOrEqual(3); // the spender's two turns and the five calls' one, at least
    expect(lines.at(-2)).not.toContain("the quietest");
    // With room for every session, the ones at rest that did nothing are the only ones that could be called quiet.
    const whole = await text(`/api/overview?format=text&of=${coord}&max=200`);
    expect(whole).not.toMatch(/more sessions? not listed/);
    // A reply being streamed reads so from its first seconds, with one duration (it read "between steps").
    expect(whole).toMatch(/\n {2}"Held stream": step 1, the model is answering, for \d+ (s|min)  \[session=/);
    expect(await text(`/api/sessions/${stream}/timeline?format=text`)).toMatch(/\n {2}Running a turn started by the owner: step 1, the model is answering, for \d+ (s|min)  \[turn=/);
    // The first read with new has nothing to compare with and says so; the second, a moment later, is one line.
    expect(first.split("\n")[0]).toContain("newest first (no earlier read of yours is kept: every row).");
    expect(again).toMatch(/^Nothing new in session "Dozen lanes" since you last read it at \d\d:\d\d:\d\d \(\d+ m?s ago\)\. Now: working\.$/);

    // --- item 4: a failed agent stays in the numbers served for its parent's row
    expect((await call("/api/state")).states[coord]).toMatchObject({ agents_total: 12, agents_failed: 4, agents_waiting: 1 });

    // --- item 5: receipts, reasons, counts, reports, the parked notice
    const fiveEvents = await events(five);
    const turn = fiveEvents.find((e) => e.kind === "turn_start")!;
    // Four of the five calls returned errors, the unknown tool among them. It read "3 failed tools".
    expect(fiveEvents.filter((e) => e.kind === "tool_result").flatMap((e) => e.data.results).map((r: any) => !!r.is_error)).toEqual([false, true, true, true, true]);
    expect(fiveEvents.find((e) => e.kind === "turn_end")!.data).toMatchObject({ steps: 6, tools: 5, tool_errors: 4 });
    expect((await text(`/api/sessions/${five}/timeline?format=text`))).toContain("Owner prompt, 6 steps, 4 failed tools");
    const receipt = await call(`/api/debug/turns/${turn.id}/receipt`);
    expect(receipt.tools.map((t: any) => [t.status, t.name, t.exit ?? null, !!t.unknown, !!t.span_id])).toEqual([
      ["ok", "Bash", null, false, true], ["error", "Bash", 3, false, true], ["error", "Read", null, false, true], ["error", "Bash", 1, false, true], ["error", "NoSuchTool", null, true, true],
    ]);
    const told = await call(`/api/telemetry?session_id=${five}`);
    expect(told.total).toMatchObject({ tool_calls: 5, tool_errors: 4 });
    expect(told.tools.map((t: any) => t.tool).sort()).toEqual(["Bash", "NoSuchTool", "Read"]);
    // A shell failure's reason is what the command printed last, not "Exit code 3".
    const reasons = ((await call(`/api/telemetry/examples?session_id=${five}&limit=10`)).examples ?? []).map((e: any) => e.error);
    expect(reasons.sort()).toEqual([
      "File does not exist: /nonexistent/told-missing.txt", "No tool named NoSuchTool.",
      "error: no upstream configured (exit code 1)", "fatal: remote rejected the push (protected branch) (exit code 3)",
    ]);
    // An agent's report says what it did after its words: three failed of four was "Done with 4 calls. Last result: recovered".
    const got = await inputs(coord);
    const reportOf = (title: string) => got.slice(got.indexOf(`title="${title}"`)).split("</subagent_result>")[0]!;
    expect(reportOf("Tool lane 1")).toMatch(/\(What it did: 5 steps, 4 tool calls, 3 failed \(Bash 3\)\.\)\n$/);
    expect(reportOf("Good lane 1")).toMatch(/\(What it did: 3 steps, 2 tool calls; edited 1 file: [^)]*good-1\.txt\.\)\n$/);
    // The parked notice names the agent, what it waits on and when it is due.
    expect(got).toMatch(new RegExp(`\\[harness\\] Agent "Parked lane" \\(${lane("Parked lane").id}\\) is parked on timer wait \\w+, due in (29|30) min \\(at \\d\\d:\\d\\d\\)\\. It has not finished; its report comes when it does\\.`));
    // The page: the receipt names each failed call.
    await page.setViewportSize({ width: 1920, height: 1040 });
    await page.addInitScript(() => localStorage.setItem("keel.focus", "true"));
    await page.goto(`${d.url}/s/${five}`);
    await page.getByTestId("panel-menu").click();
    await page.getByTestId("panel-search").fill("timeline");
    await page.getByTestId("panel-pick-timeline").click();
    const row = page.getByTestId("timeline-panel").locator(`[data-testid="timeline-row"][data-id="${turn.id}"]`);
    await row.locator("button[data-row]").click();
    await expect(row.getByTestId("receipt-tools")).toHaveText("5 tool calls, 4 failed: Bash (exit 3), Read, Bash (exit 1), NoSuchTool (no such tool)");
    await shoot(page, "told-truth-01-receipt");

    // --- item 1: a kill while commands run; items 2 and 4: the record and the line to the coordinator
    await atTool(hung);
    await atTool(lane("Slow lane 1").session_id);
    await atTool(lane("Slow lane 2").session_id);
    const r1 = await restart("SIGKILL");
    const by = (r: any, id: string) => r.turns.find((t: any) => t.session_id === id);
    expect(by(r1, hung)).toMatchObject({ tools: ["Bash"], state: "continued" });
    // The command outlived the daemon: its call is told so, with the job that goes on, and nothing ran twice.
    await idle(hung);
    const cut = str((await results(hung)).at(-1));
    const job = (await jobsOf(hung)).find((j) => j.command === `${HUNG}; echo unlocked`);
    expect(job).toMatchObject({ running: true, background: true });
    expect(cut).toBe(`The daemon restarted while this command ran. The command was not interrupted: it still runs in the background (ID: ${job.id}). Its output is being written to ${job.log}. Do not start it again: a notice comes when it ends.`);
    expect((await jobsOf(hung)).filter((j) => j.command.startsWith(HUNG))).toHaveLength(1);
    expect(processes(HUNG)).toHaveLength(1);
    // The coordinator is told which of its agents were cut and what became of each, once, with its next input.
    const cutLine = `[harness] A daemon restart cut 2 of your agents mid-turn: "Slow lane 1" (${lane("Slow lane 1").id}) resumed; "Slow lane 2" (${lane("Slow lane 2").id}) resumed. A resumed agent reports as before: nothing to send it.`;
    await expect.poll(async () => (await inputs(coord)).split(cutLine).length - 1, { timeout: 90_000 }).toBe(1);
    // An agent's cut command went on too, and its report says so in the agent's words (the result it was given).
    expect(str((await results(lane("Slow lane 1").session_id)).at(-1))).toContain("The command was not interrupted: it still runs in the background");
    // The cards were open at the kill: the record says so.
    const said1 = status();
    expect(said1).toContain(`"Needs approval" cut at step 1, waiting for the owner's answer, after`);
    expect(said1).toContain(`"Asks a question" cut at step 1, waiting for the owner's answer, after`);

    // --- item 2 again: a second kill with the same cards open. It read "cut at step 1, waiting for the model".
    await expect.poll(async () => (await call(`/api/sessions/${approval}/approvals`)).approvals?.filter((a: any) => a.state === "pending").length, { timeout: 30_000 }).toBe(1);
    const r2 = await restart("SIGKILL");
    expect(by(r2, approval)).toMatchObject({ step: 1, tools: [], waiting: 1, state: "continued" });
    expect(by(r2, question)).toMatchObject({ step: 1, tools: [], waiting: 1, state: "continued" });
    const said2 = status();
    expect(said2).toContain(`"Needs approval" cut at step 1, waiting for the owner's answer, after`);
    expect(said2).toContain(`"Asks a question" cut at step 1, waiting for the owner's answer, after`);
    for (const t of ["Needs approval", "Asks a question"]) expect(said2).not.toContain(`"${t}" cut at step 1, waiting for the model`);
    // Item 7: the turn that goes on with the card says a restart started it, and the cut turns are not turns that ended.
    await expect.poll(async () => text(`/api/sessions/${approval}/timeline?format=text`), { timeout: 30_000 }).toContain("Running a turn resumed after a daemon restart: step 1, waiting for approval");
    expect(await text(`/api/overview?format=text&max=200`)).toMatch(/\n {2}"Needs approval": an approval waits, for [^;]+; 2 turns cut; \$/);
    expect(await text("/api/away?since=1h&format=text")).toMatch(/\n {2}"Needs approval", needs you: 2 turns cut by a restart; 1 approval waits; \$/);

    // --- item 1 again: a stop of the daemon stops a command its call runs, and the call is told that
    const stopped = await open("Stopped tool");
    await send(stopped, calls([bash(`${STOPPED}; echo never`)]));
    await atTool(stopped);
    const r3 = await restart("SIGTERM");
    expect(r3.before.how).not.toBe("killed");
    expect(by(r3, approval)).toMatchObject({ waiting: 1 });
    await idle(stopped);
    const gone = (await jobsOf(stopped)).find((j) => j.command === `${STOPPED}; echo never`);
    expect(gone.running).toBe(false);
    expect(str((await results(stopped)).at(-1))).toMatch(new RegExp(`^The daemon restarted while this command ran\\. The restart stopped the command after \\d+ s, before it finished\\. Its output up to then is in ${gone.log.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\. Run it again if its work is still needed\\.$`));
    expect(processes(STOPPED)).toEqual([]);
    // The command the first kill left running still runs, under the same job.
    expect((await jobsOf(hung)).find((j) => j.id === job.id)).toMatchObject({ running: true });
  } finally {
    // The commands that outlive a daemon are stopped with the test.
    for (const id of commands) for (const j of await jobsOf(id).catch(() => [])) if (j.running) await call(`/api/sessions/${id}/jobs/${j.id}/stop`, {}).catch(() => {});
    d.proc.kill("SIGKILL");
  }
});

import { expect, test } from "./isolate.ts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openPanel, SCRIPTED, shoot } from "./shots.ts";

const DEV = process.env.KEEL_DEV_DIR ?? `${process.env.HOME}/.cache/keel-work/bun/dev-checks`;
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const script = (calls: unknown[]) => `script:calls ${JSON.stringify(calls)}`;
const bash = (command: string) => ({ name: "Bash", input: { command } });

// Feature: the check ledger. A repository names its checks in .keel/checks.json;
// every run of one is recorded by the tree it ran on (the files as they are,
// uncommitted ones included). A check that passed on the same files is answered
// from the ledger instead of run again; a red one says it is red on the base
// too; the agent's report carries a proof line made from the ledger; the runs
// are rows of the session's timeline and read at /api/checks.
test("check ledger: a pass on the same tree is answered, a red check is red on main too, the report carries the proof", async ({ page, request }) => {
  test.skip(!SCRIPTED, "drives exact commands through the scripted stand-in");
  const repo = join(DEV, `checks-${Date.now()}`);
  mkdirSync(join(repo, ".keel"), { recursive: true });
  // The unit check counts its runs in an ignored file, so counting does not change the tree.
  writeFileSync(join(repo, ".gitignore"), "*.log\n");
  // (The ledger is kept by content: a repository of this run's own content has no runs of an earlier run.)
  writeFileSync(join(repo, "README.md"), `# ${repo}\n`);
  writeFileSync(join(repo, ".keel", "checks.json"), JSON.stringify({ checks: { unit: { run: "sh unit.sh", args: true }, lint: "sh lint.sh" }, wait: ["sh gate.sh"] }, null, 2));
  writeFileSync(join(repo, "unit.sh"), "echo ran >> runs.log\necho ' 3 pass'\necho ' 0 fail'\n");
  // A wait for room: it notes each time it runs, and gives up with the status it is given.
  writeFileSync(join(repo, "gate.sh"), "echo waited >> gates.log\nexit \"$1\"\n");
  writeFileSync(join(repo, "lint.sh"), "echo 'a.ts(1,1): error'\necho 'Found 2 errors.'\nexit 1\n");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", "-A");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "first");
  const mainCommit = git(repo, "rev-parse", "HEAD");
  const mainTree = git(repo, "rev-parse", "HEAD^{tree}");

  const { session } = await (await request.post("/api/sessions", { data: { workspace: repo } })).json();
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto" } });
  const named = await (await request.get(`/api/checks/named?cwd=${encodeURIComponent(repo)}`)).json();
  expect(named).toMatchObject({ source: "file", checks: [{ name: "unit", args: true }, { name: "lint", args: false }] });
  await page.goto(`/s/${session.id}`);
  const idle = async (id = session.id) => {
    const d = await (await request.get(`/api/sessions/${id}`)).json();
    return !d.running && d.events.at(-1)?.kind === "turn_end";
  };

  // 1. A wait that gives up: the lint check never starts, and nothing is recorded (never a red).
  // Then on main itself the lint check is red: recorded on main's tree, behind a wait that let it
  // through, piped through tail with a command after it, and still known by its own exit.
  // A check started in the background (the shell tool's own background mode) is recorded when it ends.
  await page.getByTestId("composer").fill(script([bash("sh gate.sh 1 && sh lint.sh 2>&1 | tail -5"), bash("sh gate.sh 0 && sh lint.sh 2>&1 | tail -5; echo after"), { name: "Bash", input: { command: "sh gate.sh 0 && sh unit.sh --in-background", run_in_background: true } }]));
  await page.keyboard.press("Enter");
  await expect.poll(() => idle(), { timeout: 60_000 }).toBe(true);
  const ofMain = async () => (await (await request.get(`/api/checks?session=${session.id}`)).json()).runs;
  await expect.poll(async () => (await ofMain()).length, { timeout: 30_000 }).toBe(2);
  expect(await ofMain()).toMatchObject([
    { name: "unit", command: "sh unit.sh --in-background", result: "pass", pass: 3, tree: mainTree },
    { name: "lint", result: "fail", exit: 1, fail: 2, tree: mainTree, head: mainCommit },
  ]);

  // 2. An agent in its own worktree: the unit check twice on one tree (the second is answered), an edit,
  // the unit check again (it runs), then the lint check, red on main too. Its report carries the proof.
  const child = script([bash("sh unit.sh"), bash("sh gate.sh 0 && sh unit.sh > unit.log 2>&1; tail -3 unit.log"), { name: "Write", input: { file_path: "notes.txt", content: "hello\n" } }, bash("sh unit.sh"), bash("sh lint.sh")]);
  await page.getByTestId("composer").fill(script([{ name: "spawn_agent", input: { message: `Check, edit, check\n${child}` } }]));
  await page.keyboard.press("Enter");
  const agentsOf = async () => (await (await request.get(`/api/sessions/${session.id}/agents`)).json()).agents;
  await expect.poll(async () => (await agentsOf())[0]?.status, { timeout: 90_000 }).toBe("completed");
  // Its report wakes this session, and is shown where it arrived.
  const report = page.getByTestId("agent-report").first();
  await expect(report).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => idle(), { timeout: 60_000 }).toBe(true);
  const agent = (await agentsOf())[0];
  // The unit check ran twice of its three calls (in the agent's worktree): the second was answered from the ledger.
  expect(readFileSync(join(agent.worktree, "runs.log"), "utf8").trim().split("\n")).toHaveLength(2);
  // The answer came before the wait in front of it ran: the agent's worktree never waited.
  expect(existsSync(join(agent.worktree, "gates.log"))).toBe(false);
  expect(readFileSync(join(repo, "gates.log"), "utf8").trim().split("\n")).toHaveLength(3);
  const ledger = await (await request.get(`/api/checks?session=${agent.session_id}`)).json();
  const mine = [...ledger.runs].reverse();
  expect(mine.map((r: any) => `${r.name}:${r.result}`)).toEqual(["unit:pass", "unit:answered", "unit:pass", "lint:fail"]);
  // The first ran on main's own tree (the worktree as it was made); the edit made a new one.
  expect(mine[0]).toMatchObject({ tree: mainTree, pass: 3, fail: 0 });
  expect(mine[1]).toMatchObject({ tree: mainTree, from_run: mine[0].id });
  expect(mine[2].tree).not.toBe(mainTree);
  expect(ledger.answered).toBe(1);
  // What the agent's calls were told.
  const evs = (await (await request.get(`/api/sessions/${agent.session_id}`)).json()).events;
  const results = evs.filter((e: any) => e.kind === "tool_result").flatMap((e: any) => e.data.results).map((r: any) => (typeof r.content === "string" ? r.content : r.content.map((b: any) => b.text).join("")));
  expect(results[1]).toContain("Not run: unit (`sh unit.sh`) passed on this tree at");
  expect(results[1]).toContain("To run it anyway, send the same command again.");
  expect(results[4]).toContain(`Check ledger: lint failed on this tree (2 fail). Red on main too (${mainCommit.slice(0, 9)},`);
  // The proof line: what the ledger saw after the agent's last edit.
  expect(agent.result).toMatch(/\(Checks after its last edit \(\d\d:\d\d\): unit passed \d\d:\d\d, lint failed \d\d:\d\d \(2 fail; red on main too \(/);
  expect(agent.result).toContain("No edit after the last green run. Its files are the ones its last check ran on.)");
  await report.getByRole("button").first().click();
  await expect(report).toContainText("(Checks after its last edit");
  await report.scrollIntoViewIfNeeded();
  await shoot(page, "check-ledger-01-report");

  // 3. The agent's session: the answered call in its transcript, and the runs as rows of its timeline.
  await page.goto(`/s/${agent.session_id}`);
  // The answered call says on its line that it did not run.
  const answered = page.locator('[data-testid="tool-call"][data-tool="Bash"]').nth(1);
  await expect(answered.locator(".k-line-verb")).toHaveText("Not run");
  await expect(answered.getByTestId("call-ledger")).toHaveText("passed before, same files");
  await openPanel(page, "timeline");
  const panel = page.getByTestId("timeline-panel");
  const checks = panel.locator('[data-testid="timeline-row"][data-kind="check"]');
  await expect(checks).toHaveCount(4);
  await expect(checks.first()).toContainText("Check lint failed (2 fail)");
  await expect(checks.first()).toHaveAttribute("data-tone", "failed");
  await expect(panel.locator('[data-testid="timeline-row"][data-kind="check"][data-sub="answered"]')).toContainText("Check unit answered from the ledger");
  await shoot(page, "check-ledger-02-timeline");
});

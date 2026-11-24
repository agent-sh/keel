import { expect, test } from "./isolate.ts";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SCRIPTED, shoot } from "./shots.ts";

const DEV = process.env.KEEL_DEV_DIR ?? `${process.env.HOME}/.cache/keel-work/bun/dev-checks`;
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const calls = (list: unknown[]) => `script:calls ${JSON.stringify(list)}`;
const ADD = "add() { echo $(($1 + $2)); }\n";
const BROKEN = "add() { echo $(($1 - $2)); }\n";
// (Not the base's own bytes: a change that only goes back to the base is no change of the agent's, and is not checked.)
const FIXED = "add() { echo $(( $1 + $2 )); }\n";

// (Not the base's either, and another failure than BROKEN's: a failure is told once.)
const BROKEN_AGAIN = "add() { echo $(($1 * $2)); }\n";

// Feature: checks beside the agent. A repository marks its fast checks `beside`
// in .keel/checks.json; after an agent's change Keel runs them by itself on a
// copy of the agent's files (a check that takes test files gets the tests the
// change touches), keeps each run in the check ledger by its tree, and tells
// the agent when one fails: one harness input, read at the agent's next step.
// A pass says nothing, and the agent's own run of the same command on the same
// files is answered from the ledger. A red found after the agent ended gives it
// no new work: the session that started it is told in its failures notice.
test("checks beside the agent: an edit that breaks a test is told at its next step, a fix says nothing, its own run is answered, and a finished agent is not woken", async ({ page, request, baseURL }) => {
  test.skip(!SCRIPTED, "drives exact edits through the scripted stand-in");
  const repo = join(DEV, `beside-${Date.now()}`);
  mkdirSync(join(repo, ".keel"), { recursive: true });
  // (The ledger is kept by content: a repository of this run's own content has no runs of an earlier one.)
  writeFileSync(join(repo, "README.md"), `# ${repo}\n`);
  writeFileSync(join(repo, ".keel", "checks.json"), JSON.stringify({ checks: { unit: { run: "sh unit.sh", args: true, tests: ["*.test.sh"], beside: true } } }, null, 2));
  // A test runner of its own: each file it is given, then the counts bun's runner prints.
  writeFileSync(join(repo, "unit.sh"), 'p=0; f=0; for t in "$@"; do if sh "$t"; then p=$((p+1)); else f=$((f+1)); fi; done; echo " $p pass"; echo " $f fail"; [ "$f" -eq 0 ]\n');
  writeFileSync(join(repo, "lib.sh"), ADD);
  writeFileSync(join(repo, "lib.test.sh"), '. ./lib.sh\nif [ "$(add 1 2)" = 3 ]; then echo "(pass) lib > adds"; else echo "error: add 1 2 gave $(add 1 2), not 3"; echo "(fail) lib > adds"; exit 1; fi\n');
  writeFileSync(join(repo, "other.test.sh"), 'echo "(pass) other > holds"\n');
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", "-A");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "first");

  // The window of steps taken together, none here: a run starts after the step that changed the files.
  const was = (await (await request.get("/api/settings")).json()).checks;
  expect((await request.patch("/api/settings", { data: { checks: { ...was, beside: { ...was?.beside, window_s: 0 } } } })).ok()).toBe(true);
  test.info().attach("checks setting before", { body: JSON.stringify(was) });
  try {
  const { session } = await (await request.post("/api/sessions", { data: { workspace: repo } })).json();
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto" } });
  await page.goto(`/s/${session.id}`);
  // The agent breaks the sum, then waits in a command until Keel's notice is in its queue (the run beside it
  // went red while it worked). Its next step carries the notice, and its reply is the notice's own lines, as
  // a model that read it gives.
  const queued = `for i in $(seq 600); do curl -s "${baseURL}/api/sessions/$KEEL_SESSION/queue" | grep -q checks_beside && exit 0; sleep 0.1; done; exit 1`;
  const task = `${calls([{ name: "Read", input: { file_path: "lib.sh" } }, { name: "Write", input: { file_path: "lib.sh", content: BROKEN } }, { name: "Bash", input: { command: queued } }])}\nscript:then-find adds gave`;
  await page.getByTestId("composer").fill(calls([{ name: "spawn_agent", input: { message: `Change the sum\n${task}` } }]));
  await page.keyboard.press("Enter");
  const agentsOf = async () => (await (await request.get(`/api/sessions/${session.id}/agents`)).json()).agents;
  await expect.poll(async () => (await agentsOf())[0]?.session_id, { timeout: 60_000 }).toBeTruthy();
  const agent = (await agentsOf())[0];
  const ledger = async () => (await (await request.get(`/api/checks?session=${agent.session_id}`)).json()).runs as any[];
  const eventsOf = async () => (await (await request.get(`/api/sessions/${agent.session_id}`)).json()).events as any[];
  const told = async () => (await eventsOf()).filter((e) => e.kind === "user" && e.data.kind === "checks_beside");

  await expect.poll(async () => (await told()).length, { timeout: 90_000 }).toBe(1);
  const [run] = await ledger();
  expect(run).toMatchObject({ name: "unit", command: "sh unit.sh ./lib.test.sh ./other.test.sh", by: "beside", result: "fail", pass: 1, fail: 1 });
  const notice = (await told())[0];
  expect(notice.data.text.startsWith("[harness] Checks beside your work: Keel ran unit (2 test files) by itself on your files as they were at")).toBe(true);
  expect(notice.data.text).toContain("- unit (`sh unit.sh ./lib.test.sh ./other.test.sh`): 1 of 2 failed: lib > adds");
  expect(notice.data.text).toContain("error: add 1 2 gave -1, not 3");
  // The next model step carried it: the agent's reply is the notice's own lines.
  await expect.poll(async () => {
    const evs = await eventsOf();
    const at = evs.findIndex((e) => e.id === notice.id);
    return evs.slice(at + 1).filter((e) => e.kind === "assistant").flatMap((e) => e.data.blocks).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
  }, { timeout: 60_000 }).toContain("error: add 1 2 gave -1, not 3");
  await expect.poll(async () => (await agentsOf())[0]?.status, { timeout: 60_000 }).toBe("completed");
  // One turn did all of it: the notice was read in the turn that broke the sum, and started none of its own.
  expect((await eventsOf()).filter((e) => e.kind === "turn_end")).toHaveLength(1);

  // The agent's page: the notice is a card of its own, open.
  await page.goto(`/s/${agent.session_id}`);
  const card = page.getByTestId("beside-notice");
  await expect(card).toBeVisible();
  await expect(card).toContainText("Checks beside the agent failed");
  await expect(card).toContainText("error: add 1 2 gave -1, not 3");
  await card.scrollIntoViewIfNeeded();
  await shoot(page, "checks-beside-01-notice");

  // It fixes the sum: the run beside it is green and says nothing.
  const send = (message: string) => request.post(`/api/sessions/${session.id}/agents/${agent.id}/message`, { data: { message } });
  await send(calls([{ name: "Write", input: { file_path: "lib.sh", content: FIXED } }]));
  await expect.poll(async () => (await ledger()).filter((r) => r.result === "pass").length, { timeout: 90_000 }).toBe(1);
  expect((await ledger())[0]).toMatchObject({ name: "unit", by: "beside", result: "pass", pass: 2, fail: 0 });
  await expect.poll(async () => (await agentsOf())[0]?.status, { timeout: 60_000 }).toBe("completed");
  expect(await told()).toHaveLength(1);

  // Its own run of the same command on the same files is answered from that record.
  await send(calls([{ name: "Bash", input: { command: "sh unit.sh ./lib.test.sh ./other.test.sh" } }]));
  await expect.poll(async () => (await ledger()).filter((r) => r.result === "answered").length, { timeout: 60_000 }).toBe(1);
  const results = (await eventsOf()).filter((e) => e.kind === "tool_result").flatMap((e) => e.data.results).map((r: any) => (typeof r.content === "string" ? r.content : r.content.map((b: any) => b.text).join("")));
  expect(results.at(-1)).toContain("passed on this tree at");
  expect(results.at(-1)).toContain("run by Keel beside this session's work");
  // The fix made no notice of its own.
  await expect.poll(async () => (await agentsOf())[0]?.status, { timeout: 60_000 }).toBe("completed");
  expect(await told()).toHaveLength(1);

  // It breaks the sum again and ends before the run beside it does: it is given no new work (no notice, no
  // turn); the session that started it is told in its failures, which go with its next input.
  const turns = (await eventsOf()).filter((e) => e.kind === "turn_end").length;
  await send(calls([{ name: "Write", input: { file_path: "lib.sh", content: BROKEN_AGAIN } }]));
  const checkFailures = async () => ((await (await request.get(`/api/errors?session=${session.id}`)).json()).failures as any[]).filter((g) => g.kind === "check");
  await expect.poll(async () => (await checkFailures()).length, { timeout: 90_000 }).toBe(1);
  const [group] = await checkFailures();
  expect(group).toMatchObject({ cls: "unit" });
  expect(group.refs.find((r: any) => r.id === agent.id).eg).toContain("error: add 1 2 gave 2, not 3");
  expect((await ledger())[0]).toMatchObject({ by: "beside", result: "fail" });
  expect((await agentsOf())[0]?.status).toBe("completed");
  expect(await told()).toHaveLength(1);
  expect((await eventsOf()).filter((e) => e.kind === "turn_end")).toHaveLength(turns + 1);
  // Its copy of the files went with the end of its turn.
  const state = (await (await request.get("/api/daemon")).json()).state_dir as string;
  const copy = join(state, "checks", "beside", createHash("sha256").update(agent.session_id).digest("hex").slice(0, 16));
  await expect.poll(() => existsSync(copy), { timeout: 30_000 }).toBe(false);
  } finally {
    await request.patch("/api/settings", { data: { checks: was } });
  }
});

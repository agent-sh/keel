import { expect, test } from "./isolate.ts";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SCRIPTED, shoot } from "./shots.ts";

const DEV = process.env.KEEL_DEV_DIR ?? `${process.env.HOME}/.cache/keel-work/bun/dev-checks`;
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const calls = (list: unknown[]) => `script:calls ${JSON.stringify(list)}`;
const ADD = "add() { echo $(($1 + $2)); }\n";
const BROKEN = "add() { echo $(($1 - $2)); }\n";
// (Not the base's own bytes: a change that only goes back to the base is no change of the agent's, and is not checked.)
const FIXED = "add() { echo $(( $1 + $2 )); }\n";

// Feature: checks beside the agent. A repository marks its fast checks `beside`
// in .keel/checks.json; after an agent's change Keel runs them by itself on a
// copy of the agent's files (a check that takes test files gets the tests the
// change touches), keeps each run in the check ledger by its tree, and tells
// the agent when one fails: one harness input, read at the agent's next step.
// A pass says nothing, and the agent's own run of the same command on the same
// files is answered from the ledger.
test("checks beside the agent: an edit that breaks a test is told at its next step, a fix says nothing, and its own run is answered", async ({ page, request }) => {
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

  const { session } = await (await request.post("/api/sessions", { data: { workspace: repo } })).json();
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto" } });
  await page.goto(`/s/${session.id}`);
  // The agent breaks the sum and ends its turn. The run beside it is red, and the input that tells it is
  // answered from its own text: the lines with these words, as a model that read it does.
  const task = `${calls([{ name: "Read", input: { file_path: "lib.sh" } }, { name: "Write", input: { file_path: "lib.sh", content: BROKEN } }])}\nscript:then-find adds gave`;
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
});

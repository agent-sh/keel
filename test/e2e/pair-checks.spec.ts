import { expect, test } from "./isolate.ts";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HAIKU, ask, openPanel, shoot } from "./shots.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });

// Feature: branches checked together before they land. A coordinator starts two agents that commit on
// branches of their own and keep working: one makes the accounts rule refuse bot accounts (its own tests
// pass), the other adds a provenance test that stamps a bot account (passes on the base). The two touch
// no common file and merge clean, but the provenance test reaches the accounts rule through an import,
// so Keel merges them on the base in a worktree of its own and runs the repository's fast checks: red
// together, green on each alone, red again. Both cards on the Board say so with the failing test and the
// two heads, and the coordinator is told once.
test("two branches that merge clean and fail together are said on both cards and to their parent", async ({ page, request }) => {
  test.setTimeout(180_000);
  await request.put("/api/permissions/settings", { data: { default_mode: "full-auto" } });
  const kept = (await (await request.get("/api/settings")).json()).settings.together ?? null;
  // No quiet window: the pair is due as soon as the forecast says both branches merge clean.
  expect((await request.patch("/api/settings", { data: { together: { quiet_s: 0 } } })).ok()).toBe(true);
  try {
    const top = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `pairs-${Date.now()}`);
    const repo = join(top, "repo"), a = join(top, "a"), b = join(top, "b");
    for (const d of [repo, a, b]) mkdirSync(d, { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    const files: Record<string, string> = {
      "accounts.js": "export const allowed = (who) => who.length > 0;\n",
      "provenance.js": 'import { allowed } from "./accounts.js";\nexport const stamp = (who) => (allowed(who) ? `signed:${who}` : "unsigned");\n',
      "provenance.test.js": 'import { expect, test } from "bun:test";\nimport { stamp } from "./provenance.js";\ntest("stamp signs people", () => expect(stamp("ana")).toBe("signed:ana"));\n',
      "lint.sh": "test -s accounts.js\n",
      ".keel/checks.json": JSON.stringify({ checks: { unit: { run: "bun test", args: true, tests: ["*.test.js"] }, lint: "sh lint.sh" } }),
    };
    mkdirSync(join(repo, ".keel"));
    for (const [f, t] of Object.entries(files)) writeFileSync(join(repo, f), t);
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "init");
    // What each agent's commit holds.
    writeFileSync(join(a, "accounts.js"), 'export const allowed = (who) => who.length > 0 && !who.endsWith("-bot");\n');
    writeFileSync(join(a, "accounts.test.js"), 'import { expect, test } from "bun:test";\nimport { allowed } from "./accounts.js";\ntest("the rule refuses bot accounts", () => expect(allowed("ci-bot")).toBe(false));\n');
    writeFileSync(join(b, "provenance.test.js"), `${files["provenance.test.js"]}test("stamp keeps a bot's provenance", () => expect(stamp("ci-bot")).toBe("signed:ci-bot"));\n`);
    const gate = join(top, "may-end");

    const idle = (id: string) => expect.poll(async () => { const d = await (await request.get(`/api/sessions/${id}`)).json(); return !d.running && d.events.at(-1)?.kind === "turn_end"; }, { timeout: 90_000 }).toBe(true);
    const calls = (list: unknown[]) => `script:calls ${JSON.stringify(list)}`;
    const bash = (command: string, timeout?: number) => ({ name: "Bash", input: { command, ...(timeout ? { timeout } : {}) } });
    const commit = (from: string, msg: string) => `cp ${from}/* . && git add -A && git -c user.name=k -c user.email=k@k commit -qm '${msg}'`;
    const wait = bash(`while [ ! -e '${gate}' ]; do sleep 0.2; done`, 600_000);

    const coord = (await (await request.post("/api/sessions", { data: { model: HAIKU, workspace: repo, title: "Coordinator" } })).json()).session.id as string;
    const lane = (title: string, steps: unknown[]) => ({ name: "spawn_agent", input: { message: `${title}\n${calls(steps)}` } });
    await request.post(`/api/sessions/${coord}/messages`, { data: { text: ask("Start two agents.", `script:batch ${JSON.stringify([
      lane("Accounts rule", [bash(commit(a, "Refuse bot accounts")), wait]),
      lane("Provenance tests", [bash(commit(b, "Test bot provenance")), wait]),
    ])}`) } });
    const agentsOf = async () => (await (await request.get(`/api/sessions/${coord}/agents`)).json()).agents as any[];
    const by = async (title: string) => (await agentsOf()).find((x) => x.title === title);
    await expect.poll(async () => { const x = await by("Accounts rule"), y = await by("Provenance tests"); return !!x?.branch && !!y?.branch && git(repo, "log", "-1", "--format=%s", x.branch).trim() + "|" + git(repo, "log", "-1", "--format=%s", y.branch).trim(); }, { timeout: 60_000 }).toBe("Refuse bot accounts|Test bot provenance");
    const acc = await by("Accounts rule"), prov = await by("Provenance tests");
    expect([acc.status, prov.status]).toEqual(["running", "running"]);
    const accTip = git(repo, "rev-parse", acc.branch).trim(), provTip = git(repo, "rev-parse", prov.branch).trim();
    // The forecast finds them clean: no file in common.
    expect(git(repo, "merge-tree", "--write-tree", "--name-only", accTip, provTip).trim()).toMatch(/^[0-9a-f]{40}$/);

    // The board reads the pair's result on both rows, at both heads.
    const board = async () => (await (await request.get(`/api/sessions/${coord}/board?fresh=1`)).json()) as any;
    const rowOf = (bd: any, id: string) => bd.rows.find((r: any) => r.id === id);
    await expect.poll(async () => rowOf(await board(), acc.id)?.together?.[0]?.state, { timeout: 90_000 }).toBe("red");
    const bd = await board();
    const ra = rowOf(bd, acc.id).together[0], rp = rowOf(bd, prov.id).together[0];
    expect(ra).toMatchObject({ with: prov.branch, with_agent: prov.id, head: accTip, with_head: provTip, state: "red", why: "test", checks: [{ name: "unit", tests: ["stamp keeps a bot's provenance"] }] });
    expect(rp).toMatchObject({ with: acc.branch, with_agent: acc.id, head: provTip, with_head: accTip, state: "red" });

    // The coordinator is told once: one cause in its failure record, both agents under it, and one notice with both heads and the failing test.
    const group = async () => ((await (await request.get(`/api/errors?session=${coord}`)).json()).failures as any[]).find((g) => g.cls === "red together");
    await expect.poll(async () => ((await group())?.refs ?? []).map((r: any) => r.id).sort(), { timeout: 60_000 }).toEqual([acc.id, prov.id].sort());
    await expect.poll(async () => (await group())?.owed, { timeout: 60_000 }).toBe(0);
    expect((await group()).count).toBe(2);
    const notices = async () => ((await (await request.get(`/api/sessions/${coord}`)).json()).events as any[]).filter((e) => e.kind !== "tool_result" && String(e.data?.text ?? "").includes("<failures>") && String(e.data?.text ?? "").includes("fail together with another live branch"));
    await expect.poll(async () => (await notices()).length, { timeout: 30_000 }).toBe(1);
    const text = String((await notices())[0].data.text);
    expect(text).toContain(accTip.slice(0, 9));
    expect(text).toContain(provTip.slice(0, 9));
    expect(text).toContain("stamp keeps a bot's provenance");
    // The coordinator's tool reads it too.
    await idle(coord);
    await request.post(`/api/sessions/${coord}/messages`, { data: { text: calls([{ name: "keel__work_board", input: {} }]) } });
    await idle(coord);
    const last = await (await request.get(`/api/sessions/${coord}`)).json();
    expect(JSON.stringify(last.events.filter((e: any) => e.kind === "tool_result").at(-1)?.data ?? {})).toContain(`red together with ${prov.branch}`);

    // Both cards, in both themes.
    await page.goto(`/s/${coord}`);
    await openPanel(page, "board");
    const panel = page.getByTestId("work-board");
    const card = (id: string) => panel.locator(`[data-testid="board-row"][data-agent="${id}"]`);
    for (const [id, other, mine, theirs] of [[acc.id, prov.branch, accTip, provTip], [prov.id, acc.branch, provTip, accTip]] as const) {
      const red = card(id).getByTestId("board-together-red");
      await expect(red).toHaveAttribute("data-with", other);
      await expect(red.getByTestId("board-together-test")).toHaveText("stamp keeps a bot's provenance");
      await expect(red.getByTestId("board-together-heads")).toContainText(`${mine.slice(0, 9)} + ${theirs.slice(0, 9)}`);
    }
    await page.mouse.move(0, 0);
    await shoot(page, "pair-checks-01-board");

    // The agents end; nothing is told again.
    writeFileSync(gate, "");
    await expect.poll(async () => (await agentsOf()).filter((x) => x.status === "completed").length, { timeout: 60_000 }).toBe(2);
    await idle(coord);
    expect((await group()).count).toBe(2);
    expect((await notices()).length).toBe(1);
  } finally {
    await request.patch("/api/settings", { data: { together: { quiet_s: kept?.quiet_s ?? 120 } } });
  }
});

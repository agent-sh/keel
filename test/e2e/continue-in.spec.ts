import { expect, test } from "./isolate.ts";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { shoot } from "./shots.ts";

// Feature: a session goes on in Claude Code or Codex with one press. The row's menu writes its history in that
// harness's own transcript format under the harness's own folder, opens a terminal here on the harness's resume
// command in the session's folder, and archives the row with where it went (still readable, its strip has the
// command). When the harness writes to it, the session shows as one of the harness's, saying where it came from,
// and the list has one row of it. A copy of a Claude Code session whose original is still there resumes that
// original instead, and the original shows again. Run the daemon with KEEL_IMPORT_CLAUDE_DIR at a scratch store;
// the terminal is a stand-in that opens no window (fixtures/terminal-standin.sh) and logs what it was given.
const SCRIPTED = "scripted:stand-in";

test("a session continues in Claude Code with one press, and a copy resumes its original", async ({ page, request }) => {
  const listed = await (await request.get("/api/import/sessions?limit=1")).json();
  const root = listed.harnesses?.find((h: any) => h.harness === "claude")?.store as string | undefined;
  test.skip(!root || !root.includes("keel-work"), "needs a scratch Claude Code store (KEEL_IMPORT_CLAUDE_DIR)");
  const models = (await (await request.get("/api/models")).json()).models as { id: string }[];
  test.skip(!models.some((m) => m.id === SCRIPTED), "requires the scripted provider");
  const tag = String(Date.now());
  const work = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `continue-${tag}`);
  const cwd = join(work, "proj");
  mkdirSync(cwd, { recursive: true });
  const log = join(work, "terminal.log");
  writeFileSync(log, "");
  const standin = join(import.meta.dirname, "fixtures/terminal-standin.sh");
  const before = (await (await request.get("/api/settings")).json()).settings.terminal;
  expect((await request.patch("/api/settings", { data: { terminal: { command: `sh ${standin} ${log}`, tmux: false } } })).ok()).toBe(true);
  const made: string[] = [];
  const all = async () => ((await (await request.get("/api/sessions")).json()).sessions as any[]);
  const mirrorOf = async (id: string) => (await all()).find((s) => s.outside?.source_id === id);
  // What Claude Code writes when it resumes a session: a prompt and a reply, appended to its transcript.
  const resumeWrites = (path: string, id: string, words: string) => {
    const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    let parent = [...lines].reverse().find((r) => r.uuid)?.uuid ?? null;
    for (const [i, r] of [
      { type: "user", message: { role: "user", content: words } },
      { type: "assistant", message: { id: `m${tag}`, role: "assistant", model: "claude-opus-4-5", content: [{ type: "text", text: `Done: ${words}` }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } } },
    ].entries()) {
      const uuid = `${id}-resumed-${i}`;
      appendFileSync(path, JSON.stringify({ cwd, sessionId: id, version: "2.1.300", isSidechain: false, userType: "external", entrypoint: "cli", timestamp: new Date().toISOString(), uuid, parentUuid: parent, ...r }) + "\n");
      parent = uuid;
    }
  };
  try {
    // A session of Keel's with a conversation.
    const { session } = await (await request.post("/api/sessions", { data: { model: SCRIPTED, title: `Tidy the loader ${tag}`, workspace: cwd } })).json();
    made.push(session.id);
    await request.post(`/api/sessions/${session.id}/messages`, { data: { text: `Tidy the config loader ${tag}` } });
    await expect.poll(async () => (await (await request.get(`/api/sessions/${session.id}`)).json()).events.filter((e: any) => e.kind === "turn_end").length, { timeout: 30_000 }).toBe(1);

    // Its row's menu: Continue in Claude Code, Continue in Codex; no original to resume (it is no copy).
    await page.goto(`/s/${session.id}`);
    const row = page.locator(`[data-testid="session-row"][data-session="${session.id}"]`);
    await row.click({ button: "right" });
    const menu = page.getByTestId("row-menu");
    await expect(menu.getByTestId("row-menu-resume-claude")).toHaveText("Resume in Claude Code");
    await expect(menu.getByTestId("row-menu-resume-codex")).toHaveText("Resume in Codex");
    await expect(menu.getByTestId("row-menu-original")).toHaveCount(0);
    await shoot(page, "continue-01-menu");

    // One press: written in Claude Code's folder, a terminal opened on it there, the row archived with where it went.
    await menu.getByTestId("row-menu-resume-claude").click();
    const bar = page.getByTestId("moved-bar");
    await expect(bar).toBeVisible();
    await expect(bar).toHaveAttribute("data-opened", "");
    await expect(bar.getByTestId("moved-said")).toContainText("Moved to Claude Code");
    await expect(bar.getByTestId("moved-terminal")).toContainText("A terminal opened on it (sh)");
    const moved = (await (await request.get(`/api/sessions/${session.id}`)).json()).session.settings.moved;
    expect(moved.harness).toBe("claude");
    expect(moved.path.startsWith(root!)).toBe(true);
    expect(existsSync(moved.path)).toBe(true);
    expect(readFileSync(moved.path, "utf8")).toContain(`Tidy the config loader ${tag}`);
    await expect(bar.getByTestId("moved-command")).toHaveText(`claude --resume ${moved.target_id}`);
    await expect(bar.getByTestId("moved-command")).toHaveAttribute("title", `cd ${cwd} && claude --resume ${moved.target_id}`);
    await expect(bar.getByTestId("moved-folder")).toHaveText(`in ${cwd}`);
    // The terminal was started in the session's folder, on the login shell, with the resume command.
    const said = readFileSync(log, "utf8").split("\n");
    expect(said).toContain(`cwd ${cwd}`);
    expect(said).toContain("arg -lic");
    expect(said.some((l) => l.startsWith(`arg cd ${cwd} && claude --resume ${moved.target_id}; exec `))).toBe(true);
    // Archived: out of the list, still readable.
    await expect(page.getByTestId("transcript").getByText(`Tidy the config loader ${tag}`).first()).toBeVisible();
    expect((await (await request.get(`/api/sessions/${session.id}`)).json()).session.archived).toBe(true);
    await shoot(page, "continue-02-moved");

    // Claude Code resumes it and writes: it shows as a session of Claude Code's, that says it came from here.
    await expect.poll(async () => { resumeWrites(moved.path, moved.target_id, `and the tests ${tag}`); return !!(await mirrorOf(moved.target_id)); }, { timeout: 30_000, intervals: [2000] }).toBe(true);
    const mirror = (await mirrorOf(moved.target_id)).id as string;
    made.push(mirror);
    await page.goto(`/s/${mirror}`);
    const from = page.getByTestId("outside-moved-from");
    await expect(from).toContainText(`Moved here from Keel: Tidy the loader ${tag}`);
    // One row of it in the list: Claude Code's.
    const rows = page.getByTestId("session-list").locator('[data-testid="session-row"]').filter({ hasText: tag });
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toHaveAttribute("data-session", mirror);
    await shoot(page, "continue-03-in-claude");
    // Its name leads back to the archived session, which says where it went.
    await from.getByRole("link").click();
    await expect(page.getByTestId("moved-bar")).toBeVisible();

    // A copy of a Claude Code session whose original is still there: its menu offers the original first.
    const origId = `c0c0c0c0-0000-4000-8000-${tag.slice(-12).padStart(12, "0")}`;
    const dir = join(root!, cwd.replace(/[^A-Za-z0-9]/g, "-"));
    mkdirSync(dir, { recursive: true });
    const origPath = join(dir, `${origId}.jsonl`);
    writeFileSync(origPath, [
      { type: "user", message: { role: "user", content: `Name the keeper ${tag}` } },
      { type: "assistant", message: { id: "m1", role: "assistant", model: "claude-opus-4-5", content: [{ type: "text", text: "The keeper is Ada." }], stop_reason: "end_turn" } },
    ].map((r, i) => JSON.stringify({ cwd, sessionId: origId, version: "2.1.300", isSidechain: false, userType: "external", entrypoint: "cli", timestamp: new Date().toISOString(), uuid: `${origId}-${i}`, parentUuid: i ? `${origId}-${i - 1}` : null, ...r })).join("\n") + "\n");
    const copy = (await (await request.post("/api/import", { data: { harness: "claude", id: origId, path: origPath, model: SCRIPTED } })).json()).session.id as string;
    made.push(copy);
    await page.goto(`/s/${copy}`);
    const copyRow = page.locator(`[data-testid="session-row"][data-session="${copy}"]`);
    await copyRow.click({ button: "right" });
    const original = menu.getByTestId("row-menu-original");
    await expect(original).toHaveText("Resume the original in Claude Code");
    await expect(menu.getByTestId("row-menu-resume-claude")).toBeVisible();
    await shoot(page, "continue-04-copy-menu");
    await original.click();
    await expect(bar.getByTestId("moved-said")).toContainText("Resumed its original in Claude Code");
    await expect(bar.getByTestId("moved-command")).toHaveText(`claude --resume ${origId}`);
    expect(readFileSync(log, "utf8")).toContain(`claude --resume ${origId}; exec `);
    // Nothing new was written: the original is the session there.
    expect((await (await request.get(`/api/sessions/${copy}`)).json()).session.settings.moved.path).toBe(origPath);
    // The original shows again when Claude Code writes to it: the moved copy no longer hides it.
    await expect.poll(async () => { resumeWrites(origPath, origId, `keeper again ${tag}`); return !!(await mirrorOf(origId)); }, { timeout: 30_000, intervals: [2000] }).toBe(true);
    made.push((await mirrorOf(origId)).id);

    // Open a terminal again: the same command, no new transcript.
    await page.goto(`/s/${copy}`);
    writeFileSync(log, "");
    await bar.getByTestId("moved-open").click();
    await expect.poll(() => readFileSync(log, "utf8")).toContain(`claude --resume ${origId}; exec `);
    await shoot(page, "continue-05-copy-moved");

    // No terminal: the move still lands in Claude Code's folder, and the strip says why and keeps the command.
    expect((await request.patch("/api/settings", { data: { terminal: { command: `sh ${join(work, "no-such-terminal.sh")}` } } })).ok()).toBe(true);
    const { session: other } = await (await request.post("/api/sessions", { data: { model: SCRIPTED, title: `No window ${tag}`, workspace: cwd } })).json();
    made.push(other.id);
    await request.post(`/api/sessions/${other.id}/messages`, { data: { text: `Count the files ${tag}` } });
    await expect.poll(async () => (await (await request.get(`/api/sessions/${other.id}`)).json()).events.filter((e: any) => e.kind === "turn_end").length, { timeout: 30_000 }).toBe(1);
    const r = await (await request.post(`/api/sessions/${other.id}/continue`, { data: { harness: "claude" } })).json();
    expect(r.moved.opened).toBe(false);
    expect(r.moved.why).toContain("ended at once");
    expect(existsSync(r.moved.path)).toBe(true);
    await page.goto(`/s/${other.id}`);
    await expect(bar).not.toHaveAttribute("data-opened", "");
    await expect(bar.getByTestId("moved-terminal")).toContainText("No terminal opened");
    await shoot(page, "continue-06-no-terminal");

    // Brought back from the archive it is Keel's again: no strip saying it went, one row of it.
    const back = await (await request.patch(`/api/sessions/${other.id}`, { data: { archived: false } })).json();
    expect(back.session.archived).toBe(false);
    expect(back.session.settings.moved).toBeUndefined();
    // A session of another harness is answered there or forked first; it is not moved again.
    expect((await request.post(`/api/sessions/${(await mirrorOf(origId)).id}/continue`, { data: { harness: "claude" } })).status()).toBe(409);

    // An original whose id in its transcript is no id Claude Code makes is not resumed: the id would go on a command line.
    const bent = join(work, "bent");
    const badId = `abc$(touch ${bent})`;
    const badPath = join(dir, `d0d0d0d0-0000-4000-8000-${tag.slice(-12).padStart(12, "0")}.jsonl`);
    writeFileSync(badPath, [
      { type: "user", message: { role: "user", content: `Bent id ${tag}` } },
      { type: "assistant", message: { id: "m1", role: "assistant", model: "claude-opus-4-5", content: [{ type: "text", text: "Noted." }], stop_reason: "end_turn" } },
    ].map((r, i) => JSON.stringify({ cwd, sessionId: badId, version: "2.1.300", isSidechain: false, userType: "external", entrypoint: "cli", timestamp: new Date().toISOString(), uuid: `bent-${tag}-${i}`, parentUuid: i ? `bent-${tag}-${i - 1}` : null, ...r })).join("\n") + "\n");
    const listedBad = ((await (await request.get("/api/import/sessions?harness=claude&limit=200")).json()).sessions as any[]).find((x) => x.path === badPath);
    const badCopy = (await (await request.post("/api/import", { data: { harness: "claude", id: listedBad?.id ?? badId, path: badPath, model: SCRIPTED } })).json()).session?.id as string | undefined;
    expect(badCopy).toBeTruthy();
    made.push(badCopy!);
    const refused = await request.post(`/api/sessions/${badCopy}/continue`, { data: { harness: "claude", original: true } });
    expect(refused.status()).toBe(409);
    expect((await refused.json()).error).toContain("resume it there by hand");
    expect(existsSync(bent)).toBe(false);
  } finally {
    await request.patch("/api/settings", { data: { terminal: before ?? { command: "", tmux: true } } });
    for (const s of made) await request.delete(`/api/sessions/${s}`).catch(() => {});
  }
});

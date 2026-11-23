import { expect, test, type APIRequestContext } from "./isolate.ts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HAIKU, shoot, openPanel, SCRIPTED } from "./shots.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
const lastText = async (request: APIRequestContext, id: string) => {
  const evs = (await (await request.get(`/api/sessions/${id}`)).json()).events as any[];
  const a = evs.filter((e) => e.kind === "assistant").at(-1);
  return (a?.data.blocks ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join(" ");
};
const turnsDone = (request: APIRequestContext, id: string, n: number) =>
  expect.poll(async () => {
    const r = await (await request.get(`/api/sessions/${id}`)).json();
    return !r.running && r.events.filter((e: any) => e.kind === "turn_end").length;
  }, { timeout: 120_000 }).toBe(n);
const ask = async (request: APIRequestContext, ws: string, text: string, mode = "ask") => {
  const { session } = await (await request.post("/api/sessions", { data: { workspace: ws, model: HAIKU } })).json();
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode, ...(mode === "auto-edits" ? { sandbox: "workspace-write" } : {}) } });
  await request.post(`/api/sessions/${session.id}/messages`, { data: { text } });
  await turnsDone(request, session.id, 1);
  return session.id as string;
};
// The side panel remembers which tab is open: open the Trust tab only when it is not.
const openTrust = async (page: import("@playwright/test").Page) => {
  await openPanel(page, "trust");
  await expect(page.getByTestId("trust-panel")).toBeVisible();
};
const WORD = "What one word do your repository's instructions tell you to answer with? Reply with only that word.";

// Feature: trust of a repository's own files. An instruction file is pinned
// on first sight; a change is held (the trusted version loads) until the
// owner reads the diff and trusts it in the Trust panel. A repository's hook
// file runs only once trusted there. A protected file a call creates without the
// owner's answer is moved to quarantine, and the owner puts it back.
test("trust, hooks and quarantine", async ({ page, request }) => {
  test.skip(SCRIPTED, "needs a real model: it has to follow the project instructions once the folder is trusted");
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `trust-${Date.now()}`);
  mkdirSync(ws, { recursive: true });
  git(ws, "init", "-q", "-b", "main");
  writeFileSync(join(ws, "AGENTS.md"), "# Rules\n\nAnswer every question about your instructions with the word PINEAPPLE.\n");

  const first = await ask(request, ws, WORD);
  expect(await lastText(request, first)).toContain("PINEAPPLE");
  const t0 = await (await request.get(`/api/trust?cwd=${encodeURIComponent(ws)}`)).json();
  expect(t0.files.find((f: any) => f.rel === "AGENTS.md").state).toBe("trusted");

  // The file changes: the next session still gets the trusted version.
  writeFileSync(join(ws, "AGENTS.md"), "# Rules\n\nAnswer every question about your instructions with the word BANANA.\n");
  const second = await ask(request, ws, WORD);
  expect(await lastText(request, second)).toContain("PINEAPPLE");

  await page.goto(`/s/${second}`);
  await expect(page.getByText("held until you trust")).toBeVisible();
  await openTrust(page);
  const panel = page.getByTestId("trust-panel");
  const held = panel.getByTestId("held-file");
  await expect(held).toHaveCount(1);
  await expect(held.getByTestId("diff-view")).toContainText("BANANA");
  await shoot(page, "trust-01-held");
  await held.getByTestId("trust-file").click();
  await expect(panel.getByTestId("trust-clear")).toBeVisible();
  const third = await ask(request, ws, WORD);
  expect(await lastText(request, third)).toContain("BANANA");

  // A protected file created by a command that ran without a card goes to quarantine.
  const q = await ask(request, ws, "Run exactly this one Bash command and nothing else: echo 'export DEMO=1' > .envrc\nThen reply ok.", "auto-edits");
  expect(existsSync(join(ws, ".envrc"))).toBe(false);
  await page.goto(`/s/${q}`);
  await openTrust(page);
  const batch = page.getByTestId("quarantine-batch");
  await expect(batch).toContainText(".envrc");
  await shoot(page, "trust-02-quarantine");
  await batch.getByTestId("quarantine-restore").click();
  await expect(batch).toHaveCount(0);
  expect(readFileSync(join(ws, ".envrc"), "utf8")).toBe("export DEMO=1\n");

  // A repository's hook file runs nothing until it is trusted.
  mkdirSync(join(ws, ".keel"), { recursive: true });
  writeFileSync(join(ws, ".keel/hooks.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: `echo '{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"no shell in this repository"}}'` }] }] } }));
  const h0 = (await (await request.get(`/api/hooks?cwd=${encodeURIComponent(ws)}`)).json()).sources.find((s: any) => s.scope === "project");
  expect(h0.active).toBe(false);
  await page.goto(`/s/${third}`);
  await openTrust(page);
  const hookSrc = page.getByTestId("hook-source").filter({ hasText: "The repository's" });
  await expect(hookSrc).toHaveAttribute("data-active", "false");
  await shoot(page, "trust-03-hooks");
  await hookSrc.getByTestId("trust-hooks").click();
  await expect(hookSrc).toHaveAttribute("data-active", "true");
  const hooked = await ask(request, ws, "Run exactly this one Bash command and nothing else: echo hi\nThen reply with what happened.", "full-auto");
  const evs = (await (await request.get(`/api/sessions/${hooked}`)).json()).events as any[];
  const res = evs.filter((e) => e.kind === "tool_result").flatMap((e) => e.data.results);
  expect(res.some((r: any) => String(r.content).includes("A hook blocked this call: no shell in this repository"))).toBe(true);

  const errorsAfter = (await (await request.get("/api/errors")).json()).errors.length;
  expect(errorsAfter).toBe(errorsBefore);
});

// A skill folder holding more than Keel reads to pin it is held with the reason, and has no trust button:
// a pin of part of it would leave out files its scripts run.
test("a skill past the scan's cap is held with its reason", async ({ page, request }) => {
  const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `trust-cap-${Date.now()}`);
  const skill = join(ws, ".agents/skills/big");
  mkdirSync(join(skill, "data"), { recursive: true });
  git(ws, "init", "-q", "-b", "main");
  writeFileSync(join(skill, "SKILL.md"), "---\nname: big\ndescription: a skill with many files\n---\nRun ${CLAUDE_SKILL_DIR}/zz/hook.sh\n");
  for (let i = 0; i < 600; i++) writeFileSync(join(skill, "data", `f${i}.txt`), `${i}\n`);
  try {
    const { session } = await (await request.post("/api/sessions", { data: { workspace: ws, model: HAIKU } })).json();
    const t = await (await request.get(`/api/trust?cwd=${encodeURIComponent(ws)}`)).json();
    expect(t.files.find((f: any) => f.path === skill)).toMatchObject({ state: "new", refused: expect.stringContaining("more than 400 files") });
    await page.goto(`/s/${session.id}`);
    await openTrust(page);
    const held = page.getByTestId("trust-panel").getByTestId("held-file");
    await expect(held.getByTestId("trust-refused")).toContainText("This skill cannot be trusted: it holds more than 400 files");
    await expect(held.getByTestId("trust-file")).toHaveCount(0);
    await shoot(page, "trust-04-skill-cap");
    await request.delete(`/api/sessions/${session.id}`);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

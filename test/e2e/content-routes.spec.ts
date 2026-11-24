import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "./isolate.ts";
import { daemon, exited, ROOT, sessionsFolder } from "./own-daemon.ts";
import { scrollsSideways, shoot } from "./shots.ts";

// Feature: a folder's content stays on the providers the owner allowed for it.
// Settings > Content routes names the providers per folder (and for every other
// folder). A session in a folder that allows its model's provider works; one
// whose provider is not allowed has its turn refused before anything is sent,
// said once in its failures with the purpose and the provider; a new session
// there on that provider is refused, a worktree session made from the folder is
// held to the folder's rule, and the owner switches a refused session to an
// allowed model in its picker and goes on. An agent on a provider its parent's
// folder does not allow is not started. The same page shows, from the ledger,
// which provider saw which session's content, by purpose, and none outside the
// rule. The spec runs a daemon of its own with two scripted providers.
const FIRST = "scripted:stand-in";
const SECOND = "scripted-b:stand-in";

test("content routes: a folder's calls go only to its allowed providers, and the page shows who saw what", async ({ page }) => {
  test.setTimeout(180_000);
  const state = join(ROOT, `content-routes-${Date.now()}`);
  const d = await daemon(state, 0, false, { KEEL_SCRIPTED_SECOND: "1" });
  const ws = sessionsFolder(state);
  const A = join(ws, "allowed");
  const B = join(ws, "elsewhere");
  const C = join(ws, "added-in-the-page");
  const R = join(ws, "repo");
  for (const f of [A, B, C, R]) mkdirSync(f, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: R, env: { ...process.env, GIT_AUTHOR_NAME: "Spec", GIT_AUTHOR_EMAIL: "spec@example.invalid", GIT_COMMITTER_NAME: "Spec", GIT_COMMITTER_EMAIL: "spec@example.invalid" } });
  git("init", "-q", "-b", "main");
  writeFileSync(join(R, "README.md"), "fixture\n");
  git("add", ".");
  git("commit", "-q", "-m", "fixture");
  const call = async (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") => {
    const r = await fetch(d.url + path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
  };
  const api = async (path: string, body?: unknown, method?: string) => (await call(path, body, method)).body;
  const events = async (id: string) => (await api(`/api/sessions/${id}`)).events as any[];
  const ends = async (id: string) => (await events(id)).filter((e) => e.kind === "turn_end").length;
  const errors = async (id: string) => (await events(id)).filter((e) => e.kind === "error");
  const rule = async () => (await api("/api/settings")).settings.content_routes;
  const session = async (workspace: string, model = FIRST) => {
    const r = await call("/api/sessions", { model, workspace, title: `Routes ${workspace.split("/").at(-1)}` });
    expect(r.status).toBe(201);
    return r.body.session.id as string;
  };
  const say = async (id: string, text = "Say hello in one line.") => {
    const n = await ends(id);
    await api(`/api/sessions/${id}/messages`, { text });
    await expect.poll(() => ends(id), { timeout: 30_000 }).toBe(n + 1);
  };
  try {
    expect((await api("/api/models")).models.map((m: any) => m.id)).toEqual(expect.arrayContaining([FIRST, SECOND]));
    // Made before the rule: a session in B, and a worktree session made from R, on a provider their folders will not allow.
    const inB = await session(B);
    const made = await call("/api/worktrees", { workspace: R, model: FIRST, title: "Routes worktree" });
    expect(made.status).toBe(201);
    const inWt = made.body.session.id as string;
    expect(made.body.session.workspace.startsWith(R)).toBe(false); // the worktree is a folder of Keel's own
    // B and R allow only the second provider; A only the first, named in the page below.
    expect((await call("/api/settings", { content_routes: { folders: { [B]: ["scripted-b"], [R]: ["scripted-b"] } } }, "PATCH")).status).toBe(200);

    await page.goto(`${d.url}/settings/routes`);
    await expect(page.getByTestId("content-routes")).toBeVisible();
    const add = async (path: string) => {
      await page.getByTestId("route-folder-path").fill(path);
      await page.getByRole("button", { name: "Add", exact: true }).click();
      await expect(page.locator(`[data-testid="route-folder"][data-name="${path}"]`)).toBeVisible();
    };
    await add(A);
    // A new folder starts with every provider that can answer: A keeps the first one only.
    const rowA = page.locator(`[data-testid="route-folder"][data-name="${A}"]`);
    const others = rowA.locator('[data-provider][aria-checked="true"]:not([data-provider="scripted"])');
    while (await others.count()) {
      const n = await others.count();
      await others.first().click();
      await expect(others).toHaveCount(n - 1);
    }
    await expect.poll(async () => (await rule()).folders[A]).toEqual(["scripted"]);
    await expect(rowA.locator('[data-provider="scripted"]')).toHaveAttribute("aria-checked", "true");

    // A folder added and removed in the page leaves nothing behind.
    await add(C);
    await page.getByRole("button", { name: `Remove ${C}` }).click();
    await expect(page.locator(`[data-testid="route-folder"][data-name="${C}"]`)).toHaveCount(0);
    await expect.poll(async () => C in (await rule()).folders).toBe(false);

    // In A the turn runs on its allowed provider.
    const inA = await session(A);
    await say(inA);
    expect(await errors(inA)).toEqual([]);

    // In B the turn is not sent: the session says why, with the purpose and the provider.
    await say(inB);
    const refused = (await errors(inB))[0];
    expect(refused?.data.message).toContain("turn call to scripted:stand-in not sent: provider scripted is not allowed");
    expect((await events(inB)).some((e) => e.kind === "assistant")).toBe(false);
    // Once in its failures scope, as one cause, however often it is refused.
    await say(inB, "And again.");
    expect(await errors(inB)).toHaveLength(2);
    const causes = ((await api(`/api/errors?session=${inB}`)).failures as any[]).filter((g) => g.cls === "route turn scripted");
    expect(causes).toHaveLength(1);
    expect(causes[0].count).toBe(2);
    // A new session in B, or a worktree made from R, on the provider they do not allow is refused before it is made.
    const r = await call("/api/sessions", { model: FIRST, workspace: B });
    expect(r.status).toBe(409);
    expect(r.body.error).toContain("provider scripted is not allowed for this folder");
    expect((await call("/api/worktrees", { workspace: R, model: FIRST })).status).toBe(409);

    // The worktree session is held to R's rule, though its folder is under Keel's state.
    await say(inWt);
    expect((await errors(inWt))[0]?.data.message).toContain("provider scripted is not allowed");

    // An agent of A's session on the provider A does not allow is not started.
    await api(`/api/sessions/${inA}/permissions`, { mode: "full-auto" }, "PUT");
    await api(`/api/sessions/${inA}/messages`, { text: `script:calls ${JSON.stringify([{ name: "spawn_agent", input: { message: "Look around", model: SECOND, isolation: "none" } }])}` });
    await expect.poll(async () => JSON.stringify((await events(inA)).filter((e) => e.kind === "tool_result")), { timeout: 30_000 }).toContain("agent call to scripted-b:stand-in not sent");

    await page.goto(`${d.url}/s/${inB}`);
    await expect(page.getByTestId("turn-error").first()).toContainText("provider scripted is not allowed");
    await shoot(page, "content-routes-01-refused");

    // The owner switches the refused session to a model of an allowed provider in its picker, and it goes on.
    await page.getByTestId("model-picker").click();
    const option = page.getByTestId("model-popup").locator(`[data-testid="model-option"][data-model="${SECOND}"]`).first();
    await option.scrollIntoViewIfNeeded();
    await Promise.all([page.waitForResponse((res) => res.url().endsWith(`/api/sessions/${inB}`) && res.request().method() === "PATCH" && res.ok()), option.click()]);
    await expect.poll(async () => (await api(`/api/sessions/${inB}`)).session.model).toBe(SECOND);
    await say(inB, "Now on the allowed provider.");
    expect(await errors(inB)).toHaveLength(2);
    expect((await events(inB)).some((e) => e.kind === "assistant")).toBe(true);
    await expect(page.getByTestId("turn-error")).toHaveCount(2);
    await shoot(page, "content-routes-04-switched");
    // And the worktree session too.
    expect((await call(`/api/sessions/${inWt}`, { model: SECOND }, "PATCH")).status).toBe(200);
    await say(inWt, "Now on the allowed provider.");
    expect(await errors(inWt)).toHaveLength(1);
    // Nor can it be switched back to a provider R does not allow.
    expect((await call(`/api/sessions/${inWt}`, { model: FIRST }, "PATCH")).status).toBe(409);

    // The page: who saw what, by folder, session, purpose and provider; nothing outside the rule.
    await page.goto(`${d.url}/settings/routes`);
    const seen = page.getByTestId("content-seen");
    await expect(seen.locator(`[data-testid="seen-folder"][data-folder="${A}"] [data-testid="seen-row"][data-purpose="turn"][data-provider="scripted"]`)).toBeVisible();
    // The worktree session's calls are R's.
    await expect(seen.locator(`[data-testid="seen-folder"][data-folder="${R}"] [data-testid="seen-row"][data-purpose="turn"][data-provider="scripted-b"]`)).toBeVisible();
    await expect(seen.locator('[data-testid="seen-row"][data-crossing]')).toHaveCount(0);
    await expect(page.getByTestId("content-seen-total")).toContainText("none outside today's rule");
    // B's refused turns were never sent: the ledger has no call of B's on the first provider.
    await expect(seen.locator(`[data-testid="seen-folder"][data-folder="${B}"] [data-provider="scripted"]`)).toHaveCount(0);
    expect((await api("/api/content-routes")).crossing).toBe(0);
    await seen.scrollIntoViewIfNeeded();
    await shoot(page, "content-routes-02-page");
    // A phone: the table fits its box, and what it dropped is listed under each row.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(seen.locator(`[data-testid="seen-folder"][data-folder="${A}"] dl`).first()).toContainText("Purpose");
    expect(await scrollsSideways(seen)).toEqual([]);
    await shoot(page, "content-routes-02-narrow");
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.getByTestId("route-instead").locator("summary").click();
    await page.getByTestId("route-scope").locator("summary").click();
    await expect(page.getByTestId("route-scope")).toContainText("parent folder of a named one");
    await page.getByTestId("route-instead").scrollIntoViewIfNeeded();
    await shoot(page, "content-routes-03-instead");
  } finally {
    d.proc.kill("SIGKILL");
    await exited(d.proc);
    rmSync(state, { recursive: true, force: true });
  }
});

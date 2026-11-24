import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "./isolate.ts";
import { shoot } from "./shots.ts";

// Feature: a folder's content stays on the providers the owner allowed for it.
// Settings > Content routes names the providers per folder (and for every other
// folder). A session in a folder that allows its model's provider works; one
// whose provider is not allowed has its turn refused before anything is sent,
// said once in its failures with the purpose and the provider; a new session
// there on that provider is refused. The same page shows, from the ledger,
// which provider saw which session's content, by purpose, and none outside the
// rule. With the second scripted provider (KEEL_SCRIPTED_SECOND=1) an agent on
// a provider its parent's folder does not allow is refused too.
const STAND_IN = "scripted:stand-in";
const SECOND = "scripted-b:stand-in";
const ROOT = join(process.env.HOME!, ".cache/keel-work/bun/content-routes-fixture");
const A = join(ROOT, "allowed");
const B = join(ROOT, "elsewhere");
const C = join(ROOT, "added-in-the-page");

test("content routes: a folder's calls go only to its allowed providers, and the page shows who saw what", async ({ page, request }) => {
  test.setTimeout(120_000);
  const models = (await (await request.get("/api/models")).json()).models.map((m: any) => m.id);
  test.skip(!models.includes(STAND_IN), "needs the scripted provider: the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const second = models.includes(SECOND);
  for (const d of [A, B, C]) mkdirSync(d, { recursive: true });
  const before = (await (await request.get("/api/settings")).json()).settings.content_routes;
  const events = async (id: string) => (await (await request.get(`/api/sessions/${id}`)).json()).events as any[];
  const ended = async (id: string) => (await events(id)).some((e) => e.kind === "turn_end");
  const made: string[] = [];
  const session = async (workspace: string, model = STAND_IN) => {
    const r = await request.post("/api/sessions", { data: { model, workspace, title: `Routes ${workspace.split("/").at(-1)}` } });
    expect(r.status()).toBe(201);
    const { session: s } = await r.json();
    made.push(s.id);
    return s.id as string;
  };
  try {
    // Made before the rule: the session in B is on a provider B will not allow.
    const inB = await session(B);
    // B allows only the second provider; A only the first, named in the page below.
    expect((await request.patch("/api/settings", { data: { content_routes: { folders: { [B]: ["scripted-b"] } } } })).ok()).toBe(true);

    await page.goto("/settings/routes");
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
    await expect.poll(async () => (await (await request.get("/api/settings")).json()).settings.content_routes.folders[A]).toEqual(["scripted"]);
    await expect(rowA.locator('[data-provider="scripted"]')).toHaveAttribute("aria-checked", "true");

    // A folder added and removed in the page leaves nothing behind.
    await add(C);
    await page.getByRole("button", { name: `Remove ${C}` }).click();
    await expect(page.locator(`[data-testid="route-folder"][data-name="${C}"]`)).toHaveCount(0);
    await expect.poll(async () => C in (await (await request.get("/api/settings")).json()).settings.content_routes.folders).toBe(false);

    // In A the turn runs on its allowed provider.
    const inA = await session(A);
    await request.post(`/api/sessions/${inA}/messages`, { data: { text: "Say hello in one line." } });
    await expect.poll(() => ended(inA), { timeout: 30_000 }).toBe(true);
    expect((await events(inA)).filter((e) => e.kind === "error")).toEqual([]);

    // In B the turn is not sent: the session says why, with the purpose and the provider.
    await request.post(`/api/sessions/${inB}/messages`, { data: { text: "Say hello in one line." } });
    await expect.poll(() => ended(inB), { timeout: 30_000 }).toBe(true);
    const refused = (await events(inB)).find((e) => e.kind === "error");
    expect(refused?.data.message).toContain("turn call to scripted:stand-in not sent: provider scripted is not allowed");
    expect((await events(inB)).some((e) => e.kind === "assistant")).toBe(false);
    // Once in its failures scope, as one cause, however often it is refused.
    await request.post(`/api/sessions/${inB}/messages`, { data: { text: "And again." } });
    await expect.poll(async () => (await events(inB)).filter((e) => e.kind === "error").length, { timeout: 30_000 }).toBe(2);
    const record = (await (await request.get(`/api/errors?session=${inB}`)).json()).failures as any[];
    const causes = record.filter((g) => g.cls === "route turn scripted");
    expect(causes).toHaveLength(1);
    expect(causes[0].count).toBe(2);
    // A new session in B on the provider B does not allow is refused before it is made.
    const r = await request.post("/api/sessions", { data: { model: STAND_IN, workspace: B } });
    expect(r.status()).toBe(409);
    expect((await r.json()).error).toContain("provider scripted is not allowed for this folder");

    if (second) {
      // On the provider B allows, B's session works.
      const inB2 = await session(B, SECOND);
      await request.post(`/api/sessions/${inB2}/messages`, { data: { text: "Say hello in one line." } });
      await expect.poll(() => ended(inB2), { timeout: 30_000 }).toBe(true);
      expect((await events(inB2)).filter((e) => e.kind === "error")).toEqual([]);
      // An agent of A's session on the provider A does not allow is not started.
      await request.put(`/api/sessions/${inA}/permissions`, { data: { mode: "full-auto" } });
      await request.post(`/api/sessions/${inA}/messages`, { data: { text: `script:calls ${JSON.stringify([{ name: "spawn_agent", input: { message: "Look around", model: SECOND, isolation: "none" } }])}` } });
      await expect.poll(async () => JSON.stringify((await events(inA)).filter((e) => e.kind === "tool_result")), { timeout: 30_000 }).toContain("agent call to scripted-b:stand-in not sent");
    }

    await page.goto(`/s/${inB}`);
    await expect(page.getByTestId("turn-error").first()).toContainText("provider scripted is not allowed");
    await shoot(page, "content-routes-01-refused");

    // The page: who saw what, by folder, session, purpose and provider; nothing outside the rule.
    await page.goto("/settings/routes");
    const seen = page.getByTestId("content-seen");
    await expect(seen.locator(`[data-testid="seen-folder"][data-folder="${A}"] [data-testid="seen-row"][data-purpose="turn"][data-provider="scripted"]`)).toBeVisible();
    await expect(seen.locator('[data-testid="seen-row"][data-crossing]')).toHaveCount(0);
    await expect(page.getByTestId("content-seen-total")).toContainText("none outside today's rule");
    // B's refused turns were never sent: the ledger has no call of B's session.
    await expect(seen.locator(`[data-testid="seen-folder"][data-folder="${B}"] [data-provider="scripted"]`)).toHaveCount(0);
    const report = await (await request.get("/api/content-routes")).json();
    expect(report.crossing).toBe(0);
    await seen.scrollIntoViewIfNeeded();
    await shoot(page, "content-routes-02-page");
    await page.getByTestId("route-instead").locator("summary").click();
    await page.getByTestId("route-instead").scrollIntoViewIfNeeded();
    await shoot(page, "content-routes-03-instead");
  } finally {
    for (const id of made) await request.delete(`/api/sessions/${id}`);
    const folders = (await (await request.get("/api/settings")).json()).settings.content_routes.folders;
    await request.patch("/api/settings", { data: { content_routes: { default: before?.default ?? null, folders: Object.fromEntries(Object.keys(folders).filter((k) => !(k in (before?.folders ?? {}))).map((k) => [k, null])) } } });
  }
});

import { expect, test } from "./isolate.ts";
import { shoot } from "./shots.ts";

// Feature: rate-limit and plan usage windows, and account states. Settings >
// Providers shows each provider's windows as meters and an account that
// refuses its credential or turns over billing as one actionable note; a
// session on such a provider gets a chip beside the model picker, and the
// picker marks the provider's group.
test("limits: windows in Settings, account states, the chip by the picker", async ({ page, request }) => {
  const limits = await (await request.get("/api/limits?refresh")).json();
  const { providers } = await (await request.get("/api/providers")).json();
  const set = new Set(providers.filter((p: any) => p.available).map((p: any) => p.id));

  await page.goto("/settings/providers");
  const panel = page.getByTestId("providers-panel");
  await expect(panel).toBeVisible();
  for (const w of limits.windows.filter((w: any) => set.has(w.provider)))
    await expect(panel.locator(`[data-provider="${w.provider}"] [data-window="${w.provider}:${w.id}"]`)).toBeVisible();
  const problems = Object.entries<any>(limits.problems).filter(([id]) => set.has(id));
  for (const [id, p] of problems) {
    const row = panel.locator(`[data-provider="${id}"]`);
    await expect(row.getByTestId("provider-problem")).toHaveAttribute("data-kind", p.kind);
    // Said once: a refused listing is not repeated as a listing error.
    if (p.source === "listing") await expect(row.getByTestId("listing-error")).toHaveCount(0);
  }
  await shoot(page, "limits-01-settings");

  // A session on a provider that refuses turns: the chip says so before a turn fails again.
  // A provider whose listing was refused has no model to start a session on.
  const { models } = await (await request.get("/api/models")).json();
  let listed = problems.filter(([id]) => models.some((m: any) => m.provider === id));
  // None here: the scripted stand-in refuses a turn over billing, an account state that stays until a turn succeeds.
  const stand = models.find((m: any) => m.id === "scripted:stand-in");
  let clear: string | undefined;
  if (!listed.length && stand) {
    const t = (await (await request.post("/api/sessions", { data: { model: stand.id, title: "Billing refused", text: "script:billing" } })).json()).session;
    clear = t.id;
    await expect.poll(async () => (await (await request.get("/api/limits")).json()).problems.scripted?.kind, { timeout: 30_000 }).toBe("billing");
    listed = [["scripted", (await (await request.get("/api/limits")).json()).problems.scripted]];
  }
  const refused = listed.find(([, p]) => p.kind === "billing") ?? listed[0];
  test.skip(!refused, "no provider with a listed model has an account problem");
  const [pid, p] = refused!;
  const model = models.find((m: any) => m.provider === pid);
  const s = (await (await request.post("/api/sessions", { data: { model: model.id } })).json()).session;
  await page.goto(`/s/${s.id}`);
  const chip = page.getByTestId("limit-chip");
  await expect(chip).toContainText(p.kind === "billing" ? "Billing" : "Key refused");
  await chip.click();
  await expect(page.getByTestId("limit-popup").getByTestId("provider-problem")).toBeVisible();
  await shoot(page, "limits-02-chip");
  await page.keyboard.press("Escape");

  await page.getByTestId("model-picker").click();
  await page.getByPlaceholder("Search models").fill(model.name);
  await expect(page.locator(`[data-testid="model-group"][data-group="${pid}"] [data-testid="group-problem"]`)).toBeVisible();
  await page.keyboard.press("Escape");
  await request.delete(`/api/sessions/${s.id}`);
  if (clear) {
    // A turn that goes through clears the state.
    await request.post(`/api/sessions/${clear}/messages`, { data: { text: "Say anything." } });
    await expect.poll(async () => (await (await request.get("/api/limits")).json()).problems.scripted, { timeout: 30_000 }).toBeUndefined();
    await request.delete(`/api/sessions/${clear}`);
  }
});

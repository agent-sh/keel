import { expect, test } from "./isolate.ts";
import { shoot } from "./shots.ts";

// Feature: the owner's agent tiers (agents.tiers, src/engine/tiers.ts). Settings > Models shows a card that
// reads the table from his own words once (src/server/routes/tiers.ts): a small model of his chain writes
// what he typed as rows, the card shows each row with his words, and only "Use these tiers" makes them the
// setting. The table then shows the rows, takes one more by hand, and a spawn with no model starts on its
// tier and says which and why. Nothing is a default: the table starts empty.
const URL_ = process.env.KEEL_URL!;
const MODEL = process.env.KEEL_TEST_MODEL ?? "scripted:stand-in";

async function api(path: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
  const r = await fetch(URL_ + path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
}
const ended = async (id: string) => ((await api(`/api/sessions/${id}`)).body.events as any[]).filter((e) => e.kind === "turn_end").length;

test("the tiers come from the owner's words once he says so, and a spawn with no model starts on its tier", async ({ page }) => {
  test.skip(!MODEL.startsWith("scripted:"), "needs the scripted provider: the stand-in writes the owner's words as a table");
  test.setTimeout(120_000);
  const was = (await api("/api/settings")).body.settings.agents;
  test.skip(was.tiers.length > 0 || was.tiers_import !== null, "needs a daemon whose owner has no tiers yet: the card shows only then");
  const listed = ((await api("/api/models")).body.models as any[]).map((m) => m.id as string).filter((id) => id.startsWith("scripted:"));
  const strict = listed.find((id) => id !== MODEL) ?? MODEL;
  try {
    // His words, in a session of his: the stand-in reads the rows from them.
    const rows = [
      { name: "delicate", model: strict, effort: "high", use: ["review"], words: "complex and delicate work to the strong one" },
      { name: "build", model: MODEL, use: ["default"], words: "most work to this one" },
      { name: "reader", model: "scripted:not-listed", words: "code reading by the small readers" },
    ];
    const s = (await api("/api/sessions", { model: MODEL, title: "tiers in my words" })).body.session.id as string;
    await api(`/api/sessions/${s}/messages`, { text: `The agent tiers I want, with their effort. script:tiers ${JSON.stringify(rows)}` });
    await expect.poll(() => ended(s), { timeout: 30_000 }).toBeGreaterThan(0);

    await page.goto(`${URL_}/settings/models`);
    const box = page.getByTestId("agent-tiers");
    await expect(box).toBeVisible();
    await expect(box.getByTestId("tiers-table")).toHaveCount(0);
    const card = box.getByTestId("tiers-import");
    await expect(card).toContainText("Use the tiers from your words");
    await card.getByTestId("tiers-import-read").click();
    await expect(card.getByTestId("tiers-import-row")).toHaveCount(3);
    await expect(card.getByTestId("tiers-import-row").nth(0)).toContainText("complex and delicate work");
    await expect(card.getByTestId("tiers-import-row").nth(2)).toContainText("(not listed)");
    // Nothing is kept before his yes.
    expect((await api("/api/settings")).body.settings.agents.tiers).toEqual([]);
    await card.scrollIntoViewIfNeeded();
    await shoot(page, "agent-tiers-01-import");
    await card.getByTestId("tiers-import-use").click();
    await expect(box.getByTestId("tier-row")).toHaveCount(3);
    await expect(box.getByTestId("tiers-import")).toHaveCount(0);
    const after = (await api("/api/settings")).body.settings.agents;
    expect(after.tiers_import).toBe("used");
    expect(after.tiers.map((t: any) => [t.name, t.model, t.effort, t.use])).toEqual([["delicate", strict, "high", ["review"]], ["build", MODEL, undefined, ["default"]], ["reader", "scripted:not-listed", undefined, undefined]]);
    // The import is once: asked again, it is refused.
    expect((await api("/api/agent-tiers/import/draft", {})).status).toBe(409);

    // One more by hand.
    await box.getByTestId("tier-name").fill("research");
    await box.getByTestId("model-picker").click();
    await page.getByTestId("model-popup").locator(`[data-testid="model-option"][data-model="${strict}"]`).first().click();
    await box.getByTestId("tier-uses").fill("research");
    await expect(box.getByTestId("tier-hint")).toContainText("research:");
    await box.getByTestId("tier-add").click();
    await expect(box.getByTestId("tier-row")).toHaveCount(4);
    await box.scrollIntoViewIfNeeded();
    await shoot(page, "agent-tiers-02-table");

    // A spawn that names no model starts on the tier for every other agent, and its result says so.
    await api(`/api/sessions/${s}/permissions`, { mode: "full-auto" }, "PUT");
    const before = await ended(s);
    await api(`/api/sessions/${s}/messages`, { text: `script:calls ${JSON.stringify([{ name: "spawn_agent", input: { message: "a small job", background: true } }])}` });
    await expect.poll(() => ended(s), { timeout: 30_000 }).toBeGreaterThan(before);
    const said = ((await api(`/api/sessions/${s}`)).body.events as any[]).filter((e) => e.kind === "tool_result").map((e) => JSON.stringify(e.data)).join("\n");
    expect(said).toContain("Tier build");
    expect(said).toContain("because tier build is for every other agent");
    const agents = (await api(`/api/sessions/${s}/agents`)).body.agents as any[];
    expect(agents[0]?.model).toBe(MODEL);
  } finally {
    await api("/api/settings", { agents: { tiers: null, tiers_import: null } }, "PATCH");
  }
});

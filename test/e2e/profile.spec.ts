import { expect, test } from "./isolate.ts";
import { HAIKU, shoot, openPanel } from "./shots.ts";

// Feature: the session profile. The Profile tab shows the session's model and
// route, its reasoning and speed against what the model offers, the tools its
// family gets and the instruction files of its prompt; POST profile moves the
// session to another model with its reasoning and speed in one step, keeping a
// speed the new model offers and refusing one it does not.
test("profile: the panel, and a model pick with reasoning and speed", async ({ page, request }) => {
  const s = (await (await request.post("/api/sessions", { data: { model: HAIKU } })).json()).session;
  const prof = await (await request.get(`/api/sessions/${s.id}/profile`)).json();
  expect(prof.model.id).toBe(HAIKU);
  expect(prof.tool_profile.family).toBe("claude");
  expect(prof.eager_tools.length).toBeGreaterThan(3);

  await page.goto(`/s/${s.id}`);
  await openPanel(page, "profile");
  const panel = page.getByTestId("profile-panel");
  await expect(panel.getByTestId("profile-model")).toContainText(prof.model.name);
  await expect(panel.getByTestId("profile-tools")).toContainText(prof.tool_profile.edit_grammar);
  await shoot(page, "profile-01-claude");

  // A plan model with a speed offer, if one is listed: pick it with its top effort and its speed.
  const { models } = await (await request.get("/api/models")).json();
  const target = models.find((m: any) => !m.hidden && m.speeds?.length && m.efforts?.length && m.family !== "claude");
  if (target) {
    const offer = target.speeds[0];
    const effort = target.efforts.at(-1);
    const bad = await request.post(`/api/sessions/${s.id}/profile`, { data: { model: target.id, speed: "no-such-speed" } });
    expect(bad.status()).toBe(400);
    const r = await (await request.post(`/api/sessions/${s.id}/profile`, { data: { model: target.id, reasoning: effort, speed: offer.id } })).json();
    expect(r.session.model).toBe(target.id);
    expect(r.reasoning.choice).toBe(effort);
    expect(r.speed.choice).toBe(offer.id);
    await expect(panel.getByTestId("profile-model")).toContainText(target.name);
    await expect(panel.getByTestId("profile-speed")).toContainText(offer.label);
    await shoot(page, "profile-02-switched");
    // Back to a model without that speed: the speed goes back to standard.
    const back = await (await request.post(`/api/sessions/${s.id}/profile`, { data: { model: HAIKU } })).json();
    expect(back.speed.choice).toBe("standard");
    expect(back.reasoning.choice).toBeUndefined();
  }
  await request.delete(`/api/sessions/${s.id}`);
});

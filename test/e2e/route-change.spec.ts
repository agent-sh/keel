import { join } from "node:path";
import { expect, test } from "./isolate.ts";
import { daemon, exited, ROOT } from "./own-daemon.ts";
import { shoot } from "./shots.ts";

// Feature: the owner's rule for a route that is out. Settings > Models holds rules of the form
// "agents of this type, when this provider has been out for N minutes, go on on this model" (src/engine/route-change.ts).
// A provider goes unreachable (the scripted stand-in plays it: `script:outage ... on scripted`).
// An agent on it waits N minutes, goes on on the model the rule names with its context, says so in its
// own transcript and once on its parent's line, and finishes there. A session of the owner's on the
// same provider keeps waiting: the rule is for agents only. The spec runs a daemon of its own with
// two scripted providers.
const OUT = "scripted:stand-in";
const OTHER = "scripted-b:stand-in";
const MINUTES = 0.1;

// A daemon of the spec's own with two scripted providers, and what the specs ask of it.
async function world(name: string) {
  const state = join(ROOT, `route-change-${name}-${Date.now()}`);
  const d = await daemon(state, 0, false, { KEEL_SCRIPTED_SECOND: "1" });
  const call = async (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") => {
    const r = await fetch(d.url + path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
  };
  const api = async (path: string, body?: unknown, method?: string) => (await call(path, body, method)).body;
  const events = async (id: string) => (await api(`/api/sessions/${id}`)).events as any[];
  const ended = async (id: string) => (await events(id)).some((e) => e.kind === "turn_end");
  const open = async (model: string, title: string) => {
    const r = await call("/api/sessions", { model, title });
    expect(r.status).toBe(201);
    const id = r.body.session.id as string;
    await api(`/api/sessions/${id}/permissions`, { mode: "full-auto" }, "PUT");
    return id;
  };
  const why = async (id: string) => (await api("/api/state")).states?.[id]?.why;
  // The parent's agent, started on the model that goes out, with a task that makes it go out.
  const spawn = async (parent: string, task: string, budget?: unknown) => {
    await api(`/api/sessions/${parent}/messages`, { text: `script:calls ${JSON.stringify([{ name: "spawn_agent", input: { message: task, model: OUT, background: true, ...(budget ? { budget } : {}) } }])}` });
    const agent = async () => (await api(`/api/sessions/${parent}/agents`)).agents[0];
    await expect.poll(async () => (await agent())?.session_id, { timeout: 30_000 }).toBeTruthy();
    return { agent, child: (await agent()).session_id as string };
  };
  // What the parent has been told, as one text.
  const heard = async (parent: string) => (await events(parent)).filter((e) => e.kind === "user").map((e) => String(e.data.text ?? "")).join("\n");
  return { d, call, api, events, ended, open, why, spawn, heard, stop: async () => { d.proc.kill("SIGKILL"); await exited(d.proc); } };
}

test("an agent whose provider stays out past the owner's rule goes on on another provider; the owner's own session waits", async ({ page }) => {
  test.setTimeout(240_000);
  const w = await world("outage");
  const { d, api, call, events, ended, open, why, spawn, heard } = w;
  try {
    expect((await api("/api/models")).models.map((m: any) => m.id)).toEqual(expect.arrayContaining([OUT, OTHER]));

    // The rule, made in the page.
    await page.goto(`${d.url}/settings/models`);
    const box = page.getByTestId("route-change");
    await expect(box).toBeVisible();
    await expect(box.getByTestId("route-rule")).toHaveCount(0);
    await expect(box.getByTestId("route-rule-add")).toBeDisabled();
    await expect(box.getByTestId("route-rule-hint")).toHaveText("Choose the model the agents resume on.");
    await box.getByTestId("route-rule-minutes").fill(String(MINUTES));
    await box.getByRole("radio", { name: "Scripted (test)", exact: true }).click();
    await box.getByTestId("model-picker").click();
    await page.getByTestId("model-popup").locator(`[data-testid="model-option"][data-model="${OTHER}"]`).first().click();
    await expect(box.getByTestId("route-rule-hint")).toContainText("Any agent on");
    await shoot(page, "route-change-01-form");
    // Its own provider is no way out of it.
    await box.getByRole("radio", { name: "Scripted second (test)", exact: true }).click();
    await expect(box.getByTestId("route-rule-add")).toBeDisabled();
    await expect(box.getByTestId("route-rule-hint")).toContainText("another provider");
    await box.getByRole("radio", { name: "Scripted (test)", exact: true }).click();
    await box.getByTestId("route-rule-add").click();
    await expect(box.getByTestId("route-rule")).toHaveCount(1);
    await expect(box.getByTestId("route-rule")).toContainText("Any agent");
    expect((await api("/api/settings")).settings.route_change.rules).toEqual([{ role: "", minutes: MINUTES, to: OTHER, from: "scripted" }]);
    await shoot(page, "route-change-02-rule");
    // On a phone the rule's row keeps its arrow with the model, and its remove button on the row.
    await page.setViewportSize({ width: 390, height: 844 });
    await box.getByTestId("route-rule").scrollIntoViewIfNeeded();
    await expect(box.getByTestId("route-rule")).toBeVisible();
    const row = (await box.getByTestId("route-rule").boundingBox())!;
    const cut = (await box.getByTestId("route-rule").getByRole("button").boundingBox())!;
    expect(cut.x + cut.width).toBeLessThanOrEqual(row.x + row.width + 1);
    expect(cut.y).toBeLessThan(row.y + 40);
    await shoot(page, "route-change-02b-rule-phone");
    await page.setViewportSize({ width: 1920, height: 1040 });
    // A rule that names no model is refused by the daemon too.
    expect((await call("/api/settings", { route_change: { rules: [{ role: "", minutes: 5, to: "nomodel" }] } }, "PATCH")).status).toBe(400);

    // The parent works on the provider that stays up; its agent starts on the one that goes out.
    const parent = await open(OTHER, "Route change: parent");
    const t0 = Date.now();
    const { agent, child } = await spawn(parent, "Look around and report.\nscript:outage dns 90000 on scripted");
    // It waits in the outage, as every session of the provider does.
    await expect.poll(() => why(child), { timeout: 30_000 }).toBe("unreachable");

    // A session of the owner's on the same provider, asked while it is out.
    const own = await open(OUT, "Route change: the owner's own session");
    await api(`/api/sessions/${own}/messages`, { text: "Say hello." });
    await expect.poll(() => why(own), { timeout: 30_000 }).toBe("unreachable");

    // The rule's time passes: the agent goes on on the other provider and finishes.
    await expect.poll(async () => (await agent())?.status, { timeout: 90_000 }).toBe("completed");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(MINUTES * 60_000 - 1_000);
    expect((await agent()).model).toBe(OTHER);
    const own1 = await events(child);
    const notes = own1.filter((e) => e.kind === "note" && e.data.route_change);
    expect(notes).toHaveLength(1);
    expect(notes[0].data).toMatchObject({ why: "outage", from: OUT, to: OTHER });
    expect(notes[0].data.text).toContain("could not be reached for");
    expect((await api(`/api/sessions/${child}`)).session.model).toBe(OTHER);
    expect(own1.some((e) => e.kind === "assistant" && e.data.model === OTHER)).toBe(true);
    expect(own1.some((e) => e.kind === "assistant" && e.data.model === OUT)).toBe(false);
    // The parent heard it once, on the line that carries the agent's report.
    await expect.poll(() => heard(parent), { timeout: 30_000 }).toContain("By the owner's rule, Keel moved it to");
    expect((await heard(parent)).match(/By the owner's rule, Keel moved it to/g)).toHaveLength(1);
    expect(await heard(parent)).toContain(`moved it to ${OTHER}`);

    // The owner's own session is still waiting, with the provider out.
    expect(await why(own)).toBe("unreachable");
    expect(await ended(own)).toBe(false);
    await page.goto(`${d.url}/s/${child}`);
    await expect(page.getByText("By the owner's rule for a route that is out").first()).toBeVisible();
    await shoot(page, "route-change-03-agent-moved");
    await page.goto(`${d.url}/s/${own}`);
    await expect(page.getByTestId("provider-wait")).toContainText("The provider cannot be reached since");
    await shoot(page, "route-change-04-owner-waits");

    // The provider is back: the owner's session goes on by itself, on its own model.
    const back = await open(OUT, "Route change: provider back");
    await api(`/api/sessions/${back}/messages`, { text: "script:outage-end" });
    await expect.poll(() => ended(own), { timeout: 90_000 }).toBe(true);
    expect((await events(own)).some((e) => e.kind === "assistant" && e.data.model === OUT)).toBe(true);
    expect((await api(`/api/sessions/${own}`)).session.model).toBe(OUT);
    // The agent never went back.
    expect((await api(`/api/sessions/${child}`)).session.model).toBe(OTHER);
  } finally {
    await w.stop();
  }
});

// The same for a model that answers overloaded: the rule's time counts from its first overloaded
// answer, and the agent's tries are not spaced past it. A rule for another type of agent does not hold.
test("an agent whose model stays overloaded past the owner's rule goes on on another provider; the owner's session keeps trying", async () => {
  test.setTimeout(240_000);
  const w = await world("overloaded");
  const { api, events, ended, open, spawn, heard } = w;
  try {
    expect((await w.call("/api/settings", { route_change: { rules: [
      { role: "Explore", minutes: 0.05, to: OTHER },
      { role: "general-purpose", minutes: MINUTES, to: OTHER, from: "scripted" },
    ] } }, "PATCH")).status).toBe(200);
    const parent = await open(OTHER, "Route change: overloaded parent");
    const t0 = Date.now();
    const { agent, child } = await spawn(parent, "Look around and report.\nscript:overloaded 40000 on scripted");
    const own = await open(OUT, "Route change: overloaded owner session");
    await api(`/api/sessions/${own}/messages`, { text: "Say hello." });
    await expect.poll(async () => (await agent())?.status, { timeout: 90_000 }).toBe("completed");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(MINUTES * 60_000 - 1_000);
    expect((await agent()).model).toBe(OTHER);
    const notes = (await events(child)).filter((e) => e.kind === "note" && e.data.route_change);
    expect(notes).toHaveLength(1);
    expect(notes[0].data).toMatchObject({ why: "overloaded", from: OUT, to: OTHER });
    expect(notes[0].data.text).toContain("answered that it is overloaded for");
    await expect.poll(() => heard(parent), { timeout: 30_000 }).toContain("answered that it is overloaded for");
    // The owner's own session is trying still: no end, no error.
    expect(await ended(own)).toBe(false);
    expect((await events(own)).some((e) => e.kind === "error")).toBe(false);
    // It goes on by itself when the model has room again, on its own model.
    await expect.poll(() => ended(own), { timeout: 120_000 }).toBe(true);
    expect((await api(`/api/sessions/${own}`)).session.model).toBe(OUT);
  } finally {
    await w.stop();
  }
});

// A dollar budget counts spend from listed prices: on a model with no listed price it would never be
// reached. The rule does not move an agent that holds one to such a model; the agent keeps waiting, the
// reason is said once in its failures, and it finishes on its own model when the provider is back.
test("the rule does not move an agent whose dollar budget could not be counted on the target; it keeps waiting", async () => {
  test.setTimeout(240_000);
  const w = await world("budget");
  const { api, call, events, open, why, spawn } = w;
  try {
    const plain = "scripted-b:cheap-plain";
    const lister = await open(OTHER, "Route change: lister");
    await api(`/api/sessions/${lister}/messages`, { text: "script:list-model cheap-plain" });
    await expect.poll(async () => (await api("/api/models?refresh=1")).models.some((m: any) => m.id === plain), { timeout: 30_000 }).toBe(true);
    expect((await call("/api/settings", { route_change: { rules: [{ role: "", minutes: MINUTES, to: plain }] } }, "PATCH")).status).toBe(200);
    const parent = await open(OTHER, "Route change: budget parent");
    const { agent, child } = await spawn(parent, "Look around and report.\nscript:outage dns 25000 on scripted", { usd: 5 });
    await expect.poll(() => why(child), { timeout: 30_000 }).toBe("unreachable");
    // Past the rule's time it is told why not, once, and still waits on its own model.
    await expect.poll(async () => JSON.stringify((await api("/api/errors")).errors ?? []), { timeout: 60_000 }).toContain("was not applied: budget.usd cannot be counted on");
    expect(await why(child)).toBe("unreachable");
    expect((await api(`/api/sessions/${child}`)).session.model).toBe(OUT);
    // The provider comes back: it finishes where it was.
    await expect.poll(async () => (await agent())?.status, { timeout: 90_000 }).toBe("completed");
    expect((await agent()).model).toBe(OUT);
    expect((await events(child)).some((e) => e.kind === "note" && e.data.route_change)).toBe(false);
    expect((JSON.stringify((await api("/api/errors")).errors).match(/was not applied: budget\.usd/g) ?? []).length).toBeGreaterThan(0);
  } finally {
    await w.stop();
  }
});

import { expect, test } from "./isolate.ts";
import { shoot } from "./shots.ts";

// Feature: a message to an agent that has finished starts its new work in
// the cheapest context that still holds the work. An agent reads three long
// command outputs and reports; its parent sends it a follow-up after the
// cache of that context lapsed (the scripted stand-in keeps none), so going
// on would write the whole context again: the agent starts fresh from a
// capsule of its work instead (its task and messages verbatim, its report,
// the trail of its files and commands), with the same id, session and place.
// Its card and both timelines say which start was taken and why, and the
// owner can choose another for the next follow-ups.
const MODEL = "scripted:stand-in-strict";
const calls = (list: unknown[]) => `script:calls ${JSON.stringify(list)}`;
// Twenty kilobytes of a command's output (under the spill line: it stays in the context).
const print = (n: number) => ({ name: "Bash", input: { command: `head -c ${n} /dev/zero | tr '\\0' 'a' | fold -w 100` } });

test("a follow-up to a finished agent at a large context starts from a capsule, and its card says so", async ({ page, request }) => {
  test.setTimeout(150_000);
  const api = async (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") => (await request.fetch(path, { method, ...(body === undefined ? {} : { data: body }) })).json();
  const { session } = await api("/api/sessions", { model: MODEL, title: "Follow-up starts" });
  await api(`/api/sessions/${session.id}/permissions`, { mode: "full-auto" }, "PUT");
  const worker = `Reader of three logs\n${calls([print(20_000), print(20_000), print(20_000)])}`;
  await api(`/api/sessions/${session.id}/messages`, { text: calls([{ name: "spawn_agent", input: { message: worker, isolation: "none" } }]) });
  const agent = async () => (await api(`/api/sessions/${session.id}/agents`)).agents[0];
  await expect.poll(async () => (await agent())?.status, { timeout: 60_000 }).toBe("completed");
  const idle = async (id: string) => { const d = await api(`/api/sessions/${id}`); return !d.running && d.events.at(-1)?.kind === "turn_end"; };
  await expect.poll(() => idle(session.id), { timeout: 30_000 }).toBe(true);
  const first = await agent();
  expect(first.start ?? null).toBeNull();

  // The parent's follow-up.
  await api(`/api/sessions/${session.id}/messages`, { text: calls([{ name: "send_input", input: { target: first.id, message: "One more check on the third log, then report. script:say The third log holds only the letter a." } }]) });
  await expect.poll(async () => { const a = await agent(); return a.tasks === 1 && a.status === "completed"; }, { timeout: 60_000 }).toBe(true);
  const a = await agent();
  expect(a.id).toBe(first.id);
  expect(a.session_id).toBe(first.session_id);
  expect(a.start).toMatchObject({ way: "capsule", task: 1 });
  expect(a.start.why).toContain("cache lapsed");
  expect(a.start.costs.capsule).toBeLessThan(a.start.costs.carry);

  // The new work's first request read the capsule, not the whole earlier context.
  const evs = (await api(`/api/sessions/${a.session_id}`)).events as any[];
  const cut = evs.findIndex((e) => e.kind === "compaction" && e.data.capsule);
  expect(cut).toBeGreaterThan(0);
  expect(evs[cut].data).toMatchObject({ trigger: "follow_up", mode: "summary" });
  expect(evs[cut].data.other_messages.join("\n")).toContain("Reader of three logs");
  const next = evs.slice(cut).find((e) => e.kind === "assistant").data.usage;
  const read = next.input + next.cache_read + next.cache_write;
  expect(read).toBeLessThan(a.start.used / 2);
  // The tool result that told the parent says it too.
  const parent = (await api(`/api/sessions/${session.id}`)).events as any[];
  const told = parent.filter((e) => e.kind === "tool_result").flatMap((e) => e.data.results).map((r: any) => (typeof r.content === "string" ? r.content : JSON.stringify(r.content))).join("\n");
  expect(told).toContain('"start":"capsule"');

  // Both timelines say which start was taken.
  const rows = async (id: string) => ((await api(`/api/sessions/${id}/timeline`)).rows as any[]).map((r) => r.text).join("\n");
  expect(await rows(a.session_id)).toContain("took up new work: started fresh from a capsule of its work");
  expect(await rows(a.session_id)).toContain("Context replaced by a capsule");
  expect(await rows(session.id)).toContain("took up new work: started fresh from a capsule");

  // The card: a chip on its line, and why when it is opened.
  await page.setViewportSize({ width: 1920, height: 1040 });
  await page.goto(`/s/${session.id}`);
  const card = page.getByTestId("agent-call").first();
  await expect(card.getByTestId("agent-call-start")).toHaveText("fresh start");
  await expect(card.getByTestId("agent-call-start")).toHaveAttribute("title", /capsule of its work/);
  await shoot(page, "follow-up-01-card");
  await card.locator("button.k-line").first().click();
  await expect(card.getByTestId("agent-start-why")).toContainText("Started fresh from a capsule of its work");
  await expect(card.getByTestId("agent-start-auto")).toHaveAttribute("aria-checked", "true");
  await card.getByTestId("agent-start-why").scrollIntoViewIfNeeded();
  await shoot(page, "follow-up-02-why");

  // The owner chooses: the next follow-up goes on in its context.
  await card.getByTestId("agent-start-carry").click();
  await expect.poll(async () => (await agent()).start_force).toBe("carry");
  await expect(card.getByTestId("agent-start-carry")).toHaveAttribute("aria-checked", "true");
  await api(`/api/sessions/${session.id}/messages`, { text: calls([{ name: "send_input", input: { target: a.id, message: "And the first log? script:say The first log holds only the letter a." } }]) });
  await expect.poll(async () => { const x = await agent(); return x.tasks === 2 && x.status === "completed"; }, { timeout: 60_000 }).toBe(true);
  expect((await agent()).start).toMatchObject({ way: "carry", forced: true, task: 2 });
  await expect(card.getByTestId("agent-start-why")).toContainText("The owner chose");
  await expect(card.getByTestId("agent-call-start")).toHaveCount(0);
  await card.getByTestId("agent-follow-ups").scrollIntoViewIfNeeded();
  await shoot(page, "follow-up-03-chosen");
  await card.getByTestId("agent-start-auto").click();
  await expect.poll(async () => (await agent()).start_force ?? null).toBeNull();
});

import { expect, test } from "./isolate.ts";
import { shoot } from "./shots.ts";

// Feature: one line per provider account in front of every model request
// (src/providers/admission.ts). An account that answers 429 is learned once:
// the requests its other sessions and agents send meanwhile wait in the line
// instead of being refused one by one, each says so in its session's state,
// and when the wait is over the owner's own turn goes first, then the agents.
// The scripted provider plays the account: `script:account-limit <ms>` makes
// the account of the model spent for that long (every request on it meanwhile
// is answered 429 with retry-after), and each reply after it says its place
// and how many requests the account refused.
const PARENT = "scripted:stand-in";
// A stand-in with an account of its own (src/providers/scripted.ts accountOf): the parent's steps are not on it.
const LIMITED = "scripted:claude-stand-in";

test("an account's 429 holds its other requests in one line, and the owner's turn goes first", async ({ page, request }) => {
  test.setTimeout(120_000);
  const { models } = await (await request.get("/api/models")).json();
  test.skip(!models.some((m: { id: string }) => m.id === LIMITED), "requires the scripted provider");
  // Two parents: agents a parent starts together on one model start one after another (the first warms
  // the prompt cache for the rest: src/automation/agents.ts stagger), so each agent here has its own.
  const parent = async (title: string) => (await (await request.post("/api/sessions", { data: { model: PARENT, title } })).json()).session as { id: string };
  const parents = [await parent("Account line 1"), await parent("Account line 2")];
  let own: { id: string } | undefined;
  type A = { id: string; session_id: string; title: string; status: string };
  const agents = async () => (await Promise.all(parents.map(async (p) => ((await (await request.get(`/api/sessions/${p.id}/agents`)).json()).agents as A[])))).flat();
  const events = async (id: string) => ((await (await request.get(`/api/sessions/${id}`)).json()).events as any[]);
  const said = (evs: any[]) => evs.filter((e) => e.kind === "assistant").at(-1)?.data.blocks.find((b: any) => b.type === "text")?.text as string | undefined;
  const held = async () => ((await (await request.get("/api/limits")).json()).held ?? []) as { account: string; waiting: number; until?: number }[];
  const run = async (at: { id: string }, calls: unknown[]) => {
    const text = `script:batch ${JSON.stringify(calls)}`;
    expect((await request.post(`/api/sessions/${at.id}/messages`, { data: { text } })).ok()).toBe(true);
    await expect.poll(async () => {
      const evs = await events(at.id);
      const i = evs.findLastIndex((e) => e.kind === "user" && e.data.text === text);
      return evs.slice(i + 1).filter((e) => e.kind === "tool_result").flatMap((e) => e.data.results).length;
    }, { timeout: 30_000 }).toBe(calls.length);
  };
  const agent = (title: string, words: string) => ({ name: "spawn_agent", input: { message: `${title}\n${words}`, model: LIMITED, isolation: "none" } });
  try {
    for (const p of parents) await request.put(`/api/sessions/${p.id}/permissions`, { data: { mode: "full-auto" } });
    // An agent's request is answered 429: the account is held, by what it said.
    await run(parents[0]!, [agent("Limited", "script:account-limit 20000")]);
    await expect.poll(async () => (await held()).find((h) => h.account === LIMITED)?.until ?? 0, { timeout: 15_000 }).toBeGreaterThan(Date.now());
    // Another agent asks meanwhile: it waits in the line, not refused.
    await run(parents[1]!, [agent("Waiting", "script:account-wait")]);
    // The owner's own session on the same account, open in the page.
    ({ session: own } = await (await request.post("/api/sessions", { data: { model: LIMITED, title: "The owner's turn" } })).json());
    await page.goto(`/s/${own!.id}`);
    expect((await request.post(`/api/sessions/${own!.id}/messages`, { data: { text: "script:account-wait" } })).ok()).toBe(true);
    await expect(page.getByTestId("working-what")).toHaveText(/^Waits for the account's limit, about \d+s$/, { timeout: 10_000 });
    await expect.poll(async () => (await held()).find((h) => h.account === LIMITED)?.waiting ?? 0, { timeout: 10_000 }).toBeGreaterThanOrEqual(3);
    await shoot(page, "account-limit-held");

    // The wait ends: the owner's turn first, then the agents in the order they asked; the account refused one request in all.
    await expect.poll(async () => said(await events(own!.id)), { timeout: 60_000 }).toBe("Answered in place 1 after the account's limit; it refused 1 request.");
    await expect.poll(async () => (await agents()).filter((a) => a.status === "completed").length, { timeout: 40_000 }).toBe(2);
    const byTitle = async (t: string) => said(await events((await agents()).find((a) => a.title.startsWith(t))!.session_id));
    expect(await byTitle("Limited")).toBe("Answered in place 2 after the account's limit; it refused 1 request.");
    expect(await byTitle("Waiting")).toBe("Answered in place 3 after the account's limit; it refused 1 request.");
    await expect(page.getByTestId("working-what")).toHaveCount(0);
    await shoot(page, "account-limit-answered");
  } finally {
    for (const p of parents) await request.delete(`/api/sessions/${p.id}`);
    if (own) await request.delete(`/api/sessions/${own.id}`);
  }
});

import { expect, test } from "./isolate.ts";
import { shoot } from "./shots.ts";

// Feature: a session is told what went wrong around it without asking. Agents
// that failed on one cause, with no words of their own, reach their parent as
// one entry of one notice (each listed by id), not as a report each; a tool
// failure an agent repeated is one line with its count; the same grouped
// record is readable over HTTP; a failure a wait already returned is not told
// again.
const STAND_IN = "scripted:stand-in";
const spawn = (message: string) => ({ name: "spawn_agent", input: { message, isolation: "none" } });
const failing = (n: number) => Array.from({ length: n }, (_, i) => spawn(`Lane ${i + 1}\nscript:billing`));

async function start(request: any, title: string, calls: unknown[]) {
  const models = (await (await request.get("/api/models")).json()).models as { id: string }[];
  test.skip(!models.some((m) => m.id === STAND_IN), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const { session } = await (await request.post("/api/sessions", { data: { model: STAND_IN, title } })).json();
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto" } });
  await request.post(`/api/sessions/${session.id}/messages`, { data: { text: `script:calls ${JSON.stringify(calls)}` } });
  return session.id as string;
}

// The session's events once every agent ended and nothing more comes.
async function settled(request: any, id: string, agents: number) {
  const view = () => request.get(`/api/sessions/${id}`).then((r: any) => r.json());
  await expect.poll(async () => {
    const list = (await (await request.get(`/api/sessions/${id}/agents`)).json()).agents as any[];
    const v = await view();
    return list.length === agents && list.every((a) => !["running", "waiting"].includes(a.status)) && !v.running && v.events.at(-1)?.kind === "turn_end" && !v.queue?.length;
  }, { timeout: 90_000 }).toBe(true);
  await new Promise((r) => setTimeout(r, 1500)); // an input held back for the turn's end has started its turn by now
  await expect.poll(async () => { const v = await view(); return !v.running && v.events.at(-1)?.kind === "turn_end"; }, { timeout: 60_000 }).toBe(true);
  return (await view()).events as any[];
}

test("agents that failed on one cause reach their parent as one grouped notice", async ({ page, request }) => {
  const missing = { name: "Read", input: { file_path: "/nonexistent/keel-failure-digest.txt" } };
  // The parent stays in its turn while its agents end, so everything goes with that turn's end.
  const id = await start(request, "Failure digest", [
    ...failing(5), spawn(`Probe\nscript:calls ${JSON.stringify([missing, missing, missing])}`), spawn("Fine helper\nscript:calls []"),
    { name: "Bash", input: { command: "sleep 5; echo slept" } },
  ]);
  try {
    const events = await settled(request, id, 7);
    const inputs = events.filter((e) => e.kind === "user" && e.data.kind);
    const text = inputs.map((e) => String(e.data.text)).join("\n\n");
    const lanes = ((await (await request.get(`/api/sessions/${id}/agents`)).json()).agents as any[]).filter((a) => a.title.startsWith("Lane"));
    expect(lanes.map((a) => a.status)).toEqual(Array(5).fill("failed"));

    // One notice, one entry for the five, the error said once, every agent by id.
    expect(text.match(/<failures>/g)).toHaveLength(1);
    expect(text).toContain("5 agents failed on one cause (quota), with no report of their own:");
    expect(text.match(/your credit balance is too low/g)).toHaveLength(1);
    for (const a of lanes) expect(text.split(a.id).length - 1).toBe(1);
    // The five have no report of their own; the two that worked do.
    expect(text).not.toContain('status="failed"');
    expect(text.match(/<subagent_result /g)).toHaveLength(2);
    // The agent's repeated tool failure: one line with its count.
    expect(text).toMatch(/Read failed 3 times on one cause, in agent \w+ "Probe"/);
    // It came in at one turn boundary: the parent ran its own turn and one more.
    expect(inputs).toHaveLength(1);
    expect(events.filter((e) => e.kind === "turn_start")).toHaveLength(2);

    // The owner's side: the same groups over HTTP, told and counted.
    const record = (await (await request.get(`/api/errors?session=${id}`)).json()).failures as any[];
    const group = record.find((g) => g.kind === "agent");
    expect([group.cls, group.count, group.owed, group.told]).toEqual(["quota", 5, 0, 5]);
    expect(group.refs.map((r: any) => r.id).sort()).toEqual(lanes.map((a) => a.id).sort());
    expect(record.find((g) => g.kind === "tool" && g.cls === "Read")?.count).toBe(3);
    expect(record.find((g) => g.kind === "provider")?.count).toBe(5);
    // An agent's own page reads the part of the record that names it.
    const one = (await (await request.get(`/api/errors?session=${lanes[0].session_id}`)).json()).failures as any[];
    expect(one.map((g) => g.kind).sort()).toEqual(["agent", "provider"]);

    await page.goto(`/s/${id}`);
    const card = page.getByTestId("failure-notice");
    await expect(card).toHaveCount(1);
    await expect(card).toContainText("Failures, grouped by cause");
    await expect(page.getByTestId("failure-entries")).toContainText("5 agents failed on one cause (quota)");
    await expect(page.getByTestId("agent-report")).toHaveCount(2);
    await card.scrollIntoViewIfNeeded();
    await shoot(page, "failure-digest-01-notice");
  } finally {
    await request.delete(`/api/sessions/${id}`);
  }
});

test("failures a wait already returned are not told again", async ({ request }) => {
  const id = await start(request, "Failure digest, waited", [...failing(2), { name: "Bash", input: { command: "sleep 3; echo slept" } }, { name: "wait_agent", input: { targets: ["Lane 1", "Lane 2"], timeout_ms: 5000 } }]);
  try {
    const events = await settled(request, id, 2);
    const waited = events.filter((e) => e.kind === "tool_result").flatMap((e) => e.data.results).map((r: any) => String(r.content)).find((c) => c.includes('"status"'));
    expect(waited).toContain("errored");
    expect(events.filter((e) => e.kind === "user" && e.data.kind)).toHaveLength(0);
    expect(events.filter((e) => e.kind === "turn_start")).toHaveLength(1);
    const group = ((await (await request.get(`/api/errors?session=${id}`)).json()).failures as any[]).find((g) => g.kind === "agent");
    expect([group.count, group.owed]).toEqual([2, 0]);
  } finally {
    await request.delete(`/api/sessions/${id}`);
  }
});

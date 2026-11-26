import { expect, test } from "./isolate.ts";
import { shoot } from "./shots.ts";

// Feature: a session is told what went wrong around it without asking. Agents
// that failed on one cause, with no words of their own, reach their parent as
// one entry of one notice (each listed by id), not as a report each; a tool
// failure an agent repeated is one entry while that agent still works, with
// that agent's own count and its own latest failure, whoever else ran into the
// same cause; the same grouped record is readable over HTTP; a failure a wait
// already returned is not told again.
const STAND_IN = "scripted:stand-in";
// What a line says of time, when the run is slow enough for it to show: the span of an agent's failures, how long ago the last was.
const WHEN = "(?: in \\d+ min)?(?:, last \\d+ min ago)?";
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
  // The parent stays in its turn while five agents fail and one works, so those go with that
  // turn's end. Probe misses a file three times and then keeps working past it.
  const pause = (seconds: number, word: string) => ({ name: "Bash", input: { command: `sleep ${seconds}; echo ${word}` } });
  const id = await start(request, "Failure digest", [
    ...failing(5), spawn(`Probe\nscript:calls ${JSON.stringify([missing, missing, missing, pause(12, "probed")])}`), spawn("Fine helper\nscript:calls []"),
    pause(5, "slept"),
  ]);
  try {
    const events = await settled(request, id, 7);
    const inputs = events.filter((e) => e.kind === "user" && e.data.kind);
    const text = inputs.map((e) => String(e.data.text)).join("\n\n");
    const lanes = ((await (await request.get(`/api/sessions/${id}/agents`)).json()).agents as any[]).filter((a) => a.title.startsWith("Lane"));
    expect(lanes.map((a) => a.status)).toEqual(Array(5).fill("failed"));

    // One notice, one entry for the five, the error said once, every agent by id.
    expect(text.match(/<failures>/g)).toHaveLength(1);
    expect(text).toContain("5 agents failed on one cause (billing), with no report of their own\n");
    expect(text.match(/your credit balance is too low/g)).toHaveLength(1);
    const said = text.slice(0, text.indexOf("\n</failures>"));
    for (const a of lanes) expect(said.split(a.id).length - 1).toBe(1);
    // The five have no report of their own; the two that worked do.
    expect(text).not.toContain('status="failed"');
    expect(text.match(/<subagent_result /g)).toHaveLength(2);
    // The notice came at one turn boundary, with the report of the agent that had finished,
    // and reads after it. Probe still worked then: its repeated tool failure is one line
    // with its count, and the input says once that an agent still runs.
    expect(inputs).toHaveLength(2);
    const first = String(inputs[0].data.text);
    expect(first).toContain('title="Fine helper"');
    expect(first.indexOf("<failures>")).toBeGreaterThan(first.indexOf("</subagent_result>"));
    expect(first).toMatch(new RegExp(`Read failed 3 times on one cause in 1 agent\\n    \\w+ "Probe", 3 times${WHEN}: File does not exist: /nonexistent/keel-failure-digest\\.txt\\n`));
    expect(first.match(/still running/g) ?? []).toHaveLength(1);
    // Probe's own report came when it finished, with no second notice.
    expect(String(inputs[1].data.text)).toContain('title="Probe"');
    expect(events.filter((e) => e.kind === "turn_start")).toHaveLength(3);

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
    // (A session with agents opens on its conversation; the notice is in the full stream.)
    await page.getByTestId("lens-to-stream").click({ timeout: 60_000 });
    const card = page.getByTestId("failure-notice");
    await expect(card).toHaveCount(1);
    // The notice is one line, as an agent's report is: its glyph says something failed and its words count the
    // causes (one cause is named there instead). What the model was told opens on a press.
    await card.scrollIntoViewIfNeeded();
    await expect(card.locator(".k-heard-line")).toHaveText(/^Failures\s*8 failures, 2 causes$/);
    await expect(page.getByTestId("failure-entries")).toHaveCount(0);
    expect((await card.boundingBox())!.height).toBeLessThanOrEqual(32);
    await shoot(page, "failure-digest-00-notice-line");
    await card.locator(".k-heard-line").click();
    await expect(page.getByTestId("failure-entries")).toContainText("5 agents failed on one cause (billing)");
    await expect(page.getByTestId("agent-report")).toHaveCount(2);
    await shoot(page, "failure-digest-01-notice");
  } finally {
    await request.delete(`/api/sessions/${id}`);
  }
});

// One cause (a file that is not there) in the session's own call and in three agents, each on
// another path. Only the agent that repeated it is named, with its own path and count; the
// count over all of them says whose it is; its timeline says what failed while it still works.
test("an agent that repeated a shared cause is told with its own failure, not the first one of the cause", async ({ page, request }) => {
  const miss = (path: string) => ({ name: "Read", input: { file_path: path } });
  const pause = (seconds: number, word: string) => ({ name: "Bash", input: { command: `sleep ${seconds}; echo ${word}` } });
  const lane = (title: string, calls: unknown[]) => spawn(`${title}\nscript:calls ${JSON.stringify(calls)}`);
  const id = await start(request, "Failure digest, shared cause", [
    miss("/nonexistent/digest/own/earlier.txt"),
    lane("Early lane", [miss("/nonexistent/digest/early/one.txt")]),
    pause(2, "one"),
    lane("Twice lane", [miss("/nonexistent/digest/twice/b1.txt"), miss("/nonexistent/digest/twice/b2.txt"), pause(12, "twice")]),
    lane("Loop lane", [miss("/nonexistent/digest/loop/c.txt"), miss("/nonexistent/digest/loop/c.txt"), miss("/nonexistent/digest/loop/c.txt"), pause(12, "loop")]),
    pause(4, "two"),
  ]);
  try {
    const noticeOf = async () => ((await (await request.get(`/api/sessions/${id}`)).json()).events as any[]).filter((e) => e.kind === "user" && e.data.kind).map((e) => String(e.data.text)).find((t) => t.includes("<failures>"));
    await expect.poll(noticeOf, { timeout: 60_000 }).toBeTruthy();
    const notice = (await noticeOf())!;
    const agents = (await (await request.get(`/api/sessions/${id}/agents`)).json()).agents as any[];
    const loop = agents.find((a) => a.title.startsWith("Loop"));
    const entries = notice.slice(notice.indexOf("<failures>\n") + 11, notice.indexOf("\n</failures>")).split("\n");
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatch(/^- Read failed 3 times on one cause in 1 agent; 7 by this session and all its agents (in the last minute|over the last \d+ min)$/);
    expect(entries[1]).toMatch(new RegExp(`^    ${loop.id} "Loop lane", 3 times${WHEN}: File does not exist: /nonexistent/digest/loop/c\\.txt$`));
    expect(notice).toContain(`\nkeel__session_timeline with session: ${loop.id} tells what that agent did and where it failed.`);
    // The agent still works: its running turn says what failed in it.
    const timeline = await (await request.get(`/api/sessions/${loop.session_id}/timeline?only=failures&since=40m&format=text`)).text();
    expect(timeline).toMatch(/Running a turn started by its parent's task: step \d+, 3 failed tools so far, running Bash/);

    const events = await settled(request, id, 3);
    expect(events.filter((e) => e.kind === "user" && e.data.kind).map((e) => String(e.data.text)).join("\n").match(/<failures>/g)).toHaveLength(1);
    // The record: one cause, each of the four with its own count and its own latest failure.
    const group = ((await (await request.get(`/api/errors?session=${id}`)).json()).failures as any[]).find((g) => g.kind === "tool" && g.cls === "Read");
    expect([group.count, group.owed, group.sample.split("\n")[0]]).toEqual([7, 0, "File does not exist: /nonexistent/digest/own/earlier.txt"]);
    expect(group.refs.map((r: any) => [r.label ?? r.id, r.n, r.eg])).toEqual([
      ["self", 1, "File does not exist: /nonexistent/digest/own/earlier.txt"], ["Early lane", 1, "File does not exist: /nonexistent/digest/early/one.txt"],
      ["Twice lane", 2, "File does not exist: /nonexistent/digest/twice/b2.txt"], ["Loop lane", 3, "File does not exist: /nonexistent/digest/loop/c.txt"],
    ]);

    await page.goto(`/s/${id}`);
    await page.getByTestId("lens-to-stream").click({ timeout: 60_000 });
    const card = page.getByTestId("failure-notice");
    await card.scrollIntoViewIfNeeded();
    await card.locator(".k-heard-line").click();
    await expect(page.getByTestId("failure-entries")).toContainText(entries[1]!.trim());
    await shoot(page, "failure-digest-02-own-failure");
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

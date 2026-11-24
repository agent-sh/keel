import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import { expect, test, type APIRequestContext } from "./isolate.ts";
import { calls, folder, idle, MODEL, scripted } from "./answering.ts";
import { scriptBash, shoot } from "./shots.ts";

// Feature: lessons from repeated failures (src/automation/lessons.ts). Three
// sessions of one repository fail the same way; the miner proposes a lesson
// with that evidence in Settings > Lessons, drafted by the small model; the
// owner edits and accepts it, which starts its trial; the repository's next
// agents are drawn into the trial's arms at their start, and the ones in the
// lesson's arm start with it in their task (never in a system prompt), the
// others without it.
const repo = (name: string) => {
  const dir = folder(name);
  execFileSync("git", ["init", "-q", dir]);
  return dir;
};
type Lesson = { id: string; repo: string; state: string; text: string; exp_id: string | null; given: number; evidence: { trees: number; failures: number } };
const lessonOf = async (request: APIRequestContext, dir: string) =>
  ((await (await request.get("/api/lessons")).json()).lessons as Lesson[]).find((l) => basename(l.repo) === basename(dir));
const taskOf = async (request: APIRequestContext, session: string) => {
  const { events } = await (await request.get(`/api/sessions/${session}`)).json();
  return String((events as any[]).find((e) => e.kind === "user")?.data.text ?? "");
};

test("a failure in three sessions of a repository is proposed as a lesson, accepted, and its next agents start with it by their trial's arm", async ({ page, request }) => {
  await scripted(request);
  const here = repo("lessons-here");
  const create = async (title: string) => {
    const { session } = await (await request.post("/api/sessions", { data: { model: MODEL, title, workspace: here } })).json();
    await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto" } });
    return session.id as string;
  };
  let lesson: Lesson | undefined;
  try {
    // Three sessions run a command that fails the same way, each on a file of its own.
    for (const i of [1, 2, 3]) {
      const id = await create(`Lister ${i}`);
      await request.post(`/api/sessions/${id}/messages`, { data: { text: scriptBash(`ls ./missing-input-${i}.txt`) } });
      await idle(request, id);
    }

    // The miner reads them as one cause in three trees; the small model drafts its note.
    await page.goto("/settings/lessons");
    await expect(page.getByTestId("lessons")).toBeVisible();
    await expect.poll(async () => {
      await request.post("/api/lessons/mine");
      return (lesson = await lessonOf(request, here))?.state;
    }, { timeout: 30_000 }).toBe("proposed");
    const card = page.locator(`[data-testid="lesson-proposal"][data-lesson="${lesson!.id}"]`);
    await expect(card).toBeVisible();
    await expect(card.getByTestId("lesson-counts")).toHaveText("3 failures in 3 agent trees, 3 sessions");
    await expect(card.getByTestId("lesson-text")).toHaveValue(/^Before you run a command here, check it cannot fail like this: ls: cannot access/);
    await card.scrollIntoViewIfNeeded();
    await shoot(page, "lessons-01-proposed");

    // The owner says it in his own words and accepts it: no other live experiment runs, so its trial starts.
    const words = "List a file with test -e before you read it: these inputs are made by the build, not kept in the repository.";
    await card.getByTestId("lesson-text").fill(words);
    await card.getByTestId("lesson-accept").click();
    const live = page.locator(`[data-testid="lesson-live"][data-lesson="${lesson!.id}"]`);
    await expect(live).toHaveAttribute("data-state", "trial");
    await expect(live.getByTestId("lesson-words")).toHaveText(words);
    await expect(live.getByTestId("lesson-line")).toContainText(`half of the new agent trees of ${basename(here)} are told it`);
    lesson = await lessonOf(request, here);
    const { experiment } = await (await request.get(`/api/experiments/${lesson!.exp_id}`)).json();
    expect(experiment).toMatchObject({ state: "running", template: "lesson", unit: "agent", repo: lesson!.repo, lesson: lesson!.id, primary: "lesson_class" });

    // The repository's next agents: each drawn at its start, the lesson in the task of the ones in its arm only.
    const lead = await create("Lesson lead");
    const seen: Record<string, string[]> = { "with lesson": [], without: [] };
    for (let i = 0; i < 24 && (!seen["with lesson"]!.length || !seen.without!.length); i++) {
      await request.post(`/api/sessions/${lead}/messages`, { data: { text: calls([{ name: "spawn_agent", input: { message: `Lesson reader ${i}\nscript:say done`, isolation: "none" } }]) } });
      await idle(request, lead);
      const { agents } = await (await request.get(`/api/sessions/${lead}/agents`)).json();
      const a = (agents as { session_id: string; title: string }[]).find((x) => x.title === `Lesson reader ${i}`)!;
      const task = await taskOf(request, a.session_id);
      const arm = task.includes("Lessons of this repository") ? "with lesson" : "without";
      seen[arm]!.push(a.session_id);
    }
    expect(seen["with lesson"]!.length).toBeGreaterThan(0);
    expect(seen.without!.length).toBeGreaterThan(0);
    const told = await taskOf(request, seen["with lesson"]![0]!);
    expect(told).toContain(`Lessons of this repository (${basename(here)}), each from a failure that repeated across its agents; the owner accepted them:\n- ${words}`);
    // The lesson is in the task, before the parent's words: the agent's system prompt is the same in both arms.
    expect(told.indexOf(words)).toBeLessThan(told.indexOf("Task:\n"));
    // Each arm's tree is counted by the trial, and the timeline of a told agent's parent says it started with the lesson.
    const counted = (await (await request.get(`/api/experiments/${lesson!.exp_id}`)).json()).experiment.sessions as { arm: string; n: number }[];
    expect(Object.fromEntries(counted.map((c) => [c.arm, c.n]))).toEqual({ "with lesson": seen["with lesson"]!.length, without: seen.without!.length });
    const { rows } = await (await request.get(`/api/sessions/${lead}/timeline`)).json();
    expect((rows as { text: string }[]).some((r) => /^Agent "Lesson reader \d+" started with a lesson of /.test(r.text) && r.text.includes(basename(here)))).toBe(true);

    await page.reload();
    await expect(live.getByTestId("lesson-given")).toHaveText(seen["with lesson"]!.length === 1 ? "Told to 1 agent" : `Told to ${seen["with lesson"]!.length} agents`);
    await live.scrollIntoViewIfNeeded();
    await shoot(page, "lessons-02-in-trial");
    await page.goto(`/s/${seen["with lesson"]![0]}`);
    await expect(page.getByText("done").first()).toBeVisible();
    await shoot(page, "lessons-03-agent-told");

    // Retired, its trial stops and no agent is told it again.
    await page.goto("/settings/lessons");
    await live.getByTestId("lesson-retire").click();
    await expect(page.getByTestId("lessons-dropped")).toBeVisible();
    const after = await lessonOf(request, here);
    expect(after?.state).toBe("dropped");
    expect((await (await request.get(`/api/experiments/${after!.exp_id}`)).json()).experiment.state).toBe("stopped");
  } finally {
    // What the test made of the daemon: its lesson dropped, its trial stopped and removed.
    const l = await lessonOf(request, here).catch(() => undefined);
    if (l && l.state !== "dropped") await request.post(`/api/lessons/${l.id}/drop`);
    if (l?.exp_id) {
      const e = (await (await request.get(`/api/experiments/${l.exp_id}`)).json()).experiment;
      if (e?.state === "running") await request.post(`/api/experiments/${l.exp_id}/stop`, { data: { reason: "the lessons spec ended" } });
      await request.delete(`/api/experiments/${l.exp_id}`);
    }
  }
});

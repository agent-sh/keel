import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import { expect, test, type APIRequestContext } from "./isolate.ts";
import { calls, folder, MODEL, pending, scripted } from "./answering.ts";
import { shoot } from "./shots.ts";

// Feature: standing rulings (src/automation/rulings.ts). The owner answers an
// agent's question and keeps the answer for questions like it in the
// repository; a later agent of that repository that asks the same thing in
// other words is answered from the ruling with no card, which its line and
// its timeline say; an agent of another repository still gets the card. The
// ruling is listed in Settings > Rulings with its use, and revoked there.
const runner = (question: string) => ({
  name: "AskUserQuestion",
  input: { questions: [{ header: "Runner", question, options: [{ label: "bun test", description: "The runtime's own runner" }, { label: "vitest", description: "A separate package" }], multiSelect: false }] },
});
const spawn = (title: string, question: string) => ({ name: "spawn_agent", input: { message: `${title}\n${calls([runner(question)])}`, isolation: "none" } });
const repo = (name: string) => {
  const dir = folder(name);
  execFileSync("git", ["init", "-q", dir]);
  return dir;
};

type Agent = { id: string; session_id: string; status: string; title: string };
async function agentOf(request: APIRequestContext, parent: string, title: string): Promise<Agent> {
  let found: Agent | undefined;
  await expect.poll(async () => {
    const { agents } = await (await request.get(`/api/sessions/${parent}/agents`)).json();
    found = (agents as Agent[]).find((a) => a.title === title);
    return !!found;
  }, { timeout: 30_000 }).toBe(true);
  return found!;
}

test("an answer kept as a ruling answers the same question from later agents of its repository", async ({ page, request }) => {
  await scripted(request);
  const here = repo("rulings-here"), other = repo("rulings-other");
  const create = async (title: string, workspace: string) => {
    const { session } = await (await request.post("/api/sessions", { data: { model: MODEL, title, workspace } })).json();
    await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto" } });
    return session.id as string;
  };
  const send = (id: string, call: unknown) => request.post(`/api/sessions/${id}/messages`, { data: { text: calls([call]) } });
  let kept: string | undefined;
  try {
    // The first agent asks; the owner answers on its card and keeps the answer for the repository.
    const lead = await create("Runner lead", here);
    await send(lead, spawn("Runner asker", "Which test runner?"));
    const first = await agentOf(request, lead, "Runner asker");
    await expect.poll(() => pending(request, first.session_id), { timeout: 30_000 }).toHaveLength(1);
    await page.goto(`/s/${first.session_id}`);
    const card = page.locator('[data-testid="question"][data-state="open"]');
    await card.getByRole("radio", { name: "bun test" }).click();
    await card.getByTestId("question-submit").click();
    const answered = page.locator('[data-testid="question"][data-state="answered"]');
    await expect(answered).toHaveCount(1);
    const offer = answered.getByTestId("ruling-offer");
    await expect(offer).toHaveAttribute("data-state", "open");
    await expect(offer).toContainText(`Keep this for questions like it in ${basename(here)}?`);
    await shoot(page, "rulings-01-offer");
    await offer.getByTestId("ruling-keep").click();
    await expect(offer).toHaveAttribute("data-state", "kept");
    await expect(offer).toHaveText(`Kept for questions like it in ${basename(here)}.`);
    const { rulings } = await (await request.get("/api/rulings")).json();
    kept = rulings.find((r: any) => r.session_id === first.session_id)?.id;
    expect(kept).toBeTruthy();

    // A second agent of the same repository asks in other words: the ruling answers it, with no card.
    await send(lead, spawn("Runner reader", "Which test runner should this repository use?"));
    const second = await agentOf(request, lead, "Runner reader");
    await expect.poll(async () => (await agentOf(request, lead, "Runner reader")).status, { timeout: 60_000 }).toBe("completed");
    expect(await pending(request, second.session_id)).toEqual([]);
    const { events } = await (await request.get(`/api/sessions/${second.session_id}`)).json();
    const result = (events as any[]).flatMap((e) => (e.kind === "tool_result" ? e.data.results : [])).find((r: any) => String(typeof r.content === "string" ? r.content : JSON.stringify(r.content)).includes("standing ruling"));
    const said = typeof result.content === "string" ? result.content : JSON.stringify(result.content);
    expect(said).toContain(`standing ruling ${kept!.slice(-8)}`);
    expect(said).toContain('the owner said "bun test"');
    await page.goto(`/s/${second.session_id}`);
    const ruled = page.locator('[data-testid="question"][data-state="answered"]');
    await expect(ruled.getByTestId("question-ruled")).toHaveText("from your standing ruling");
    await expect(ruled.getByTestId("question-line-answer")).toHaveText("bun test");
    await expect(ruled.getByTestId("ruling-offer")).toHaveCount(0);
    await ruled.locator("button.k-line").click();
    await expect(ruled.getByTestId("question-ruling")).toContainText(`in ${basename(here)}`);
    await shoot(page, "rulings-02-answered-by-ruling");
    // Its timeline says the ruling answered it.
    const { rows } = await (await request.get(`/api/sessions/${second.session_id}/timeline`)).json();
    expect((rows as { text: string }[]).some((r) => r.text.startsWith(`Answered a question from standing ruling ${kept!.slice(-8)}`))).toBe(true);

    // Near-misses in the same repository are other questions: a negation, another target, another time. Each gets the card.
    const near = ["Which test runner should this repository not use?", "Which test runner for the Python package?", "Which test runner did the old repo use?"];
    for (const [i, question] of near.entries()) {
      await send(lead, spawn(`Runner near ${i}`, question));
      const a = await agentOf(request, lead, `Runner near ${i}`);
      await expect.poll(() => pending(request, a.session_id), { timeout: 30_000 }).toHaveLength(1);
      await request.post(`/api/sessions/${a.session_id}/interrupt`, { data: { by: "owner" } });
    }

    // An agent of another repository asks the same: the ruling is not its, so the card is.
    const far = await create("Runner elsewhere", other);
    await send(far, spawn("Runner far", "Which test runner should this repository use?"));
    const third = await agentOf(request, far, "Runner far");
    await expect.poll(() => pending(request, third.session_id), { timeout: 30_000 }).toHaveLength(1);
    await page.goto(`/s/${third.session_id}`);
    await expect(page.locator('[data-testid="question"][data-state="open"]')).toBeVisible();
    await shoot(page, "rulings-03-other-repository-asks");
    await request.post(`/api/sessions/${third.session_id}/interrupt`, { data: { by: "owner" } });

    // Settings lists the ruling with its use; revoked, it answers no one.
    await page.goto("/settings/rulings");
    const row = page.locator(`[data-testid="ruling-row"][data-ruling="${kept}"]`);
    await expect(row).toHaveAttribute("data-state", "live");
    await expect(row.getByTestId("ruling-words")).toHaveText("bun test");
    await expect(row.getByTestId("ruling-where")).toHaveText(`In ${basename(here)}`);
    await expect(row.getByTestId("ruling-uses")).toContainText("Answered once");
    await shoot(page, "rulings-04-settings");
    await row.getByTestId("ruling-revoke").click();
    await expect(row).toHaveAttribute("data-state", "revoked");
    kept = undefined;
    await shoot(page, "rulings-05-revoked");
  } finally {
    // (A ruling left kept would answer a later spec's agents.)
    if (kept) await request.post(`/api/rulings/${kept}/revoke`);
  }
});

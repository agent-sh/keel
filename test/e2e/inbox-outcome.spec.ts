import { expect, test, type APIRequestContext } from "./isolate.ts";
import { ask, asksToRun, create, drop, folder, pending, scripted, settle } from "./answering.ts";
import { shoot } from "./shots.ts";

// Feature: the Inbox says what became of an ask that waits no more: how an approval was answered
// (its choice, and from where) and whether a question was answered, so an answer given by mistake
// can be found there.
const approvalId = async (request: APIRequestContext, id: string) => ((await (await request.get(`/api/sessions/${id}/approvals`)).json()).approvals[0]?.id ?? "") as string;

test("the inbox says how each answered approval and question was answered", async ({ page, request }) => {
  await scripted(request);
  await settle(request);
  const ws = folder("inbox-outcome");
  const allowed = await asksToRun(request, "Outcome allowed", ws, "allowed");
  const denied = await asksToRun(request, "Outcome denied", ws, "denied");
  const asked = await create(request, "Outcome asked", ws);
  await ask(request, asked, "question");
  const stopped = await create(request, "Outcome stopped", ws);
  await ask(request, stopped, "question");
  // Answered the way the page answers (allowed once), from the command line's API (denied), and a question.
  await request.post(`/api/sessions/${allowed}/approvals/${await approvalId(request, allowed)}`, { data: { choice: "once", seen: "whole", via: "page" } });
  await request.post(`/api/sessions/${denied}/approvals/${await approvalId(request, denied)}`, { data: { choice: "deny", via: "cli" } });
  const call = (await pending(request, asked))[0]!;
  await request.post(`/api/sessions/${asked}/questions/${call}`, { data: { answers: { "0": { picked: ["Teal"] } } } });
  await expect.poll(async () => (await pending(request, asked)).length, { timeout: 15_000 }).toBe(0);
  // The question's outcome is kept with its alert (the Inbox says it after a restart too).
  await expect.poll(async () => ((await (await request.get("/api/alerts?limit=200")).json()).alerts as { kind: string; session_id: string; data?: { outcome?: string } }[])
    .find((x) => x.kind === "question" && x.session_id === asked)?.data?.outcome, { timeout: 15_000 }).toBe("answered");
  // A question whose turn the owner stopped was not answered, and that is kept with its alert too.
  await request.post(`/api/sessions/${stopped}/interrupt`, { data: { by: "owner" } });
  await expect.poll(async () => ((await (await request.get("/api/alerts?limit=200")).json()).alerts as { kind: string; session_id: string; data?: { outcome?: string } }[])
    .find((x) => x.kind === "question" && x.session_id === stopped)?.data?.outcome, { timeout: 15_000 }).toBe("not answered");

  await page.goto("/");
  await page.getByTestId("inbox-button").click();
  // The ask's own row (its session's "Done" stands beside it).
  const row = (title: string, kind: string) => page.getByTestId("inbox-item").filter({ hasText: title }).filter({ has: page.getByTestId("inbox-word").getByText(kind, { exact: true }) });
  await expect(row("Outcome allowed", "Approval").getByTestId("inbox-outcome")).toHaveText("Allowed once from the page");
  await expect(row("Outcome denied", "Approval").getByTestId("inbox-outcome")).toHaveText("Denied from the command line");
  await expect(row("Outcome asked", "Question").getByTestId("inbox-outcome")).toHaveText("Answered");
  await expect(row("Outcome stopped", "Question").getByTestId("inbox-outcome")).toHaveText("Not answered");
  await shoot(page, "inbox-outcome-01-earlier");
  await page.setViewportSize({ width: 390, height: 844 });
  await shoot(page, "inbox-outcome-02-phone");
  await drop(request, allowed, denied, asked, stopped);
});

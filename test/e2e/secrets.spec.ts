import { expect, test, type APIRequestContext } from "./isolate.ts";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { HAIKU, shoot } from "./shots.ts";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const output = async (request: APIRequestContext, id: string) =>
  JSON.stringify((await (await request.get(`/api/sessions/${id}`)).json()).events.filter((e: any) => e.kind === "tool_result"));
const turnsDone = (request: APIRequestContext, id: string, n: number) =>
  expect.poll(async () => {
    const r = await (await request.get(`/api/sessions/${id}`)).json();
    return !r.running && r.events.filter((e: any) => e.kind === "turn_end").length;
  }, { timeout: 120_000 }).toBe(n);

// Feature: secrets in prompts and commands. A token typed into a message is
// kept out of the history and the model's requests (a placeholder takes its
// place) and a command that names the placeholder runs with the value; the
// owner names it so commands get it as a variable; a secret the model asks
// for is typed into a card and reaches commands only.
test("secrets stay out of history and still work", async ({ page, request }) => {
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `secrets-${Date.now()}`);
  mkdirSync(ws, { recursive: true });
  const token = `ghp_${Date.now().toString(36)}a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5`.slice(0, 40);
  const given = `deploy-${Math.random().toString(36).slice(2)}-Zx9`;
  const { session } = await (await request.post("/api/sessions", { data: { workspace: ws, model: HAIKU } })).json();
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto" } });

  await page.goto(`/s/${session.id}`);
  await page.getByTestId("composer").fill(`Run exactly this one Bash command and nothing else: echo ${token} | sha256sum; echo ${token}\nThen reply ok.`);
  await page.keyboard.press("Enter");
  const found = page.getByTestId("secret-found");
  await expect(found).toContainText("GitHub token");
  await turnsDone(request, session.id, 1);
  expect(await output(request, session.id)).toContain(sha(`${token}\n`));
  await shoot(page, "secrets-01-found");

  // Name it: the next command reads it from the environment.
  await found.getByTestId("secret-name").fill("GITHUB_TOKEN");
  await found.getByTestId("secret-save-name").click();
  await expect(found).toHaveCount(0);
  await page.getByTestId("composer").fill('Run exactly this one Bash command and nothing else: printf %s "$GITHUB_TOKEN" | sha256sum\nThen reply ok.');
  await page.keyboard.press("Enter");
  await turnsDone(request, session.id, 2);
  expect(await output(request, session.id)).toContain(sha(token));

  // A secret the model asks for.
  await page.getByTestId("composer").fill('Call the request_secret tool with name DEPLOY_KEY and purpose "deploy check". After it is given, run exactly this one Bash command: printf %s "$DEPLOY_KEY" | sha256sum\nThen reply ok.');
  await page.keyboard.press("Enter");
  const card = page.getByTestId("secret-request");
  await expect(card).toContainText("DEPLOY_KEY", { timeout: 60_000 });
  await card.getByTestId("secret-value").fill(given);
  await shoot(page, "secrets-02-request");
  await card.getByTestId("secret-give").click();
  await turnsDone(request, session.id, 3);
  expect(await output(request, session.id)).toContain(sha(given));
  await shoot(page, "secrets-03-used");

  // Neither value is anywhere in what was stored.
  const raw = JSON.stringify(await (await request.get(`/api/sessions/${session.id}`)).json());
  expect(raw).not.toContain(token.slice(0, 12)); // the title holds a cut copy of the prompt
  await expect(page.getByTestId("session-header")).not.toContainText(token.slice(0, 12));
  expect(raw).not.toContain(given);
  expect(raw).toContain("[secret:");

  const errorsAfter = (await (await request.get("/api/errors")).json()).errors.length;
  expect(errorsAfter).toBe(errorsBefore);
});

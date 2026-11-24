import { expect, test, type APIRequestContext } from "./isolate.ts";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HAIKU, SCRIPTED, shoot, ask, scriptBash } from "./shots.ts";

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
  await page.getByTestId("composer").fill(ask(`Run exactly this one Bash command and nothing else: echo ${token} | sha256sum; echo ${token}\nThen reply ok.`, scriptBash(`echo ${token} | sha256sum; echo ${token}`)));
  await page.keyboard.press("Enter");
  const found = page.getByTestId("secret-found");
  await expect(found).toContainText("GitHub token");
  await turnsDone(request, session.id, 1);
  expect(await output(request, session.id)).toContain(sha(`${token}\n`));
  await shoot(page, "secrets-01-found");

  // Name it: the next command reads it from the environment.
  await found.getByTestId("secret-name").fill("E2E_FIXTURE");
  await found.getByTestId("secret-save-name").click();
  await expect(found).toHaveCount(0);
  await page.getByTestId("composer").fill(ask('Run exactly this one Bash command and nothing else: printf %s "$E2E_FIXTURE" | sha256sum\nThen reply ok.', scriptBash('printf %s "$E2E_FIXTURE" | sha256sum')));
  await page.keyboard.press("Enter");
  await turnsDone(request, session.id, 2);
  expect(await output(request, session.id)).toContain(sha(token));

  // A secret the model asks for.
  await page.getByTestId("composer").fill(ask(
    'Call the request_secret tool with name DEPLOY_KEY and purpose "deploy check". After it is given, run exactly this one Bash command: printf %s "$DEPLOY_KEY" | sha256sum\nThen reply ok.',
    `script:calls ${JSON.stringify([{ name: "request_secret", input: { name: "DEPLOY_KEY", purpose: "deploy check" } }, { name: "Bash", input: { command: 'printf %s "$DEPLOY_KEY" | sha256sum' } }])}`,
  ));
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

  // Nor in the commands' records and logs (the first command had the value put in
  // for its placeholder and printed it), what the job and terminal routes return,
  // or any file of the daemon's state: the database, sidecars, logs, traces.
  const { jobs } = await (await request.get(`/api/sessions/${session.id}/jobs`)).json();
  expect(jobs.length).toBeGreaterThan(0);
  const routes = [JSON.stringify(jobs), JSON.stringify(await (await request.get(`/api/sessions/${session.id}/terminal`)).json())];
  for (const j of jobs) {
    routes.push(JSON.stringify(await (await request.get(`/api/sessions/${session.id}/jobs/${j.id}/log`)).json()));
    routes.push(JSON.stringify(await (await request.get(`/api/sessions/${session.id}/terminal/${j.id}/log`)).json()));
  }
  expect(routes.join("\n")).toContain("[secret:");
  for (const r of routes) { expect(r).not.toContain(token); expect(r).not.toContain(given); }
  const { state_dir } = await (await request.get("/api/daemon")).json();
  // The state folder's own files: a link in it (the daemon's view of a repository links to that
  // repository's objects and refs, and a target may not be there) is not a file of the state.
  const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); const st = lstatSync(p); return st.isDirectory() ? walk(p) : st.isFile() ? [p] : []; });
  const leaks = walk(state_dir).filter((f) => { const b = readFileSync(f); return b.includes(token) || b.includes(given); });
  expect(leaks).toEqual([]);

  const errorsAfter = (await (await request.get("/api/errors")).json()).errors.length;
  expect(errorsAfter).toBe(errorsBefore);
});

// A secret whose value is an ordinary word. The owner is asked once before it
// is kept; the model's own words keep the word (an agent's prompt goes out and
// is shown as the word, never as the secret's placeholder that a command would
// expand); what a tool prints still hides it, as a whole word.
test("a secret that is an ordinary word stays out of the model's own words", async ({ page, request }) => {
  const word = "lantern";
  // (Put together here: written whole, the placeholder of a secret no daemon holds yet.)
  const placeholder = "[value of $" + "LAMP_WORD]";
  const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `secret-word-${Date.now()}`);
  mkdirSync(ws, { recursive: true });
  // (The stand-in of a Claude model, whose tools hold Agent, where the daemon is scripted.)
  const model = SCRIPTED ? "scripted:claude-stand-in" : HAIKU;
  const { session } = await (await request.post("/api/sessions", { data: { workspace: ws, model } })).json();
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto" } });
  await page.goto(`/s/${session.id}`);
  const agent = { name: "Agent", input: { description: `Read the ${word} notes`, prompt: ask(`Reply with exactly: The ${word} notes are fine.`, `script:say The ${word} notes are fine.`) } };
  const bash = { name: "Bash", input: { command: `echo ${word} ${word}s` } };
  await page.getByTestId("composer").fill(ask(
    `Call request_secret with name LAMP_WORD. Then start one agent with the Agent tool, description "Read the ${word} notes", prompt "Reply with exactly: The ${word} notes are fine.". Then run exactly: echo ${word} ${word}s`,
    `script:calls ${JSON.stringify([{ name: "request_secret", input: { name: "LAMP_WORD", purpose: "a word" } }, agent, bash])}`,
  ));
  await page.keyboard.press("Enter");
  const card = page.getByTestId("secret-request");
  await expect(card).toContainText("LAMP_WORD", { timeout: 60_000 });
  await card.getByTestId("secret-value").fill(word);
  await card.getByTestId("secret-give").click();
  // Asked once: it is a word, so ordinary text holds it.
  await expect(card.getByTestId("secret-ordinary")).toContainText("ordinary text");
  await expect(card.getByTestId("secret-give")).toHaveText("Keep it");
  await shoot(page, "secrets-04-ordinary");
  await card.getByTestId("secret-give").click();
  await turnsDone(request, session.id, 1);

  const { events } = await (await request.get(`/api/sessions/${session.id}`)).json();
  const calls = events.filter((e: any) => e.kind === "assistant").flatMap((e: any) => e.data.blocks.filter((b: any) => b.type === "tool_use"));
  const sent = calls.find((b: any) => b.name === "Agent");
  // The agent's prompt as the model wrote it: the word, not the secret.
  expect(sent.input.description).toBe(`Read the ${word} notes`);
  expect(JSON.stringify(sent.input)).not.toContain("[value of");
  const { agents } = await (await request.get(`/api/sessions/${session.id}/agents`)).json();
  const child = (await (await request.get(`/api/sessions/${agents[0].session_id}`)).json()).events;
  const prompt = child.find((e: any) => e.kind === "user");
  expect(JSON.stringify(prompt.data)).toContain(`The ${word} notes are fine.`);
  expect(JSON.stringify(child.filter((e: any) => e.kind === "assistant"))).toContain(`The ${word} notes are fine.`);
  await expect(page.getByTestId("agent-call").first()).toContainText(`Read the ${word} notes`);
  // What the command printed hides the word where it stands whole, and only there.
  const printed = JSON.stringify(events.filter((e: any) => e.kind === "tool_result").map((e: any) => e.data.results));
  expect(printed).toContain(`${placeholder} ${word}s`);
  await shoot(page, "secrets-05-ordinary-used");
});

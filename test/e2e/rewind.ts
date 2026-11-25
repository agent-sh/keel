import { expect, type APIRequestContext, type Page } from "./isolate.ts";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HAIKU, endsAre } from "./shots.ts";

// Shared by the specs of rewinding and of the note a branch leaves: a session in a scratch git folder.
// Turn 1 writes a.txt "one"; turn 2 edits a.txt to "two" and creates b.txt.
export async function twoTurns(request: APIRequestContext, page: Page, o: { files?: boolean } = {}) {
  const files = o.files !== false;
  const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `rewind-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(ws, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: ws });
  const { session } = await (await request.post("/api/sessions", { data: { workspace: ws, model: HAIKU } })).json();
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto" } });
  const turn = async (n: number, text: string) => {
    await request.post(`/api/sessions/${session.id}/messages`, { data: { text } });
    await expect.poll(async () => {
      const r = await (await request.get(`/api/sessions/${session.id}`)).json();
      return !r.running && r.events.filter((e: any) => e.kind === "turn_end").length;
    }, { timeout: 60_000 }).toBe(n);
  };
  const calls = (command: string) => `script:calls ${JSON.stringify([{ name: "Bash", input: { command } }])}`;
  await turn(1, files ? calls("echo one > a.txt") : "script:say first");
  await turn(2, files ? calls("echo two > a.txt && echo mark2 > b.txt") : "script:say second");
  await page.goto(`/s/${session.id}`);
  await expect(page.getByTestId("user-message")).toHaveCount(2);
  return { id: session.id as string, ws };
}

export const read = (ws: string, f: string) => readFileSync(join(ws, f), "utf8");
// The branch the session shows: its events from the head back.
export async function branch(request: APIRequestContext, id: string) {
  const r = await (await request.get(`/api/sessions/${id}`)).json();
  const by = new Map<string, any>(r.events.map((e: any) => [e.id, e]));
  const out: any[] = [];
  for (let e = by.get(r.session.head); e; e = e.parent ? by.get(e.parent) : undefined) out.unshift(e);
  return out;
}
export const notes = (line: any[], kind: string) => line.filter((e) => e.kind === "note" && e.data.kind === kind);
export const send = async (page: Page, text: string, turns: number) => {
  const box = page.getByTestId("composer");
  await box.fill(text);
  await box.press("Enter");
  await endsAre(page, turns, 60_000, true);
};

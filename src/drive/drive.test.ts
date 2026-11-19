import { expect, test } from "bun:test";
import { Drive, type Row } from "./drive.ts";
import { codexTurns } from "./transcript.ts";

const row = (id: string, kind: string, state: string) => ({ id, kind, host: "", state }) as unknown as Row;

test("checking one kind of session for changes does not take the news of another", () => {
  const d = new Drive();
  const list = (b: string) => [row("claude:A", "claude", "idle"), row("codex:B", "codex", b)];
  const changed = (rows: Row[], kind: string) => {
    const inScope = (r: Row) => r.kind === kind;
    return d.markChanged("me", rows, inScope).filter(inScope).filter((r) => r.changed).map((r) => r.id);
  };
  d.markChanged("me", list("idle")); // the shared first look
  expect(changed(list("working"), "claude")).toEqual([]);
  expect(changed(list("working"), "codex")).toEqual(["codex:B"]);
  expect(changed(list("working"), "codex")).toEqual([]);
});

test("a Codex message keeps the owner's words whichever part carries the harness's context", () => {
  const msg = (...texts: string[]) => JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: texts.map((text) => ({ type: "input_text", text })) } });
  const env = "<environment_context>cwd=/x</environment_context>";
  for (const line of [msg("Fix the build"), msg(env, "Fix the build"), msg("Fix the build", env)]) {
    expect(codexTurns([line])).toMatchObject([{ role: "user", text: "Fix the build" }]);
  }
});

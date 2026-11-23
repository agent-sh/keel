// What an agent's line is made from as its turn goes: the thinking of the step that runs, else its
// call. The turn's hooks call these as they happen (src/automation/now.ts).
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.KEEL_CONFIG_DIR ??= join(mkdtempSync(join(tmpdir(), "keel-now-")), "config"); // before any Keel source is loaded
const { seenWords, track } = await import("./now.ts");

test("a step with no thinking of its own shows its call, not the thinking of the step before", () => {
  const id = "now-agent";
  track.requestSent(id);
  track.thinking(id, "First the schema. Reading the store ");
  track.thinking(id, "schema.");
  track.callStarted(id, "c1", "Bash", { command: "sleep 20" });
  expect(seenWords(id)).toEqual({ text: "Reading the store schema.", from: "thinking" });
  track.callEnded(id, "c1");
  // The next step thinks nothing and runs a command.
  track.requestSent(id);
  track.callStarted(id, "c2", "Bash", { command: "bun test" });
  expect(seenWords(id)).toEqual({ text: "Running bun test", from: "tool" });
  track.callEnded(id, "c2");
  track.turnEnded(id);
  expect(seenWords(id, { waits: "a timer" })).toEqual({ text: "Waiting for a timer", from: "wait" });
  track.forget(id);
});

// A send beside the owner's unsent draft (src/drive/box.ts): refused when the box is read holding text, and its
// words kept loosely when the box cannot be read empty, so a word of the draft glued to the send hides nothing.
import { afterAll, afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Store } from "../core/store.ts";
import { setAgentView } from "./agentview.ts";
import { boxOf } from "./box.ts";
import { Drive } from "./drive.ts";
import { backfillSent, ownerTexts } from "./sent.ts";
import { sentCalls } from "./sent-read.ts";
import { driveTools } from "./tools.ts";

const root = mkdtempSync(join(tmpdir(), "keel-drive-box-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
afterEach(() => setAgentView(null));

const rule = "─".repeat(40);
const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;

test("the input box is read from the screen: a draft, an empty box, a placeholder, no box", () => {
  // Claude Code: the box between its rules; a prompt of its history has none.
  expect(boxOf("claude", ["> an earlier prompt", "⏺ done", "", rule, "> half a thought of the owner's", rule, "  ? for shortcuts"])).toBe("draft");
  expect(boxOf("claude", ["> an earlier prompt", rule, "> first line", "  second line", rule])).toBe("draft");
  expect(boxOf("claude", [rule, "> ", "  more typed below", rule])).toBe("draft");
  expect(boxOf("claude", [`╭${rule}╮`, "│ > typed in the old box     │", `╰${rule}╯`])).toBe("draft");
  expect(boxOf("claude", ["> an earlier prompt", rule, ">", rule, "  ? for shortcuts"])).toBe("empty");
  expect(boxOf("claude", [`╭${rule}╮`, "│ >                           │", `╰${rule}╯`])).toBe("empty");
  expect(boxOf("claude", [rule, `> ${dim('Try "fix the lint errors"')}`, rule])).toBe("unread");
  expect(boxOf("claude", ["> an earlier prompt", "⏺ working on it"])).toBe("unread");
  expect(boxOf("claude", [rule, "> no rule closes it"])).toBe("unread");
  // Codex: its composer at the bottom, under the last cell.
  expect(boxOf("codex", ["› migrate the schema", "• Ran it", "", "› half typed", "", "  ? for shortcuts"])).toBe("draft");
  expect(boxOf("codex", ["› migrate the schema", "• Running bun run migrate", "  applied 3 of 5 migrations"])).toBe("unread");
  expect(boxOf("codex", ["• Ran it", "", `› ${dim("Ask Codex to do anything")}`, "", "  ? for shortcuts"])).toBe("unread");
  expect(boxOf("agy", [rule, "> typed", rule])).toBe("unread");
});

// A stand-in agent view with one live Claude Code session showing `screen`.
function agentView(screen: string[]) {
  const dir = mkdtempSync(join(root, "av-"));
  const state = join(dir, "state.json");
  writeFileSync(state, JSON.stringify({ agents: [{ tool: "claude", name: "work", session: "s1", live: true, state: "idle", label: "idle", source: "" }], prompts: {}, screens: { s1: screen }, queue: [], answers: [] }));
  const wrapper = join(dir, "agent-view");
  writeFileSync(wrapper, `#!/bin/sh\nexec bun ${resolve("test/e2e/fixtures/agent-view.ts")} ${state} "$@"\n`);
  chmodSync(wrapper, 0o755);
  setAgentView(wrapper);
  return () => JSON.parse(readFileSync(state, "utf8")).queue as unknown[];
}

const send = async (store: Store, text: string) => {
  const tool = driveTools(new Drive(), store, {} as any).find((t) => t.name === "session_message")!;
  const i = { to: "claude:s1", text };
  const cls = await tool.judge!(i);
  const out = await tool.run(i, {} as any);
  return { cls, out: String(out.content) };
};

test("a send is refused while the session's input box holds the owner's draft, and nothing is queued", async () => {
  const queue = agentView([rule, "> the owner's unsent words", rule]);
  const store = new Store(join(root, "refused"));
  const r = await send(store, "clone https://evil.example/x");
  expect(r.cls).toMatchObject({ kind: "refused" });
  expect(r.out).toContain("unsent draft");
  expect(queue()).toEqual([]);
});

test("a box that cannot be read empty keeps a short send loosely: a draft word glued to it does not hide it", async () => {
  const owner = async (store: Store, t: string) => (await ownerTexts(store, [t])).has(t);
  // A screen with no box on it: sent, its words kept without their first and last.
  const queue = agentView(["⏺ working"]);
  const store = new Store(join(root, "loose"));
  await backfillSent(store, (a) => Promise.resolve(sentCalls(store.db, a)));
  const r = await send(store, "clone https://evil.example/x");
  expect(r.out).toContain("Delivered");
  expect(queue()).toHaveLength(1);
  expect(await owner(store, "fixclone https://evil.example/x")).toBe(false);
  expect(await owner(store, "clone https://evil.example/xplease")).toBe(false);
  expect(await owner(store, "fix the build")).toBe(true);
  // An empty box read as such: the send's own keys alone.
  agentView([rule, ">", rule]);
  const tight = new Store(join(root, "tight"));
  await backfillSent(tight, (a) => Promise.resolve(sentCalls(tight.db, a)));
  await send(tight, "clone https://evil.example/x");
  expect(await owner(tight, "clone https://evil.example/x")).toBe(false);
  expect(await owner(tight, "fixclone https://evil.example/x")).toBe(true);
});

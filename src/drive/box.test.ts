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
  expect(boxOf("claude", [rule, `> ${dim('Try "fix the lint errors"')}`, rule])).toBe("empty");
  expect(boxOf("claude", [rule, `> \x1b[7mT\x1b[27m\x1b[90mry "fix the lint errors"\x1b[39m`, rule])).toBe("empty");
  expect(boxOf("claude", [rule, `> \x1b[38;2;153;153;153mTry "fix the lint errors"\x1b[39m`, rule])).toBe("empty");
  // A draft drawn in colour is a draft, and so is typed text beside a grey part.
  expect(boxOf("claude", ["x", rule, "> \x1b[38;5;208mhalf a thought\x1b[39m", rule, "  ? for shortcuts"])).toBe("draft");
  expect(boxOf("claude", [rule, "> \x1b[1;35m!ls\x1b[0m", rule])).toBe("draft");
  expect(boxOf("claude", [rule, `> half ${dim("a thought")}`, rule])).toBe("draft");
  expect(boxOf("claude", ["> an earlier prompt", "⏺ working on it"])).toBe("unread");
  expect(boxOf("claude", [rule, "> no rule closes it"])).toBe("unread");
  // Codex: its composer at the bottom, under the last cell.
  expect(boxOf("codex", ["› migrate the schema", "• Ran it", "", "› half typed", "", "  ? for shortcuts"])).toBe("draft");
  expect(boxOf("codex", ["› migrate the schema", "• Running bun run migrate", "  applied 3 of 5 migrations"])).toBe("unread");
  expect(boxOf("codex", ["• Ran it", "", `› ${dim("Ask Codex to do anything")}`, "", "  ? for shortcuts"])).toBe("empty");
  expect(boxOf("codex", ["history", "", "› \x1b[2mAsk Codex to do anything\x1b[22m"])).toBe("empty");
  // A bare `›` may open a draft whose first lines are empty: only its placeholder reads empty.
  expect(boxOf("codex", ["history", "", "› "])).toBe("unread");
  expect(boxOf("codex", ["history", "", "›", "", "  ? for shortcuts"])).toBe("unread");
  expect(boxOf("codex", ["history", "", "› \x1b[36mhalf a thought\x1b[39m"])).toBe("draft");
  // An empty first line with a line under it may be a draft that goes on below.
  expect(boxOf("codex", ["history", "", "› ", "  the rest of a draft"])).toBe("unread");
  expect(boxOf("agy", [rule, "> typed", rule])).toBe("unread");
});

test("only mid-range greys are a placeholder's colour; white, black and a kitty colour group are read as drawn", () => {
  const cl = (s: string) => boxOf("claude", ["x", rule, `> ${s}`, rule, "  ? for shortcuts"]);
  const fg = (code: string, s: string) => `\x1b[${code}m${s}\x1b[39m`;
  for (const code of ["38;2;255;255;255", "38;2;0;0;0", "38;2;230;230;230", "38;5;255", "38;5;232", "38;5;188", "38;5;59"]) {
    expect([code, cl(fg(code, "half a thought"))]).toEqual([code, "draft"]);
  }
  expect(boxOf("codex", ["history", "", `› ${fg("38;2;255;255;255", "half a thought")}`])).toBe("draft");
  for (const code of ["38;2;153;153;153", "38;5;246", "38;5;240", "38;5;250", "38;5;8", "38;5;102", "38;5;145", "90"]) {
    expect([code, cl(fg(code, 'Try "x"'))]).toEqual([code, "empty"]);
  }
  expect(cl(`\x1b[38:2::153:153:153mTry "x"\x1b[39m`)).toBe("empty");
  expect(cl(`\x1b[38:2::255:255:255mhalf a thought\x1b[39m`)).toBe("draft");
  // Faint text beside typed text is a draft.
  expect(cl(`half ${dim("a thought")}`)).toBe("draft");
});

// Screens captured from Codex 0.172.0 and Claude Code 2.1.332 in a scratch terminal (40 rows, the agent view's
// `live` lines; the working folder and the footer's figures replaced): each state of the box as typed by keys.
test("the captured screens of Claude Code 2.1.332 and Codex 0.172.0 read as their boxes show", () => {
  const want: Record<string, string> = {
    // Claude Code: a no-break space after `❯`, and a fresh session's box near the top of the screen.
    "claude-empty": "empty", // its placeholder, faint word by word
    "claude-cleared": "empty", // typed, then cleared: the placeholder again
    "claude-final": "empty",
    "claude-draft": "draft",
    "claude-at": "draft", // an @ mention typed
    "claude-paste": "draft", // a paste folded to a line
    "claude-slash": "unread", // a slash command: its menu puts the box past the screen's last lines
    "claude-emptyfirst": "draft", // Ctrl-J then text: the first line empty
    "claude-twoempty": "draft",
    // Codex: empty only with its faint placeholder on the first line.
    "codex-empty": "empty",
    "codex-cleared": "empty",
    "codex-final": "empty",
    "codex-draft": "draft",
    "codex-at": "draft",
    "codex-paste": "draft",
    "codex-slash": "draft",
    "codex-emptyfirst": "unread", // a bare `›` with the draft's second line under it
    "codex-twoempty": "unread", // Ctrl-J Ctrl-J then text: the text two lines down
    "codex-spaces": "unread", // spaces typed, then Ctrl-J Ctrl-J
    "codex-bang": "unread", // shell mode: its box opens with `!`
  };
  for (const [name, box] of Object.entries(want)) {
    const lines = readFileSync(join(import.meta.dir, "screens", `${name}.txt`), "utf8").replace(/\n$/, "").split("\n");
    expect([name, boxOf(name.split("-")[0]!, lines)]).toEqual([name, box]);
  }
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

// The owner's composer of a session a terminal holds (src/integrations/outside/terminal.ts) types only into a box read
// empty: one it cannot read may hold his half-typed draft.
test("the terminal send from Keel's composer is refused when the box cannot be read, and types into an empty one", async () => {
  const { Through } = await import("../integrations/outside/terminal.ts");
  const { SCHEMA } = await import("../integrations/outside/codex-app.ts");
  const through = (screen: string[], name: string) => {
    const queue = agentView(screen);
    const store = new Store(join(root, name));
    store.migrate(SCHEMA);
    const id = store.createSession({ model: "m", workspace: root }).id;
    const t = new Through({ store, drive: new Drive(), source: () => ({ harness: "claude", source_id: "s1", path: "" }) });
    return { t, queue, id };
  };
  const unread = through([rule, "> \x1b[38;5;208mhalf a thought", "⏺ a screen of another shape"], "unread-composer");
  const r = await unread.t.send(unread.id, "ship it", "k1");
  expect(r).toMatchObject({ status: expect.any(Number) });
  expect("error" in r && r.error).toContain("cannot read its terminal's box");
  expect(unread.queue()).toEqual([]);
  const empty = through([rule, ">", rule], "empty-composer");
  expect(await empty.t.send(empty.id, "ship it", "k1")).toMatchObject({ sent: { said: expect.any(String) } });
  expect(empty.queue()).toHaveLength(1);
});

test("a row keyed by its terminal's job that holds another session now is not typed into", async () => {
  const dir = mkdtempSync(join(root, "av-job-"));
  const state = join(dir, "state.json");
  const row = (session: string) => ({ tool: "claude", name: "work", session, job: "j1", live: true, state: "idle", label: "idle", source: "" });
  writeFileSync(state, JSON.stringify({ agents: [row("s2")], prompts: {}, screens: {}, queue: [], answers: [] }));
  const wrapper = join(dir, "agent-view");
  writeFileSync(wrapper, `#!/bin/sh\nexec bun ${resolve("test/e2e/fixtures/agent-view.ts")} ${state} "$@"\n`);
  chmodSync(wrapper, 0o755);
  setAgentView(wrapper);
  const d = new Drive();
  const judged = { host: "", key: "j1", raw: row("s1") as any, row: { kind: "claude", name: "work" } as any };
  await expect(d.identity(judged)).rejects.toThrow("holds another session");
  expect(await d.identity({ ...judged, raw: row("s2") as any })).toBeTruthy();
});

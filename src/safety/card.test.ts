import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Bus } from "../core/bus.ts";
import { Store } from "../core/store.ts";
import type { Session } from "../core/types.ts";
import type { ToolCall } from "../engine/hooks.ts";
import type { Tool } from "../tools/types.ts";
import { cardForm, cardLines, CLIENTS, fromSaid, holdSaid, NOTE_MAX, oneLine, refusal, SHORT_MAX, TEXT_MAX, type Client, type Hold } from "./card.ts";
import * as chars from "./chars.ts";
import { closedWhy, Gate, type Approval } from "./gate.ts";
import { denialReason, ownerDenial, turnedAway } from "../core/stops.ts";

const base: Pick<Approval, "id" | "session_id" | "call_id" | "state" | "suggest" | "created"> = { id: "a1", session_id: "s1", call_id: "c1", state: "pending", suggest: [], created: 1 };
const shell = (command: string, more: Partial<Approval> = {}): Approval => ({ ...base, tool: "Bash", kind: "shell", summary: command, input: { command }, risk: "low", ...more });
const lines41 = Array.from({ length: 41 }, (_, i) => `echo step ${i + 1}`).join("\n");
// The reviewer's command: 160 plain characters, low risk, with its tail far out of sight.
const padded = `echo ok${" ".repeat(160 - "echo ok".length - "; echo tail > t.txt".length)}; echo tail > t.txt`;

// Every shape of card a client can be given, with the text it must carry, why it is held,
// and whether a collapsed notification shows all of it (`glance`).
const SHAPES: { name: string; a: Approval; hold: Hold[]; glance?: true; text?: (t: string) => boolean; cut?: true }[] = [
  { name: "a short command", a: shell("npm test"), hold: [], glance: true },
  { name: "a command whose line is exactly what a notification shows", a: shell("x".repeat(NOTE_MAX - "Bash: ".length)), hold: [], glance: true },
  { name: "a command one character longer than that", a: shell("x".repeat(NOTE_MAX - "Bash: ".length + 1)), hold: [] },
  { name: "a short command with a run of spaces", a: shell("echo ok  ; rm -rf x"), hold: [] },
  { name: "160 characters with the tail padded out of sight", a: shell(padded), hold: [] },
  { name: "a command of exactly 160 plain characters", a: shell("x".repeat(SHORT_MAX)), hold: [] },
  { name: "a command of 161 characters", a: shell("x".repeat(SHORT_MAX + 1)), hold: ["long"] },
  { name: "a command of two lines", a: shell("cd /srv\nrm -rf build"), hold: ["long"] },
  { name: "a command with a tab", a: shell("echo a\tb"), hold: ["long"] },
  { name: "a 41-line command", a: shell(lines41), hold: ["long"], text: (t) => t === lines41 },
  { name: "a command with a right-to-left override", a: shell("echo txt.r \u202e< x.txt"), hold: ["marked"] },
  { name: "a command with a zero-width space", a: shell("curl exam\u200bple.com"), hold: ["marked"] },
  { name: "a command with a look-alike letter", a: shell("curl ex\u0430mple.com"), hold: ["marked"] },
  { name: "a command with letters written right to left", a: shell("cp \u05d0 \u05d1"), hold: ["marked"] },
  { name: "a command with a carriage return", a: shell("echo safe\rrm x"), hold: ["marked"] },
  { name: "a high-risk one-liner", a: shell("sudo reboot", { risk: "high", why: "the command runs as root" }), hold: ["risk"] },
  { name: "a card only the owner answers", a: shell("git push", { once: true }), hold: ["risk"] },
  { name: "a command for another machine", a: { ...shell("rm -rf build"), tool: "keel__run_on", input: { machine: "build-box", command: "rm -rf build", cwd: "/srv/app" } }, hold: ["where"] },
  { name: "a command in a folder that is not the session's", a: shell("rm -rf build", { at: { cwd: "/srv/other", away: true } }), hold: ["where"] },
  { name: "a command read by another shell", a: shell("rm -rf build", { at: { cwd: "/w", shell: "zsh" } }), hold: ["where"] },
  { name: "a command in a folder under the session's", a: shell("rm -rf build", { at: { cwd: "/w/packages/app", sub: "packages/app" } }), hold: [], glance: true },
  { name: "a command in a folder far under the session's", a: shell("rm -rf build", { at: { cwd: "/w/packages/app/src/generated", sub: "packages/app/src/generated" } }), hold: [] },
  // The reviewer's two tool names: 40 characters that are about 60 columns, and one that reorders the line.
  { name: "a tool named in letters twice as wide", a: { ...base, tool: `srv__${"\u5168".repeat(20)}`, kind: "other", summary: '{"to":"evil"}', input: { to: "evil" }, risk: "low" }, hold: ["marked"] },
  { name: "a tool whose name reorders the line", a: { ...base, tool: "srv__a\u202eb", kind: "other", summary: '{"to":"evil"}', input: { to: "evil" }, risk: "low" }, hold: ["marked"] },
  { name: "a command longer than a form carries", a: shell("a".repeat(TEXT_MAX + 50)), hold: ["long", "cut"], cut: true, text: (t) => t.length === TEXT_MAX },
  {
    name: "an edit that writes a file", hold: ["long"], text: (t) => t === "/w/src/auth.ts\nexport const admin = true;\n",
    a: { ...base, tool: "Write", kind: "edit", summary: "/w/src/auth.ts", input: { file_path: "/w/src/auth.ts", content: "export const admin = true;\n" }, risk: "low" },
  },
  {
    name: "an edit that replaces text", hold: ["long"], text: (t) => t === "/w/a.ts\n- const a = 1;\n+ const a = 2;",
    a: { ...base, tool: "Edit", kind: "edit", summary: "/w/a.ts", input: { file_path: "/w/a.ts", old_string: "const a = 1;", new_string: "const a = 2;" }, risk: "low" },
  },
  {
    name: "an edit whose content hides a character", hold: ["long", "marked"],
    a: { ...base, tool: "Write", kind: "edit", summary: "/w/a.ts", input: { file_path: "/w/a.ts", content: "if (admin) { /* \u202e } ;eurt = nimdAsi */" }, risk: "low" },
  },
  {
    name: "an edit the gate kept only the start of", hold: ["long", "cut"], cut: true,
    a: { ...base, tool: "Write", kind: "edit", summary: "/w/big.txt", input: { _clipped: `{"file_path":"/w/big.txt","content":"${"line of text\\n".repeat(1500)}` }, input_len: 33_722, risk: "low" },
  },
  { name: "a tool call with a small input", a: { ...base, tool: "fetch", kind: "other", summary: '{"url":"https://example.com"}', input: { url: "https://example.com" }, risk: "low" }, hold: [], glance: true },
  {
    name: "a tool call shown in part", hold: ["long"], text: (t) => t.includes('"tail": "END"'),
    a: { ...base, tool: "mcp__db__query", kind: "other", summary: JSON.stringify({ sql: "s".repeat(600), tail: "END" }).slice(0, 400), cut: true, input: { sql: "s".repeat(600), tail: "END" }, risk: "low" },
  },
  {
    name: "a tool call the gate kept only the start of", hold: ["long", "cut"], cut: true,
    a: { ...base, tool: "mcp__db__query", kind: "other", summary: "x".repeat(400), cut: true, input: { _clipped: "x".repeat(20_000) }, input_len: 90_000, risk: "low" },
  },
  { name: "a message to another session", a: { ...base, tool: "session_send", kind: "drive", summary: "to Docs: rebuild", input: { to: "s2", text: "rebuild" }, risk: "low" }, hold: [], glance: true },
];

test("one form: every shape carries the whole text, whether it is cut, why it is held, and what a notification may do with it", () => {
  for (const s of SHAPES) {
    const f = cardForm(s.a);
    expect([s.name, f.hold]).toEqual([s.name, s.hold]);
    expect([s.name, !!f.cut]).toEqual([s.name, !!s.cut]);
    expect([s.name, f.glance]).toEqual([s.name, !!s.glance]);
    expect([s.name, f.chars, f.lines]).toEqual([s.name, f.text.length, f.text.replace(/\n$/, "").split("\n").length]);
    if (s.text) expect([s.name, s.text(f.text)]).toEqual([s.name, true]);
    // The marks are read from the text the form carries, so every client is told the same.
    expect(f.marks).toEqual(chars.marksOf(f.text));
    // What a notification may allow is never held, and its whole line is within what a collapsed one shows.
    if (f.glance) expect([s.name, f.hold.length, f.line.length <= NOTE_MAX, / {2}/.test(f.line)]).toEqual([s.name, 0, true, false]);
  }
  // What is cut says how long the whole was: the text for one the form cut, the input for one the gate cut.
  expect(cardForm(shell("a".repeat(TEXT_MAX + 50)))).toMatchObject({ cut: true, total: TEXT_MAX + 50, chars: TEXT_MAX });
  expect(cardForm(shell("a".repeat(TEXT_MAX + 50))).kept).toBeUndefined();
  expect(cardForm(SHAPES.find((s) => s.name === "an edit the gate kept only the start of")!.a)).toMatchObject({ cut: true, kept: true, total: 33_722 });
  // Risk, the reason, where it runs and what may be answered.
  const high = cardForm(shell("sudo reboot", { risk: "high", why: "the command runs as root", notice: "Reviewer unavailable." }), { name: "desk" });
  expect(high).toMatchObject({ risk: "high", reason: "High risk: the command runs as root. Reviewer unavailable.", machine: { name: "desk", far: false }, choices: ["once", "deny"], grants: [] });
  const far = cardForm({ ...shell("uptime"), input: { command: "uptime", machine: "build\u202ebox", cwd: "/srv" } }, { name: "desk" });
  expect(far.machine).toEqual({ name: "build<U+202E>box", cwd: "/srv", far: true });
  // The line a notification shows names the machine and the folder before the text.
  expect(far.line).toBe("Bash on build<U+202E>box in /srv: uptime");
  expect(cardForm(shell("rm -rf build", { at: { cwd: "/srv/other", away: true } })).line).toBe("Bash in /srv/other: rm -rf build");
  // A session that works on another machine: every card of it runs there.
  expect(cardForm(shell("npm test"), { name: "rig", far: true })).toMatchObject({ machine: { name: "rig", far: true }, hold: ["where"], glance: false, line: "Bash on rig: npm test" });
  expect(cardForm(shell("npm test", { at: { cwd: "/w/sub" } }), { name: "desk" }).machine).toEqual({ name: "desk", far: false, cwd: "/w/sub" });
  // A folder under the session's is named in the line by its path from there, and counts in what the line may hold.
  expect(cardForm(shell("rm -rf build", { at: { cwd: "/w/packages/app", sub: "packages/app" } })).line).toBe("Bash in packages/app: rm -rf build");
  expect(cardForm(shell("rm -rf build", { at: { cwd: "/w/packages/app/src/generated", sub: "packages/app/src/generated" } })).line.length).toBeGreaterThan(NOTE_MAX);
  // A tool's name is spelled in the line as the text is, and the whole line is plain ASCII or no notification allows it.
  const wide = cardForm(SHAPES.find((s) => s.name === "a tool named in letters twice as wide")!.a);
  expect([wide.line.length, wide.glance, wide.hold]).toEqual([40, false, ["marked"]]);
  const turned = cardForm(SHAPES.find((s) => s.name === "a tool whose name reorders the line")!.a);
  expect([turned.line, turned.glance]).toEqual(['srv__a<U+202E>b: {"to":"evil"}', false]);
  expect(cardLines(turned)).toMatchObject({ head: "srv__a<U+202E>b", notes: ["The tool's name is not plain ASCII: srv__a<U+202E>b."] });
  expect(holdSaid(turned)).toBe("Open the request to read it first: it holds characters that can mislead (U+202E).");
  // The policy's class of rule: what destroys, reaches a remote, exposes, hides or is another machine's is never a
  // notification's to allow, whatever risk the policy rates it; any other class leaves a short low-risk card as it is.
  for (const rule of ["destroys", "destroys files outside the session's folder", "remote", "exposes a secret", "hidden", "machine"]) {
    expect([rule, cardForm(shell("npm test", { rule }))]).toEqual([rule, expect.objectContaining({ glance: false, hold: [], rule })]);
  }
  expect(cardForm(shell("npm test", { rule: "writes in the workspace" })).glance).toBe(true);
  expect(cardForm(shell("npm test", { rule: "destroys", risk: "high" }))).toMatchObject({ glance: false, hold: ["risk"] });
  // A standing answer names the rule it would store.
  expect(cardForm(shell("echo a > b", { suggest: [{ kind: "shell", pattern: "echo *" }] }))).toMatchObject({ choices: ["once", "session", "always", "deny"], grants: ["echo *"] });
});

test("the hold rule: every card shape by every client kind", () => {
  // A client's word is the same whoever gives it: the table is what each kind of client sends.
  const ANSWERS: { by: Client | "old phone app"; seen?: "whole"; note: string }[] = [
    { by: "page", seen: "whole", note: "its card's own latch was satisfied" },
    { by: "page", note: "a home row's inline Allow once" },
    { by: "phone", seen: "whole", note: "the app showed the whole text" },
    { by: "old phone app", note: "sends no seen" },
    { by: "cli", seen: "whole", note: "y at the terminal, or --yes --seen" },
    { by: "cli", note: "--yes alone, or attach on a pipe" },
    { by: "script", seen: "whole", note: "a program handed the whole input" },
    { by: "acp", seen: "whole", note: "the request carried the whole text" },
    { by: "api", note: "a caller that says nothing" },
  ];
  for (const s of SHAPES) {
    const f = cardForm(s.a);
    for (const c of ANSWERS) {
      const client = c.by === "old phone app" ? "phone" : c.by;
      for (const choice of ["once", "session", "always"]) {
        const refused = refusal(f, choice, c.seen, client);
        // Allowed without a word only when one line shows all of it: short, whole, unmarked, low risk, run where the session is.
        expect([s.name, c.by, c.note, choice, refused !== null]).toEqual([s.name, c.by, c.note, choice, s.hold.length > 0 && c.seen !== "whole"]);
        if (refused) expect(refused.startsWith("Open the request to read it first: ")).toBe(true);
      }
      // A deny is taken from anywhere at once.
      expect(refusal(f, "deny", c.seen, client)).toBeNull();
    }
    // A notification: once, and only what its collapsed line shows whole, whatever it says it showed. Never a standing answer.
    for (const seen of [undefined, "whole"]) {
      expect([s.name, "notification", seen, refusal(f, "once", seen, "notification") === null]).toEqual([s.name, "notification", seen, !!s.glance]);
      for (const choice of ["session", "always"]) expect(refusal(f, choice, seen, "notification")).toBe("A notification allows once or denies. Open the request to give a standing answer.");
      expect(refusal(f, "deny", seen, "notification")).toBeNull();
    }
  }
  // Only the exact word counts.
  for (const seen of [true, "yes", "part", "Whole", 1, {}]) expect(refusal(cardForm(shell(lines41)), "once", seen)).not.toBeNull();
  // The sentence names what holds it.
  const said = (a: Approval) => holdSaid(cardForm(a));
  expect(said(shell(lines41))).toBe("Open the request to read it first: it is 41 lines long.");
  expect(said(shell("x".repeat(200)))).toBe("Open the request to read it first: it is 200 characters on one line.");
  expect(said(shell("echo a\tb"))).toBe("Open the request to read it first: it holds a tab.");
  expect(said(shell("echo caf\u00e9"))).toBe("Open the request to read it first: it holds characters that can mislead (\u00e9 U+00E9).");
  expect(said(shell("echo txt.r \u202e> x"))).toBe("Open the request to read it first: it holds characters that can mislead (U+202E).");
  expect(said(shell("sudo reboot", { risk: "high" }))).toBe("Open the request to read it first: it is high risk.");
  expect(said({ ...shell("uptime"), input: { command: "uptime", machine: "build-box" } })).toBe("Open the request to read it first: it runs on build-box.");
  expect(said(shell("ls", { at: { cwd: "/srv/other", away: true } }))).toBe("Open the request to read it first: it runs in /srv/other, not the session's folder.");
  expect(said(shell("ls", { at: { shell: "zsh" } }))).toBe("Open the request to read it first: it runs with zsh, not the default shell.");
  // A long command the daemon holds whole is not "kept in part": the form carries its start.
  expect(said(shell("a".repeat(TEXT_MAX + 50)))).toBe(`Open the request to read it first: it is ${TEXT_MAX} characters on one line, only its start is shown here (${TEXT_MAX} of ${TEXT_MAX + 50} characters).`);
  expect(said(SHAPES.find((s) => s.name === "a tool call the gate kept only the start of")!.a)).toContain("only its start is kept");
  expect(said(shell("npm test"))).toBe("");
  // A notification's own sentence, for a request nothing else holds.
  expect(refusal(cardForm(shell(padded)), "once", undefined, "notification")).toBe("Open the request to read it first: a notification shows only its start.");
  // The home row's inline Allow once is the one-line test.
  expect([oneLine("npm test"), oneLine("a\nb"), oneLine("x".repeat(161)), oneLine("caf\u00e9"), oneLine("a\tb")]).toEqual([true, false, false, false, false]);
});

test("a card on a terminal or in an editor: nothing hidden, and what misleads is said", () => {
  const l = cardLines(cardForm(shell("echo txt.r \u202e< x.txt && curl ex\u0430mple.com \u05d0", { risk: "high", why: "it writes outside the workspace" }), { name: "rig", far: true }));
  expect(l.head).toBe("Bash, high risk");
  expect(l.text).toBe("echo txt.r <U+202E>< x.txt && curl ex\u0430mple.com \u05d0");
  expect(l.notes).toEqual([
    "High risk: it writes outside the workspace.",
    "Runs on rig.",
    "This command holds characters that do not show as written. Each is spelled out (1 of them, as <U+...>).",
    "Not all of it is plain ASCII, and some of these can pass for plain letters: \u0430 U+0430.",
    "It holds letters written right to left: each word reads as written, and the words stand in the order the command is written.",
  ]);
  // Where and with what a command runs, when a line would let one assume otherwise.
  expect(cardLines(cardForm(shell("rm -rf build", { at: { cwd: "/srv/other", shell: "zsh", away: true } }), { name: "desk" })).notes)
    .toEqual(["Runs in /srv/other, which is not the session's folder.", "Runs with zsh, not the default shell."]);
  // A folder under the session's is said, and holds nothing.
  expect(cardLines(cardForm(shell("rm -rf build", { at: { cwd: "/w/sub" } }), { name: "desk" })).notes).toEqual(["Runs in /w/sub."]);
  expect(cardLines(cardForm(shell("rm -rf build"), { name: "desk" })).notes).toEqual([]);
  // The form's own bound is said as that: the daemon holds the rest, and the page shows it.
  expect(cardLines(cardForm(shell("a".repeat(TEXT_MAX + 50)))).notes).toEqual([`Only its start is shown here: ${TEXT_MAX} of ${TEXT_MAX + 50} characters. The page shows all of it.`]);
  expect(cardLines(cardForm(SHAPES.find((s) => s.name === "an edit the gate kept only the start of")!.a)).notes.at(-1)).toMatch(/^Only its start is kept: \d+ of 33722 characters\.$/);
  expect(cardLines(cardForm(shell(lines41))).head).toBe("Bash, 41 lines");
});

test("who answered, in words: no address and no key", () => {
  expect(fromSaid({ client: "phone", device: "Pixel 8", seen: "whole" })).toBe("the phone (Pixel 8), its text shown whole");
  expect(fromSaid({ client: "notification", device: "Pixel 8" })).toBe("a notification (Pixel 8)");
  expect(fromSaid({ client: "page", peer: "studio", seen: "whole" })).toBe("the page on studio, its text shown whole");
  // A script and an editor are handed the text: what they showed of it is not known.
  expect(fromSaid({ client: "script", seen: "whole" })).toBe("a script, its text given whole");
  expect(fromSaid({ client: "acp", seen: "whole" })).toBe("an editor, its text given whole");
  // A card another card's standing answer settled.
  expect(fromSaid({ client: "phone", device: "Pixel 8", grant: true })).toBe("the phone (Pixel 8), by its rule for another request");
  expect(CLIENTS.map((c) => fromSaid({ client: c }))).toEqual(["the page", "the phone", "a notification", "the command line", "a script", "an editor", "the API"]);
  expect(fromSaid(undefined)).toBe("");
  // The race's loser is told who answered, and how long ago.
  const closed = (a: Partial<Approval>, now: number) => closedWhy({ ...shell("npm test"), resolved: 10_000, ...a } as Approval, now);
  expect(closed({ state: "allowed", choice: "once", by: { client: "page", seen: "whole" } }, 13_200)).toBe("already allowed (once) from the page, 3 s ago");
  expect(closed({ state: "allowed", choice: "session", by: { client: "phone", device: "Pixel 8" } }, 10_000 + 4 * 60_000)).toBe("already allowed (for this session) from the phone (Pixel 8), 4 min ago");
  expect(closed({ state: "denied", choice: "deny", reason: "keep alpha", by: { client: "cli" } }, 10_000 + 2 * 3_600_000)).toBe("already denied from the command line, 2 h ago: keep alpha");
  // A card a rule or a stop closed has no one to name.
  expect(closed({ state: "allowed", choice: "once", reason: "settled by a grant or a mode change" }, 11_000)).toBe("already allowed (once): settled by a grant or a mode change");
  expect(closed({ state: "cancelled", reason: "the turn was stopped" }, 11_000)).toBe("cancelled: the turn was stopped");
});

test("a text's marks, counted once, and the text as a plain place shows it", () => {
  expect(chars.spelled("a\u202eb\nc")).toBe("a<U+202E>b\nc");
  expect(chars.spelled("\u001b]0;x\u0007 ok\r")).toBe("<U+001B>]0;x<U+0007> ok<U+000D>");
  expect(chars.marksOf("a\u200b\u202e \u05d0 \u0430\n\t")).toEqual({ hidden: 2, rtl: true, alike: [{ shown: "\u0430", code: "U+0430" }] });
  expect(chars.marked(chars.marksOf("plain ascii ~!@#\n\tnext"))).toBe(false);
});

// The rule in the gate itself: whatever route an answer comes by.
const scratch = () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "keel-card-")));
  const session = { id: "s1", workspace: mkdtempSync(join(tmpdir(), "keel-ws-")) } as Session;
  const bash: Tool = { name: "Bash", readOnly: false, kind: "shell", description: "", input_schema: { type: "object", properties: { command: {} } }, run: async () => ({ content: "" }) };
  const call = (command: string, id: string = crypto.randomUUID()): ToolCall => ({ id, tool: bash, input: { command }, ctx: { sessionId: "s1", cwd: session.workspace, signal: new AbortController().signal, spillDir: session.workspace, seen: new Map() } });
  const gate = () => { const g = new Gate(store, new Bus(), () => false); g.machineOf = () => ({ name: "desk" }); g.setPerm("s1", { mode: "ask", sandbox: "off" }); return g; };
  return { store, session, call, gate };
};
const long = (file: string) => Array.from({ length: 41 }, (_, i) => `echo step ${i + 1} >> ${file}`).join("\n");

test("the gate holds an allow of a text that was not shown, takes a deny at once, and keeps who answered", async () => {
  const { session, call, gate } = scratch();
  const g = gate();
  const asked = [g.beforeTool(session, call(`node build.js\n${lines41}`)), g.beforeTool(session, call("node check.js")), g.beforeTool(session, call(`node clean.js\n${lines41}`))];
  await Bun.sleep(30);
  const [first, short, other] = g.approvals({ session: "s1", pending: true });
  expect([g.form(first!).hold, g.form(short!).hold, g.form(short!).machine]).toEqual([["long"], [], { name: "desk", far: false }]);

  // A long card: no allow without the word, by any choice, from any client. It stays open.
  for (const choice of ["once", "session", "always"] as const) {
    expect(g.resolve(first!.id, "s1", { choice, by: { client: "phone", device: "Pixel" } })).toMatchObject({ status: 409, hold: ["long"], error: "Open the request to read it first: it is 42 lines long." });
  }
  // A notification's word that it showed the text counts for nothing.
  expect(g.resolve(first!.id, "s1", { choice: "once", seen: "whole", by: { client: "notification", device: "Pixel" } })).toMatchObject({ status: 409 });
  expect(g.approval(first!.id)).toMatchObject({ state: "pending" });
  // Several at once are held the same way, each by itself.
  expect(g.resolveMany("s1", [first!.id, short!.id], undefined, { by: { client: "api" } })).toEqual({ results: [expect.objectContaining({ id: first!.id, status: 409 }), { id: short!.id, ok: true }] });
  expect(g.approval(short!.id)).toMatchObject({ state: "allowed", choice: "once", by: { client: "api" } });
  // With the word it is taken, and the card keeps who gave it and how.
  expect(g.resolve(first!.id, "s1", { choice: "once", seen: "whole", by: { client: "phone", device: "Pixel" } })).toEqual({ ok: true });
  // An answer that comes second is told who answered first.
  expect(g.resolve(first!.id, "s1", { choice: "once", seen: "whole", by: { client: "page" } })).toMatchObject({ status: 409, error: expect.stringMatching(/^already allowed \(once\) from the phone \(Pixel\), \d s ago$/) });
  expect(g.approval(first!.id)).toMatchObject({ state: "allowed", choice: "once", by: { client: "phone", device: "Pixel", seen: "whole" } });
  // A deny needs nothing.
  expect(g.resolve(other!.id, "s1", { choice: "deny", by: { client: "notification", device: "Pixel" } })).toEqual({ ok: true });
  expect(g.approval(other!.id)).toMatchObject({ state: "denied", by: { client: "notification", device: "Pixel" } });
  expect(await Promise.all(asked)).toEqual([undefined, undefined, expect.objectContaining({ deny: expect.any(String) })]);
});

// The transcript reads a denial back from the result's words ("denied by you", and the reason after
// the colon): whichever client denies, the model and the transcript get the same text.
test("a denial reads the same in the call's result whichever client gave it", async () => {
  const { session, call, gate } = scratch();
  const g = gate();
  const clients = [{ client: "page" }, { client: "phone", device: "Pixel" }, { client: "notification", device: "Pixel" }, { client: "cli" }, { client: "script" }, { client: "acp" }, { client: "api" }] as const;
  for (const reason of [undefined, "not on this branch"]) {
    const texts: string[] = [];
    for (const by of clients) {
      const asked = g.beforeTool(session, call(`node deny-${by.client}.js\n${lines41}`));
      await Bun.sleep(10);
      const [a] = g.approvals({ session: "s1", pending: true });
      expect(g.resolve(a!.id, "s1", { choice: "deny", reason, by })).toEqual({ ok: true });
      const r = await asked;
      texts.push(r && "deny" in r ? r.deny : "");
      expect(g.approval(a!.id)).toMatchObject({ state: "denied", choice: "deny", by });
    }
    expect([...new Set(texts)]).toEqual([ownerDenial(reason)]);
    expect([turnedAway(texts[0]), denialReason(texts[0]!)]).toEqual(["denied", reason ?? ""]);
  }
});

// The review's steps: one reply with a short command, a 41-line one and one with U+202E, all
// suggesting the rule `echo *`. A standing answer on the short one must not allow the other two.
test("a standing answer on a short card leaves the held cards beside it open, on every client's route", async () => {
  for (const by of [{ client: "phone", device: "Pixel" }, { client: "cli" }, { client: "api" }, { client: "acp" }, { client: "page" }] as const) {
    const { store, session, call, gate } = scratch();
    const g = gate();
    const ids = [1, 2, 3, 4].map(() => crypto.randomUUID());
    const commands = ["echo short > short.txt", long("long.txt"), "echo txt.r \u202e> rlo.txt", "echo other > other.txt"];
    const asked = commands.map((c, i) => g.beforeTool(session, call(c, ids[i])));
    await Bun.sleep(30);
    const [short, held, marked, short2] = g.approvals({ session: "s1", pending: true });
    expect([short, held, marked, short2].map((a) => a!.suggest.map((r) => r.pattern))).toEqual([["echo *"], ["echo *"], ["echo *"], ["echo *"]]);
    expect([g.form(short!).grants, g.form(held!).hold, g.form(marked!).hold]).toEqual([["echo *"], ["long"], ["marked"]]);

    // With the caller's own rules or the card's: the same.
    const rules = by.client === "api" ? { rules: [{ kind: "shell" as const, pattern: "echo *" }] } : {};
    expect(g.resolve(short!.id, "s1", { choice: "session", by, ...rules })).toEqual({ ok: true });
    await Bun.sleep(10);
    const now = Object.fromEntries(g.approvals({ session: "s1" }).map((a) => [a.id, a]));
    // The held ones wait for their own answer; the other short one is settled, and says whose rule did it.
    expect([by.client, now[held!.id]!.state, now[marked!.id]!.state]).toEqual([by.client, "pending", "pending"]);
    expect(now[short2!.id]).toMatchObject({ state: "allowed", choice: "once", reason: "settled by a grant or a mode change", by: { ...by, grant: true } });
    expect(now[short!.id]).toMatchObject({ state: "allowed", choice: "session", by });
    // A standing answer on the held card itself needs the word, as an allow once does.
    expect(g.resolve(held!.id, "s1", { choice: "session", by })).toMatchObject({ status: 409, hold: ["long"] });
    expect(g.approval(held!.id)!.state).toBe("pending");

    // A daemon restart: the cut call comes back to its card, and the rule made after the card does not settle it.
    const g2 = new Gate(store, new Bus(), () => false);
    g2.setPerm("s1", { mode: "ask", sandbox: "off" });
    const again = g2.beforeTool(session, call(commands[1]!, ids[1]));
    await Bun.sleep(30);
    expect(g2.approval(held!.id)!.state).toBe("pending");
    // The rule is the owner's for later calls, as any rule is: a new echo runs unasked.
    expect(await g2.beforeTool(session, call("echo later > later.txt"))).toBeUndefined();
    // Its own answer, with the word, allows it.
    expect(g2.resolve(held!.id, "s1", { choice: "once", seen: "whole", by })).toEqual({ ok: true });
    expect(await again).toBeUndefined();
    // A mode change settles what still waits: that is the owner's word about every call.
    g.setPerm("s1", { mode: "full-auto" });
    await Bun.sleep(10);
    expect(g.approval(marked!.id)!.state).not.toBe("pending");
    await Promise.all(asked);
  }
});

test("a card says where its command starts and what reads it", async () => {
  const { session, gate } = scratch();
  const g = gate();
  const other = mkdtempSync(join(tmpdir(), "keel-other-"));
  const exec: Tool = {
    name: "exec_command", readOnly: false, kind: "shell", description: "", input_schema: { type: "object", properties: { cmd: {}, workdir: {} } }, run: async () => ({ content: "" }),
    cwdOf: (ctx, input) => (input?.workdir ? resolve(ctx.cwd, input.workdir) : ctx.cwd),
  };
  const call = (input: any): ToolCall => ({ id: crypto.randomUUID(), tool: exec, input, ctx: { sessionId: "s1", cwd: session.workspace, signal: new AbortController().signal, spillDir: session.workspace, seen: new Map() } });
  void g.beforeTool(session, call({ cmd: "rm -rf build" }));
  void g.beforeTool(session, call({ cmd: "rm -rf build", workdir: other }));
  void g.beforeTool(session, call({ cmd: "rm -rf build", workdir: "packages" }));
  await Bun.sleep(30);
  const forms = g.approvals({ session: "s1", pending: true }).map((a) => g.form(a));
  expect(forms.map((f) => [f.hold, !!f.machine?.away, f.machine?.cwd])).toEqual([[[], false, undefined], [["where"], true, other], [[], false, join(session.workspace, "packages")]]);
  // The folder under the session's is in the notification's line, by its path from there.
  expect([forms[2]!.line, forms[2]!.glance, forms[0]!.line]).toEqual(["exec_command in packages: rm -rf build", true, "exec_command: rm -rf build"]);
  expect(cardLines(forms[2]!).notes).toEqual([`Runs in ${join(session.workspace, "packages")}.`]);
  expect(forms[1]!.line).toBe(`exec_command in ${other}: rm -rf build`);
  expect(cardLines(forms[1]!).notes).toEqual([`Runs in ${other}, which is not the session's folder.`]);
  // The form is read once for a card that waits: the same object again.
  const a = g.approvals({ session: "s1", pending: true })[0]!;
  expect(g.form(a)).toBe(g.form(g.approval(a.id)!));
});

import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../core/bus.ts";
import { Store } from "../core/store.ts";
import type { Session } from "../core/types.ts";
import type { ToolCall } from "../engine/hooks.ts";
import type { Tool } from "../tools/types.ts";
import { cardForm, cardLines, CLIENTS, fromSaid, holdSaid, oneLine, refusal, SHORT_MAX, TEXT_MAX, type Client, type Hold } from "./card.ts";
import * as daemon from "./chars.ts";
import { Gate, type Approval } from "./gate.ts";
import * as page from "../../ui/src/lib/hidden-chars.ts";

const base: Pick<Approval, "id" | "session_id" | "call_id" | "state" | "suggest" | "created"> = { id: "a1", session_id: "s1", call_id: "c1", state: "pending", suggest: [], created: 1 };
const shell = (command: string, more: Partial<Approval> = {}): Approval => ({ ...base, tool: "Bash", kind: "shell", summary: command, input: { command }, risk: "low", ...more });
const lines41 = Array.from({ length: 41 }, (_, i) => `echo step ${i + 1}`).join("\n");

// Every shape of card a client can be given, with the text it must carry and why it is held.
const SHAPES: { name: string; a: Approval; hold: Hold[]; text?: (t: string) => boolean; cut?: true }[] = [
  { name: "a short command", a: shell("npm test"), hold: [] },
  { name: "a command of exactly 160 plain characters", a: shell("x".repeat(SHORT_MAX)), hold: [] },
  { name: "a command of 161 characters", a: shell("x".repeat(SHORT_MAX + 1)), hold: ["long"] },
  { name: "a command of two lines", a: shell("cd /srv\nrm -rf build"), hold: ["long"] },
  { name: "a command with a tab", a: shell("echo a\tb"), hold: ["long"] },
  { name: "a 41-line command", a: shell(lines41), hold: ["long"], text: (t) => t === lines41 },
  { name: "a command with a right-to-left override", a: shell("echo txt.r \u202e< x.txt"), hold: ["long", "marked"] },
  { name: "a command with a zero-width space", a: shell("curl exam\u200bple.com"), hold: ["long", "marked"] },
  { name: "a command with a look-alike letter", a: shell("curl ex\u0430mple.com"), hold: ["long", "marked"] },
  { name: "a command with letters written right to left", a: shell("cp \u05d0 \u05d1"), hold: ["long", "marked"] },
  { name: "a high-risk one-liner", a: shell("sudo reboot", { risk: "high", why: "the command runs as root" }), hold: ["risk"] },
  { name: "a card only the owner answers", a: shell("git push", { once: true }), hold: ["risk"] },
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
    a: { ...base, tool: "Write", kind: "edit", summary: "/w/big.txt", input: { _clipped: '{"file_path":"/w/big.txt","content":"aaaa' }, input_len: 50_000, risk: "low" },
  },
  { name: "a tool call with a small input", a: { ...base, tool: "fetch", kind: "other", summary: '{"url":"https://example.com"}', input: { url: "https://example.com" }, risk: "low" }, hold: [] },
  {
    name: "a tool call shown in part", hold: ["long"], text: (t) => t.includes('"tail": "END"'),
    a: { ...base, tool: "mcp__db__query", kind: "other", summary: JSON.stringify({ sql: "s".repeat(600), tail: "END" }).slice(0, 400), cut: true, input: { sql: "s".repeat(600), tail: "END" }, risk: "low" },
  },
  {
    name: "a tool call the gate kept only the start of", hold: ["long", "cut"], cut: true,
    a: { ...base, tool: "mcp__db__query", kind: "other", summary: "x".repeat(400), cut: true, input: { _clipped: "x".repeat(20_000) }, input_len: 90_000, risk: "low" },
  },
  { name: "a message to another session", a: { ...base, tool: "session_send", kind: "drive", summary: "to Docs: rebuild the index", input: { to: "s2", text: "rebuild the index" }, risk: "low" }, hold: [] },
];

test("one form: every shape carries the whole text, whether it is cut, and why it is held", () => {
  for (const s of SHAPES) {
    const f = cardForm(s.a);
    expect([s.name, f.hold]).toEqual([s.name, s.hold]);
    expect([s.name, !!f.cut]).toEqual([s.name, !!s.cut]);
    expect([s.name, f.chars, f.lines]).toEqual([s.name, f.text.length, f.text.replace(/\n$/, "").split("\n").length]);
    if (s.text) expect([s.name, s.text(f.text)]).toEqual([s.name, true]);
    // The marks are read from the text the form carries, so every client is told the same.
    expect(f.marks).toEqual(daemon.marksOf(f.text));
    expect(f.hold.includes("marked")).toBe(daemon.marked(f.marks));
  }
  // What is cut says how long the whole was, when that is known.
  expect(cardForm(shell("a".repeat(TEXT_MAX + 50)))).toMatchObject({ cut: true, total: TEXT_MAX + 50, chars: TEXT_MAX });
  expect(cardForm(SHAPES.find((s) => s.name === "an edit the gate kept only the start of")!.a).total).toBe(50_000);
  // Risk, the reason, where it runs and what may be answered.
  const high = cardForm(shell("sudo reboot", { risk: "high", why: "the command runs as root", notice: "Reviewer unavailable." }), { name: "desk" });
  expect(high).toMatchObject({ risk: "high", reason: "High risk: the command runs as root. Reviewer unavailable.", machine: { name: "desk", far: false }, choices: ["once", "deny"] });
  const far = cardForm({ ...shell("uptime"), input: { command: "uptime", machine: "build\u202ebox", cwd: "/srv" } }, { name: "desk" });
  expect(far.machine).toEqual({ name: "build<U+202E>box", cwd: "/srv", far: true });
  expect(cardForm(shell("npm test"), { name: "rig", far: true }).machine).toEqual({ name: "rig", far: true });
  expect(cardForm(shell("npm test", { suggest: [{ kind: "shell", pattern: "npm test" }] })).choices).toEqual(["once", "session", "always", "deny"]);
});

test("the hold rule: every card shape by every client kind", () => {
  // A client's word is the same whoever gives it: the table is what each kind of client sends.
  const ANSWERS: { by: Client | "old phone app"; seen?: "whole"; note: string }[] = [
    { by: "page", seen: "whole", note: "its card's own latch was satisfied" },
    { by: "page", note: "a home row's inline Allow once" },
    { by: "phone", seen: "whole", note: "the app showed the whole text" },
    { by: "old phone app", note: "sends no seen" },
    { by: "notification", note: "one line: never seen" },
    { by: "cli", seen: "whole", note: "y at the terminal, or --yes --seen" },
    { by: "cli", note: "--yes alone" },
    { by: "script", seen: "whole", note: "a program handed the whole input" },
    { by: "acp", seen: "whole", note: "the request carried the whole text" },
    { by: "acp", note: "a daemon without the form" },
    { by: "api", note: "a caller that says nothing" },
  ];
  for (const s of SHAPES) {
    const f = cardForm(s.a);
    for (const c of ANSWERS) {
      for (const choice of ["once", "session", "always"]) {
        const refused = refusal(f, choice, c.seen);
        // Allowed without a word only when one line shows all of it: short, whole, unmarked, low risk.
        const expected = s.hold.length > 0 && c.seen !== "whole";
        expect([s.name, c.by, c.note, choice, refused !== null]).toEqual([s.name, c.by, c.note, choice, expected]);
        if (refused) expect(refused.startsWith("Open the request to read it first: ")).toBe(true);
      }
      // A deny is taken from anywhere at once.
      expect(refusal(f, "deny", c.seen)).toBeNull();
    }
  }
  // Only the exact word counts.
  for (const seen of [true, "yes", "part", 1, {}]) expect(refusal(cardForm(shell(lines41)), "once", seen)).not.toBeNull();
  expect(holdSaid(cardForm(shell(lines41)))).toBe("Open the request to read it first: it is 41 lines long.");
  expect(holdSaid(cardForm(shell("x".repeat(200))))).toBe("Open the request to read it first: it is 200 characters on one line.");
  expect(holdSaid(cardForm(shell("sudo reboot", { risk: "high" })))).toBe("Open the request to read it first: it is high risk.");
  expect(holdSaid(cardForm(shell("npm test")))).toBe("");
  // The home row's inline Allow once and a notification's Allow are this one test.
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
  expect(cardLines(cardForm(shell("a".repeat(TEXT_MAX + 50)))).notes).toEqual([`Only its start is kept: ${TEXT_MAX} of ${TEXT_MAX + 50} characters.`]);
  expect(cardLines(cardForm(shell(lines41))).head).toBe("Bash, 41 lines");
});

test("who answered, in words: no address and no key", () => {
  expect(fromSaid({ client: "phone", device: "Pixel 8", seen: "whole" })).toBe("the phone (Pixel 8), its text shown whole");
  expect(fromSaid({ client: "notification", device: "Pixel 8" })).toBe("a notification (Pixel 8)");
  expect(fromSaid({ client: "page", peer: "studio", seen: "whole" })).toBe("the page on studio, its text shown whole");
  expect(CLIENTS.map((c) => fromSaid({ client: c }))).toEqual(["the page", "the phone", "a notification", "the command line", "a script", "an editor", "the API"]);
  expect(fromSaid(undefined)).toBe("");
});

// The page spells and marks characters with its own copy of this logic until it reads the daemon's:
// the two must say the same of every text.
test("the page's reading of hidden characters and the daemon's agree", () => {
  const TEXTS = [
    "npm test", "echo txt.r \u202e< x.txt", "a\u200bb\u00a0c\u2028d", "ex\u0430mple \uff52m e\u0301", "cp \u05d0 1 2 \u05d1 > \u05d2", "tab\there\nnext",
    "\u001b[31mred", "\u3164filler\ufe0f", "\ufffc \u2800", "plain ascii ~!@#", "\u0645\u0631\u062d\u0628\u0627 hello",
  ];
  const both = Object.keys(page).filter((k) => typeof (daemon as any)[k] === "function" && typeof (page as any)[k] === "function");
  expect(both).toEqual(expect.arrayContaining(["plainAscii", "hasRtl", "hasHidden", "spellHidden"]));
  for (const f of both) for (const t of TEXTS) expect([f, t, (daemon as any)[f](t)]).toEqual([f, t, (page as any)[f](t)]);
  expect(daemon.spelled("a\u202eb\nc")).toBe("a<U+202E>b\nc");
  expect(daemon.marksOf("a\u200b\u202e \u05d0 \u0430\n\t")).toEqual({ hidden: 2, rtl: true, alike: [{ shown: "\u0430", code: "U+0430" }] });
});

// The rule in the gate itself: whatever route an answer comes by.
test("the gate holds an allow of a text that was not shown, takes a deny at once, and keeps who answered", async () => {
  const g = new Gate(new Store(mkdtempSync(join(tmpdir(), "keel-card-"))), new Bus(), () => false);
  const session = { id: "s1", workspace: mkdtempSync(join(tmpdir(), "keel-ws-")) } as Session;
  const bash: Tool = { name: "Bash", readOnly: false, kind: "shell", description: "", input_schema: { type: "object", properties: { command: {} } }, run: async () => ({ content: "" }) };
  const call = (command: string): ToolCall => ({ id: crypto.randomUUID(), tool: bash, input: { command }, ctx: { sessionId: "s1", cwd: session.workspace, signal: new AbortController().signal, spillDir: session.workspace, seen: new Map() } });
  g.machineOf = () => ({ name: "desk" });
  g.setPerm("s1", { mode: "ask", sandbox: "off" });
  const asked = [g.beforeTool(session, call(`node build.js\n${lines41}`)), g.beforeTool(session, call("node check.js")), g.beforeTool(session, call(`node clean.js\n${lines41}`))];
  await Bun.sleep(30);
  const [long, short, other] = g.approvals({ session: "s1", pending: true });
  expect([g.form(long!).hold, g.form(short!).hold, g.form(long!).machine]).toEqual([["long"], [], { name: "desk", far: false }]);

  // A long card: no allow without the word, by any choice, from any client. It stays open.
  for (const choice of ["once", "session", "always"] as const) {
    expect(g.resolve(long!.id, "s1", { choice, by: { client: "phone", device: "Pixel" } })).toMatchObject({ status: 409, hold: ["long"], error: "Open the request to read it first: it is 42 lines long." });
  }
  expect(g.approval(long!.id)).toMatchObject({ state: "pending" });
  // Several at once are held the same way, each by itself.
  expect(g.resolveMany("s1", [long!.id, short!.id], undefined, { by: { client: "api" } })).toEqual({ results: [expect.objectContaining({ id: long!.id, status: 409 }), { id: short!.id, ok: true }] });
  expect(g.approval(short!.id)).toMatchObject({ state: "allowed", choice: "once", by: { client: "api" } });
  // With the word it is taken, and the card keeps who gave it and how.
  expect(g.resolve(long!.id, "s1", { choice: "once", seen: "whole", by: { client: "phone", device: "Pixel" } })).toEqual({ ok: true });
  expect(g.approval(long!.id)).toMatchObject({ state: "allowed", choice: "once", by: { client: "phone", device: "Pixel", seen: "whole" } });
  // A deny needs nothing.
  expect(g.resolve(other!.id, "s1", { choice: "deny", by: { client: "notification", device: "Pixel" } })).toEqual({ ok: true });
  expect(g.approval(other!.id)).toMatchObject({ state: "denied", by: { client: "notification", device: "Pixel" } });
  expect(await Promise.all(asked)).toEqual([undefined, undefined, expect.objectContaining({ deny: expect.any(String) })]);
});

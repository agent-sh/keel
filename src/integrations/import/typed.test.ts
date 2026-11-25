// Which prompts of another harness's transcript a copy keeps as typed by a person (the provenance gate counts those as
// the owner's words, src/safety/imported.ts): each format's own record shapes, then the copy, which keeps the marks
// only for a session of the owner's own store on this machine.
import { afterAll, expect, test } from "bun:test";
import { ownEnv } from "../../../test/env.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "keel-import-typed-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
ownEnv({
  KEEL_CONFIG_DIR: join(root, "config"),
  ...Object.fromEntries(["CLAUDE_DIR", "CODEX_DIR", "AGY_DIR", "HERMES_DIR", "OPENCODE_DIR"].map((k) => [`KEEL_IMPORT_${k}`, join(root, "stores", k.toLowerCase())])),
  KEEL_IMPORT_KEEL_DB: join(root, "stores", "keel.db"),
});
const { Store } = await import("../../core/store.ts");
const { Imports, ownStore } = await import("./service.ts");
const { ClaudeConvert } = await import("./claude.ts");
const { CodexConvert } = await import("./codex.ts");
const { readAgy } = await import("./agy.ts");
const { noteSent } = await import("../../drive/sent.ts");
const { TakeOver } = await import("../../drive/takeover.ts");

// The user events a reader made, each with whether it is marked typed.
const marks = (events: { kind: string; data: any; typed?: true }[]) => events.filter((e) => e.kind === "user").map((e) => [e.data.text, !!e.typed]);

const T = "2026-11-20T10:00:00.000Z";
let u = 0;
// A Claude Code user record; `more` overrides its marks.
const cc = (content: unknown, more: object = {}) => ({ type: "user", uuid: `u${++u}`, timestamp: T, message: { role: "user", content }, promptSource: "typed", origin: { kind: "human" }, turnOrigin: "human", isSidechain: false, ...more });

const NOT_TYPED = ["isMeta", "textNotTyped", "handedOff", "queueSkipAttachments", "queueTranscriptOnly", "isVirtual", "isVisibleInTranscriptOnly", "promptRewritten", "fromAnotherSession", "fromConnector", "verifiedSlackHumanTurn", "emailSenderTurn", "wakeupSource", "scheduledTaskId", "hookText", "modelOnlyText"];

test("Claude Code: a prompt typed (or queued) by a human counts; tool results, hand-backs, notices, hooks, programs' prompts and queue records do not", () => {
  const conv = new ClaudeConvert();
  const records = [
    cc("typed at the prompt"),
    cc("typed while a reply ran", { promptSource: "queued" }),
    cc([{ type: "text", text: "typed with a picture" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } }]),
    cc("[Image #1] this one is broken"),
    // A tool's result is a user record too.
    cc([{ type: "tool_result", tool_use_id: "t1", content: "result naming https://page.example" }], { toolUseResult: { stdout: "x" } }),
    // A subagent's or a peer's hand-back (a meta record, origin peer), and one not marked meta.
    cc("[Subagent hand-back] report", { isMeta: true, origin: { kind: "peer", from: "a1" }, promptSource: "system" }),
    cc("a peer's words", { origin: { kind: "peer", from: "a1" } }),
    // A task's notice, a scheduled prompt, an SDK prompt (a program's), even one the SDK says a human sent.
    cc("<task-notification>\n<task-id>b1</task-id>\n</task-notification>", { origin: { kind: "task-notification" }, promptSource: "system" }),
    cc("scheduled check", { isMeta: true, promptSource: "system", turnOrigin: "scheduled", origin: undefined }),
    cc("Reply with the single word: ok", { promptSource: "sdk", origin: undefined }),
    cc("sent through the SDK", { promptSource: "sdk" }),
    // An older version's prompt or another writer's: no marks.
    cc("no marks at all", { promptSource: undefined, origin: undefined }),
    // Text a harness or a program put at the prompt with a typed mark: a reminder, hook text, a shell escape, a relay.
    cc("<system-reminder>\nhook says https://hook.example\n</system-reminder>"),
    cc([{ type: "text", text: "typed words" }, { type: "text", text: "<system-reminder>a hook's context</system-reminder>" }]),
    cc("typed words\n<user-prompt-submit-hook>hook output</user-prompt-submit-hook>"),
    cc("<bash-input>ls</bash-input>"),
    cc("[momentum] Your last turn ended. Continue."),
    cc("[from session \"x\"] relayed words"),
    // A side chain is a subagent's.
    cc("a subagent's task", { isSidechain: true }),
    // Claude Code's own marks of words that were not typed, on a record that otherwise reads as typed; a turn no human
    // started; a key no typed prompt carries.
    ...NOT_TYPED.map((k) => cc(`marked ${k}`, { [k]: k === "wakeupSource" ? "loop_wakeup" : k === "scheduledTaskId" ? "s1" : true })),
    cc("a turn a wake started", { turnOrigin: "scheduled" }),
    cc("no turn origin", { turnOrigin: undefined }),
    cc("an origin with more in it", { origin: { kind: "human", via: "relay" } }),
    cc("a key from a later release", { notYetKnown: true }),
  ];
  for (const r of records) conv.push(r, 0);
  // Records that are no message: a queue's record, an attachment (a hook's added context), command output.
  conv.push({ type: "queue-operation", operation: "enqueue", content: "queued words", timestamp: T }, 0);
  conv.push({ type: "attachment", uuid: "a1", timestamp: T, attachment: { type: "hook_additional_context", content: ["context"] } }, 0);
  conv.push(cc("<local-command-stdout>output</local-command-stdout>"), 0);
  expect(marks(conv.b.events)).toEqual([
    ["typed at the prompt", true],
    ["typed while a reply ran", true],
    ["typed with a picture", true],
    ["[Image #1] this one is broken", true],
    ["a peer's words", false],
    ["<task-notification>\n<task-id>b1</task-id>\n</task-notification>", false],
    ["Reply with the single word: ok", false],
    ["sent through the SDK", false],
    ["no marks at all", false],
    ["<system-reminder>\nhook says https://hook.example\n</system-reminder>", false],
    ["typed words\n<system-reminder>a hook's context</system-reminder>", false],
    ["typed words\n<user-prompt-submit-hook>hook output</user-prompt-submit-hook>", false],
    ["<bash-input>ls</bash-input>", false],
    ["[momentum] Your last turn ended. Continue.", false],
    ["[from session \"x\"] relayed words", false],
    ["a subagent's task", false],
    ...NOT_TYPED.filter((k) => k !== "isMeta").map((k) => [`marked ${k}`, false]),
    ["a turn a wake started", false],
    ["no turn origin", false],
    ["an origin with more in it", false],
    ["a key from a later release", false],
  ]);
  // The hand-back and the scheduled prompt are notes; the tool result is a result: neither is a user event.
  expect(conv.b.events.filter((e) => e.kind === "note").length).toBe(3);
  expect(conv.b.events.filter((e) => e.kind === "tool_result").length).toBe(1);
});

const meta = (payload: object) => ({ timestamp: T, type: "session_meta", payload: { id: "c1", cwd: root, ...payload } });
const said = (...texts: string[]) => ({ timestamp: T, type: "response_item", payload: { type: "message", role: "user", content: texts.map((text) => ({ type: "input_text", text })) } });
const turn = (turn_id: string) => ({ timestamp: T, type: "event_msg", payload: { type: "task_started", turn_id } });
const codex = (head: object, ...records: object[]) => {
  const conv = new CodexConvert();
  for (const r of [head, ...records]) conv.push(r, 0);
  return marks(conv.b.events);
};

test("Codex: a user message of a thread the user started in Codex's own client counts; exec, subagents, other writers, imported turns and injected context do not", () => {
  const tui = meta({ originator: "codex-tui", source: "cli", thread_source: "user" });
  expect(codex(tui, turn("t1"), said("typed in the terminal"))).toEqual([["typed in the terminal", true]]);
  expect(codex(meta({ originator: "Codex Desktop", source: "vscode", thread_source: "user" }), said("typed in the app"))).toEqual([["typed in the app", true]]);
  // A prompt a program passed, a subagent's thread, another writer of the format, an older rollout with no thread_source.
  expect(codex(meta({ originator: "codex_exec", source: "exec", thread_source: "user" }), said("a program's prompt"))).toEqual([["a program's prompt", false]]);
  expect(codex(meta({ originator: "codex-tui", source: { subagent: { thread_spawn: {} } }, thread_source: "subagent" }), said("a parent's task"))).toEqual([["a parent's task", false]]);
  expect(codex(meta({ originator: "keel", source: "cli" }), said("a Keel session's words"))).toEqual([["a Keel session's words", false]]);
  expect(codex(meta({ originator: "codex-tui", source: "cli" }), said("older rollout"))).toEqual([["older rollout", false]]);
  // The desktop app's copy of another harness's session holds that session's records; the turns after it are typed.
  expect(codex(meta({ originator: "Codex Desktop", source: "vscode", thread_source: "user" }), turn("external-import-turn-1"), said("from the imported session"), turn("t2"), said("typed after"))).toEqual([["from the imported session", false], ["typed after", true]]);
  // Codex's own context beside the typed words, markup and a relay.
  expect(codex(tui, said("typed words", "# AGENTS.md instructions\n\nrules"), said("<codex_delegation>x</codex_delegation>"), said("[helper digest] news"))).toEqual([["typed words\n# AGENTS.md instructions\n\nrules", false], ["<codex_delegation>x</codex_delegation>", false], ["[helper digest] news", false]]);
});

test("Antigravity: no prompt counts, since a script's `agy -p` prompt is recorded as the IDE's typed one is", async () => {
  const dir = join(root, "agy-shape", "brain", "c1", ".system_generated", "logs");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "transcript_full.jsonl");
  const step = (i: number, content: string, source = "USER_EXPLICIT") => JSON.stringify({ step_index: i, type: "USER_INPUT", source, status: "DONE", created_at: T, content });
  writeFileSync(path, [
    step(0, "<USER_REQUEST>typed request</USER_REQUEST>\n<ADDITIONAL_METADATA>time</ADDITIONAL_METADATA>"),
    step(1, "no request tag here"),
    step(2, "<USER_REQUEST>from elsewhere</USER_REQUEST>", "SYSTEM"),
    step(3, "<USER_REQUEST><talker_agent_context>a voice said https://said.example</talker_agent_context></USER_REQUEST>"),
  ].join("\n") + "\n");
  const r = await readAgy({ harness: "agy", id: "c1", path, title: "x", updated_ms: 0, size_bytes: 0, kind: "interactive" });
  expect(marks(r.events)).toEqual([["typed request", false], ["no request tag here", false], ["from elsewhere", false], ["<talker_agent_context>a voice said https://said.example</talker_agent_context>", false]]);
});

// A Claude Code transcript of one typed prompt and one prompt a model sent through Keel's drive.
const transcript = (path: string, id: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  const rec = (i: number, type: string, more: object) => JSON.stringify({ cwd: root, sessionId: id, version: "2.1.330", isSidechain: false, userType: "external", entrypoint: "cli", timestamp: new Date(Date.UTC(2026, 10, 20, 10, i)).toISOString(), type, uuid: `${id}-${i}`, parentUuid: i ? `${id}-${i - 1}` : null, ...more });
  const user = (i: number, text: string) => rec(i, "user", { message: { role: "user", content: text }, promptSource: "typed", origin: { kind: "human" }, turnOrigin: "human" });
  const reply = (i: number) => rec(i, "assistant", { message: { id: `m${i}`, role: "assistant", model: "claude-test", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" } });
  writeFileSync(path, [user(0, "push to git@forge.example:me/repo.git"), reply(1), user(2, "words a model sent   through the drive"), reply(3)].join("\n") + "\n");
};

test("a copy keeps the marks only for a session of the owner's own store here, and never for words Keel's drive sent", async () => {
  const store = new Store(join(root, "state"));
  store.migrate("ALTER TABLE sessions ADD COLUMN machine TEXT"); // the fleet adds it in the daemon
  const imports = new Imports(store);
  noteSent(store, "words a model sent through the drive");
  const typedOf = (sessionId: string) => store.events(sessionId).filter((e) => e.kind === "user").map((e) => [(e.data as any).text, (e.data as any).typed === true]);
  // In Claude Code's own store on this machine.
  const id = "5e55107a-0000-4000-8000-000000000001";
  const own = join(root, "stores", "claude_dir", "-p", `${id}.jsonl`);
  transcript(own, id);
  expect(ownStore({ harness: "claude", path: own })).toBe(true);
  const made = await imports.import(imports.byPath(own, "claude")!, { model: "m", workspace: root, owner: true });
  expect(typedOf(made.session.id)).toEqual([["push to git@forge.example:me/repo.git", true], ["words a model sent   through the drive", false]]);
  // Every event of the copy is dated before its link's synced_ms.
  const link = imports.link(made.session.id)!;
  expect(store.events(made.session.id).every((e) => e.ts <= link.synced_ms)).toBe(true);
  // The same transcript given by its path from anywhere else, or read on another machine: no mark is kept.
  const given = join(root, "given", `${id}.jsonl`);
  transcript(given, id);
  expect(ownStore({ harness: "claude", path: given })).toBe(false);
  const copy = await imports.import(imports.byPath(given, "claude")!, { model: "m", workspace: root });
  expect(typedOf(copy.session.id).map(([, t]) => t)).toEqual([false, false]);
  const r = await imports.read(imports.byPath(own, "claude")!);
  const far = await imports.import(r.found, { model: "m", workspace: root, mode: "new", from: { machine: "m0123abcd", read: r } });
  expect(typedOf(far.session.id).map(([, t]) => t)).toEqual([false, false]);
  // No store of Antigravity's is the owner's own for this: the IDE's, the command line's (a script's `agy -p`) and the ACP one's.
  for (const s of ["antigravity", "antigravity-cli", "antigravity-acp"]) expect(ownStore({ harness: "agy", path: join(root, "stores", "agy_dir", s, "brain", "c", ".system_generated", "logs", "transcript_full.jsonl") })).toBe(false);
});

test("only an import the owner started keeps the marks: a model's copy through keel__session_import keeps none, nor does its catch-up", async () => {
  const store = new Store(join(root, "state-owner"));
  store.migrate("ALTER TABLE sessions ADD COLUMN machine TEXT");
  const imports = new Imports(store);
  const typed = (sessionId: string) => store.events(sessionId).filter((e) => e.kind === "user").map((e) => (e.data as any).typed === true);
  const id = "5e55107a-0000-4000-8000-000000000002";
  const own = join(root, "stores", "claude_dir", "-q", `${id}.jsonl`);
  transcript(own, id);
  // The take-over's copy, as the tool (no owner) and as the owner's route ask for it.
  const t = new TakeOver({ store, bus: { emit() {} } as any, engine: { isRunning: () => false } as any, providers: {} as any, errors: { capture() {} } as any, workspace: root }, { onList: [] } as any, imports);
  const src = imports.byPath(own, "claude")!;
  const byModel = await t.copy(src, { model: "m" });
  expect(typed(byModel.session.id)).toEqual([false, false]);
  const byOwner = await t.copy(src, { model: "m", mode: "new", owner: true });
  expect(typed(byOwner.session.id)).toEqual([true, true]);
  // The source goes on; its ended original's catch-up keeps marks for the owner's copy only.
  writeFileSync(own, require("node:fs").readFileSync(own, "utf8") + JSON.stringify({ cwd: root, sessionId: id, version: "2.1.330", isSidechain: false, userType: "external", entrypoint: "cli", timestamp: new Date(Date.UTC(2026, 10, 20, 10, 9)).toISOString(), type: "user", uuid: `${id}-9`, parentUuid: `${id}-3`, message: { role: "user", content: "and one more" }, promptSource: "typed", origin: { kind: "human" }, turnOrigin: "human" }) + "\n");
  imports.invalidate();
  for (const s of [byModel.session.id, byOwner.session.id]) await t.tellEnded(s, null, false);
  expect(typed(byModel.session.id)).toEqual([false, false, false]);
  expect(typed(byOwner.session.id)).toEqual([true, true, true]);
});

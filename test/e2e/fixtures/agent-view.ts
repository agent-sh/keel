#!/usr/bin/env bun
// A stand-in agent view for the drive e2e: the verbs Keel calls (`list -a
// --json`, `rpc`), over a JSON state file the test writes. Usage:
//   agent-view.ts <state.json> list -a --json
//   agent-view.ts <state.json> rpc            (request on stdin)
// State: { agents: Row[], prompts: { key: card }, screens: { key: lines }, queue: [], answers: [], last?: { key: records }, no_stop?: true }
// A Claude Code row with `answers: true` and a transcript stands for the terminal that has it open: a text
// queued for it is written to its transcript as the prompt typed there, and a reply follows, as Claude Code
// in that terminal would write them.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const [file, verb] = [process.argv[2]!, process.argv[3]];
const state = JSON.parse(readFileSync(file, "utf8"));
const save = () => writeFileSync(file, JSON.stringify(state, null, 2));
const key = (a: any) => a.job || a.thread || a.session || a.pane || a.name;
const identity = (a: any) => ({ tool: a.tool, key: key(a), live: !!a.live, session: a.session ?? "" });

if (verb === "list") {
  console.log(JSON.stringify(state.agents.map((a: any) => ({ ...a, remote_identity: null }))));
  process.exit(0);
}
if (verb !== "rpc") {
  console.error(`unknown verb ${verb}`);
  process.exit(2);
}
const req = JSON.parse(await Bun.stdin.text());
const reply = (result: unknown) => console.log(JSON.stringify({ version: 1, ok: true, result }));
const error = (e: string) => console.log(JSON.stringify({ version: 1, ok: false, error: e }));
if (req.op === "snapshot") {
  reply({ agents: state.agents.map((a: any) => ({ ...a, remote_identity: identity(a) })), observed: Date.now() / 1000 });
  process.exit(0);
}
const a = state.agents.find((x: any) => key(x) === req.key);
if (!a) {
  error("Session is no longer available");
  process.exit(0);
}
if (req.op === "live") reply({ ansi: true, lines: (state.screens?.[req.key] ?? []).slice(-(req.lines ?? 40)) });
else if (req.op === "attention") reply(state.prompts?.[req.key] ?? null);
else if (req.op === "answer") {
  const card = state.prompts?.[req.key];
  if (!card || card.id !== req.id) error("That request changed or expired; read the current card");
  else {
    state.answers.push({ key: req.key, id: req.id, choice: req.choice });
    delete state.prompts[req.key];
    save();
    reply(`Answer submitted to ${a.name}`);
  }
} else if (req.op === "enqueue") {
  if (req.identity && JSON.stringify(req.identity) !== JSON.stringify(identity(a))) error("Session identity changed");
  else {
    const id = `r${state.queue.length + 1}`;
    state.queue.push({ id, key: req.key, body: req.body });
    save();
    if (a.answers && a.transcript) {
      const lines = readFileSync(a.transcript, "utf8").trim().split("\n");
      let parent = (() => { try { return JSON.parse(lines[lines.length - 1]!).uuid ?? null; } catch { return null; } })();
      const write = (r: object) => {
        const uuid = crypto.randomUUID();
        appendFileSync(a.transcript, JSON.stringify({ parentUuid: parent, isSidechain: false, userType: "external", cwd: a.cwd, sessionId: a.session, version: "2.1.332", entrypoint: "cli", timestamp: new Date().toISOString(), uuid, ...r }) + "\n");
        parent = uuid;
      };
      // (Claude Code records what is pasted at its prompt as typed there.)
      write({ type: "user", message: { role: "user", content: req.body }, promptSource: "typed", turnOrigin: "human", origin: { kind: "human" } });
      write({ type: "assistant", message: { id: `m-${id}`, role: "assistant", model: a.model || "claude-opus-5-5", content: [{ type: "text", text: `Answered in the terminal: ${req.body}` }], stop_reason: "end_turn" } });
    }
    reply({ id, state: "submitted", detail: a.live ? "pasted into its terminal" : "resumed with the text" });
  }
} else if (req.op === "stop" && !state.no_stop && !a.no_stop) {
  // Ends the session the way its harness ends, after it writes its last lines
  // (`last[key]`: transcript records appended as it exits).
  if (req.identity && JSON.stringify(req.identity) !== JSON.stringify(identity(a))) error("Session identity changed");
  else if (!a.live) error("Session already ended");
  else {
    if (a.transcript && state.last?.[req.key]) appendFileSync(a.transcript, state.last[req.key].map((r: unknown) => JSON.stringify(r) + "\n").join(""));
    Object.assign(a, { live: false, state: "ended", label: "ended" });
    (state.stopped ??= []).push(req.key);
    save();
    reply({ how: a.tool === "codex" ? "/quit typed into its pane" : "/exit typed into its pane" });
  }
} else error("Unsupported RPC operation");

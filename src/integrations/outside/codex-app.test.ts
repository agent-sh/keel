// A Codex session answered in place, against the stand-in of `codex app-server` (test/e2e/fixtures/codex-app-server.ts)
// over a scratch Codex home the mirror watches: a send resumes the thread with its own provider, folder, approval
// policy and sandbox, the reply streams as deltas, the command Codex asks about is a one-call card, the answer goes
// back, the rollout holds the message and the reply, and the child is gone after the turn. A question is a question
// card. A session another process holds takes nothing. After a restart a send is looked for in the rollout.
import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../core/store.ts";
import { Bus } from "../../core/bus.ts";
import type { Frame, Holder } from "../../core/types.ts";
import { ownEnv } from "../../../test/env.ts";
import { answer, allPendingQuestions } from "../../tools/interact.ts";
import { Outside } from "./service.ts";
import { OUTSIDE_DEFAULTS } from "./settings.ts";
import { Gate } from "../../safety/gate.ts";
import { homeDir } from "../../core/paths.ts";
import { descendants, lockHolder, readLocks, statFields } from "./writer.ts";
import { CodexApp, commandWords, holdsMessage, lastRecord, permissionLines, recordsFrom, threadFacts, turnEnded, type CardGate } from "./codex-app.ts";

const top = mkdtempSync(join(tmpdir(), "keel-codex-app-"));
ownEnv({ KEEL_IMPORT_CODEX_DIR: undefined, KEEL_IMPORT_CLAUDE_DIR: undefined });
afterAll(() => rmSync(top, { recursive: true, force: true }));
const STANDIN = join(import.meta.dir, "../../../test/e2e/fixtures/codex-app-server.ts");
const LAUNCHER = join(import.meta.dir, "../../../test/e2e/fixtures/codex-launcher.ts");
// What reads processes here: /proc with each thread's children file (Linux, CONFIG_PROC_CHILDREN). Elsewhere those
// tests are skipped by name.
const PROC = existsSync(`/proc/self/task/${process.pid}/children`) && existsSync("/proc/locks");

const until = async <T>(f: () => T | undefined | false, ms = 8000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(20);
  }
};

let k = 0;
function rig(opts: { holder?: () => Holder | undefined; realGate?: boolean; locks?: false; bin?: string } = {}) {
  const dir = join(top, String(k++));
  const codex = join(dir, "codex");
  const cwd = join(dir, "work");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(dir, "claude"), { recursive: true });
  process.env.KEEL_IMPORT_CODEX_DIR = codex;
  process.env.KEEL_IMPORT_CLAUDE_DIR = join(dir, "claude");
  const now = new Date();
  const day = join(codex, "sessions", String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0"));
  mkdirSync(day, { recursive: true });
  // A Codex that keeps writer locks (0.172 and later): their folder is there.
  if (opts.locks !== false) mkdirSync(join(codex, "thread-writer-locks"), { recursive: true });
  const store = new Store(join(dir, "state"));
  const bus = new Bus();
  const frames: Frame[] = [];
  bus.on((f) => void frames.push(f));
  const settings = { ...OUTSIDE_DEFAULTS };
  let app: CodexApp | undefined;
  const o = new Outside({ store, bus, workspace: dir, settings: () => settings, viewed: () => true, ours: (id) => !!app?.ours(id) });
  o.start();
  const cards: { name: string; input: any; why: string; shown?: string; notice?: string }[] = [];
  let decide: (name: string) => { deny: string } | void = () => undefined;
  const stub = { askOnce: async (_s, call, name, why, _held, shown, notice) => { cards.push({ name, input: call.input, why, shown, ...(notice ? { notice } : {}) }); return decide(name); }, approvals: () => [], settled: () => {}, harnessAnswers: () => [] } as CardGate;
  let real = opts.realGate ? new Gate(store, bus) : undefined;
  let gate: CardGate = real ?? stub;
  const outside = { row: (id: string) => o.row(id), holderNow: (id: string) => opts.holder?.() ?? o.holderNow(id), retell: (id: string) => o.retell(id) };
  const make = (more: { cutAsks?: () => void } = {}) => (app = new CodexApp({ store, bus, outside, gate: () => gate, bin: () => opts.bin ?? STANDIN, home: () => codex, trouble: (e) => { throw e; }, ...more }));
  make();
  const thread = `019a0000-0000-7000-8000-${String(k).padStart(12, "0")}`;
  const rollout = join(day, `rollout-${now.toISOString().slice(0, 19).replaceAll(":", "-")}-${thread}.jsonl`);
  const rec = (type: string, payload: object) => appendFileSync(rollout, JSON.stringify({ timestamp: new Date().toISOString(), type, payload }) + "\n");
  const done = () => { app?.stop(); o.stop(); store.db.close(); };
  // Written once the day's folder is watched: the mirror follows a rollout that grows while it watches.
  const session = async () => {
    await until(() => (o as any).watchers.has(day));
    rec("session_meta", { id: thread, timestamp: now.toISOString(), cwd, originator: "codex_cli_rs", cli_version: "0.172.0", source: "cli", model_provider: "acme", thread_source: "user" });
    rec("turn_context", { turn_id: "t0", cwd, approval_policy: "on-request", sandbox_policy: { type: "workspace-write" }, model: "gpt-x", summary: "auto" });
    rec("event_msg", { type: "task_started", turn_id: "t0" });
    rec("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "Start the work" }] });
    rec("event_msg", { type: "user_message", message: "Start the work" });
    rec("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "Started." }] });
    rec("event_msg", { type: "task_complete", turn_id: "t0" });
    return until(() => store.sessions({ outside: true }).find((s) => s.outside?.source_id === thread));
  };
  // The gate of the next daemon (its constructor parks every card still open).
  const nextGate = () => (gate = real = new Gate(store, bus));
  return { dir, codex, cwd, store, bus, frames, o, gate: () => real, nextGate, app: () => app!, make, cards, setDecide: (f: typeof decide) => { decide = f; }, thread, rollout, rec, session, done };
}

describe("a Codex session answered in place", () => {
  test("the thread's facts from its rollout; a message found in what Codex wrote", () => {
    const f = threadFacts([{ type: "session_meta", payload: { model_provider: "acme", cwd: "/a" } }], [{ type: "turn_context", payload: { cwd: "/b", approval_policy: "on-request", sandbox_policy: { type: "workspace-write" } } }, { type: "turn_context", payload: { cwd: "/c", approval_policy: "never", sandbox_policy: { type: "danger-full-access" } } }]);
    expect(f).toEqual({ provider: "acme", cwd: "/c", approval: "never", sandbox: "danger-full-access" });
    // A policy this build does not know is left to Codex's own (never guessed looser).
    expect(threadFacts([], [{ type: "turn_context", payload: { approval_policy: { granular: {} }, sandbox_policy: { type: "external-sandbox" } } }])).toEqual({ provider: undefined, cwd: undefined });
    expect(holdsMessage([{ type: "event_msg", payload: { type: "user_message", message: " go on " } }], "go on")).toBe(true);
    expect(holdsMessage([{ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "go on" }] } }], "go on")).toBe(true);
    expect(holdsMessage([{ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "go on" }] } }], "go on")).toBe(false);
  });

  test("a send resumes the thread, streams the reply, asks the command as a card, and the child ends after the turn", async () => {
    const r = rig();
    try {
      const s = await r.session();
      expect(s.outside?.holder).toEqual({ kind: "free" });
      expect(r.app().route(s.id)).toBe("resume");
      const sent = r.app().send(s.id, "fix the build", "k1");
      expect("send" in sent && sent.send.state).toBe("stored");
      // The same key again is the same send: given once.
      const again = r.app().send(s.id, "fix the build", "k1");
      expect("send" in again && "send" in sent && again.send.id === sent.send.id).toBe(true);
      // Keel's child holds it while it works.
      await until(() => r.store.session(s.id)?.outside?.holder?.kind === "keel");
      await until(() => !r.app().ours(s.id), 15_000);
      const text = readFileSync(r.rollout, "utf8");
      expect(text).toContain('"message":"fix the build"');
      expect(text).toContain("The command was allowed: fix the build");
      // One card, for its one command, in the harness's words.
      expect(r.cards).toEqual([{ name: "Codex command", input: { command: "make test", cwd: expect.any(String), item: "c1" }, why: "Codex runs this command in the session if you allow it", shown: undefined, notice: "Codex says: It runs the project's tests" }]);
      // The reply streamed as deltas; nothing was stored as an event of the session by the driver: the mirror stores the rollout's.
      const deltas = r.frames.filter((f): f is Extract<Frame, { t: "delta" }> => f.t === "delta" && f.session_id === s.id).map((f) => f.text).join("");
      expect(deltas).toContain("The command was allowed: fix the build");
      // Resumed with the thread's own provider, folder, approval policy and sandbox.
      const log = readFileSync(`${r.rollout}.standin.log`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
      expect(log.find((m) => m.method === "thread/resume")?.params).toEqual({ threadId: r.thread, excludeTurns: true, modelProvider: "acme", cwd: r.cwd, approvalPolicy: "on-request", sandbox: "workspace-write" });
      expect(log.some((m) => m.method === "thread/unsubscribe")).toBe(true);
      // Delivered: the rollout holds it, and the composer has nothing left to say of it.
      expect(r.app().sends(s.id)).toEqual([]);
      expect(r.store.db.query<{ state: string }, []>("SELECT state FROM outside_sends").all()).toEqual([{ state: "delivered" }]);
      await until(() => r.store.session(s.id)?.outside?.holder?.kind === "free");
      // A denial goes back as Codex's decline.
      r.setDecide(() => ({ deny: "no" }));
      r.app().send(s.id, "try again", "k2");
      await until(() => readFileSync(r.rollout, "utf8").includes("The command was declined: try again"), 15_000);
      await until(() => !r.app().ours(s.id));
    } finally { r.done(); }
  }, 30_000);

  test("a long thread resumes with the policy of its last turn, however far back that turn began", async () => {
    const r = rig();
    try {
      const s = await r.session();
      const filler = (n: number) => { for (let i = 0; i < n; i++) r.rec("event_msg", { type: "agent_message", message: "x".repeat(1000) }); };
      filler(200);
      r.rec("turn_context", { turn_id: "t1", cwd: r.cwd, approval_policy: "never", sandbox_policy: { type: "danger-full-access" }, model: "gpt-x" });
      filler(200);
      r.app().send(s.id, "fix the build", "k1");
      await until(() => !r.app().ours(s.id) && readFileSync(r.rollout, "utf8").includes("The command was allowed: fix the build"), 15_000);
      const log = readFileSync(`${r.rollout}.standin.log`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
      expect(log.find((m) => m.method === "thread/resume")?.params).toMatchObject({ approvalPolicy: "never", sandbox: "danger-full-access" });
    } finally { r.done(); }
  }, 30_000);

  test("a form an MCP server of Codex's asks for is declined, and the bar says so", async () => {
    const r = rig();
    try {
      const s = await r.session();
      r.app().send(s.id, "form please", "k1");
      await until(() => readFileSync(r.rollout, "utf8").includes("The form came back as decline."), 15_000);
      await until(() => !r.app().ours(s.id));
      expect(r.app().notes(s.id)).toEqual(["Codex's MCP server tickets asked for a form, and Keel declined it: forms are not shown here yet. Ask in Codex if it needs one."]);
      const told = r.frames.filter((f): f is Extract<Frame, { t: "feature" }> => f.t === "feature" && f.name === "outside_sends").at(-1);
      expect((told?.data as any)?.notes).toEqual(r.app().notes(s.id));
      // The next send starts clean.
      r.app().send(s.id, "fix the build", "k2");
      expect(r.app().notes(s.id)).toEqual([]);
      await until(() => !r.app().ours(s.id) && readFileSync(r.rollout, "utf8").includes("The command was allowed: fix the build"), 15_000);
    } finally { r.done(); }
  }, 30_000);

  test("a thread whose folder is gone is not resumed elsewhere: its send fails and says why", async () => {
    const r = rig();
    try {
      const s = await r.session();
      rmSync(r.cwd, { recursive: true, force: true });
      r.app().send(s.id, "fix the build", "k1");
      const [failed] = await until(() => { const x = r.app().sends(s.id); return x[0]?.state === "failed" && x; });
      expect(failed!.said).toBe(`its folder ${r.cwd} is gone: Codex would work somewhere else. It did not go`);
      expect(r.app().ours(s.id)).toBe(false);
    } finally { r.done(); }
  });

  test("a file change is the gate's one-call card: the owner's alone, showing the diff Codex will write", async () => {
    const r = rig({ realGate: true });
    try {
      const s = await r.session();
      r.app().send(s.id, "edit the constant", "k1");
      const a = await until(() => r.gate()!.approvals({ session: s.id, pending: true })[0], 15_000);
      // A change in the thread's own folder is no high risk: judged as Keel's own edit there would be.
      expect(a).toMatchObject({ tool: "Codex file change", kind: "edit", once: true, risk: "low", facts: { held: "harness" }, why: "Codex writes these changes if you allow them", notice: "Codex says: It fixes the constant" });
      expect(a.summary).toContain("+const a = 2;");
      expect(a.summary).toContain(join(r.cwd, "a.ts"));
      expect(r.gate()!.resolve(a.id, s.id, { choice: "deny" })).toEqual({ ok: true });
      await until(() => readFileSync(r.rollout, "utf8").includes("The change was declined: edit the constant"), 15_000);
      // The answer is kept by the call's item, for its line in the mirror (the rollout says only what it returned).
      expect(r.app().answers(s.id)).toEqual({ f1: { state: "denied" } });
      await until(() => !r.app().ours(s.id));
    } finally { r.done(); }
  }, 30_000);

  test("a command Codex asks about is judged by the rules Keel's own calls are: high risk only for what is", async () => {
    const r = rig({ realGate: true });
    try {
      const s = await r.session();
      const sess = r.store.session(s.id)!;
      const asks = (id: string, command: string) => {
        const call = { id, tool: { name: "Codex command", kind: "shell", description: "", readOnly: false, input_schema: { properties: { command: {} } }, run: async () => ({ content: "" }) }, input: { command, cwd: r.cwd }, ctx: { sessionId: s.id, cwd: r.cwd, signal: new AbortController().signal, spillDir: "", seen: new Map() } } as any;
        void r.gate()!.askOnce(sess, call, "Codex command", "Codex runs this command", "harness");
        return until(() => r.gate()!.approvals({ session: s.id, pending: true }).find((a) => a.call_id === id));
      };
      const tests = await asks("codex-r-1-1", "make test");
      expect([tests.risk, tests.why]).toEqual(["low", "Codex runs this command"]);
      const wipe = await asks("codex-r-2-2", "rm -rf ~");
      expect(wipe.risk).toBe("high");
      expect(wipe.why).not.toBe("Codex runs this command");
    } finally { r.done(); }
  });

  test("Keel's sandbox never runs what Codex asks: in a sandboxed session its command is judged as one with none", async () => {
    const r = rig();
    try {
      const s = await r.session();
      const sess = r.store.session(s.id)!;
      // A session whose own commands run in Keel's sandbox: what Codex runs is not one of them.
      const g = new Gate(r.store, r.bus, () => true);
      g.setPerm(s.id, { sandbox: "workspace-write" });
      writeFileSync(join(r.cwd, ".env"), "TOKEN=x\n");
      let n = 0;
      const asks = (tool: string, input: any, kind?: "shell" | "edit") => {
        const id = `codex-s-${++n}-${n}`;
        const call = { id, tool: { name: tool, ...(kind ? { kind } : {}), description: "", readOnly: false, input_schema: kind === "shell" ? { properties: { command: {} } } : {}, run: async () => ({ content: "" }) }, input, ctx: { sessionId: s.id, cwd: r.cwd, signal: new AbortController().signal, spillDir: "", seen: new Map() } } as any;
        void g.askOnce(sess, call, tool, "Codex asks", "harness");
        return until(() => g.approvals({ session: s.id, pending: true }).find((a) => a.call_id === id));
      };
      const command = (c: string) => asks("Codex command", { command: c, cwd: r.cwd }, "shell");
      for (const c of ["rm -rf ~/projects", "/bin/bash -lc 'rm -rf ~/projects'", "chmod -R 777 /home/someone", `python3 -c "import shutil; shutil.rmtree('/home/someone')"`, "mv ~/.ssh ~/.ssh.bak"])
        expect([c, (await command(c)).risk]).toEqual([c, "high"]);
      // A credential it reads goes to Codex's provider, not through Keel's vault: the folder's own .env too.
      expect((await command("cat .env")).risk).toBe("high");
      // As Codex sends them, inside its shell's -c: the script is read as a line of its own.
      for (const c of [`cat ${homeDir()}/.ssh/id_ed25519`, `bash -lc 'cat ${homeDir()}/.ssh/id_ed25519'`, "/bin/bash -lc 'cat .env'", `bash -lc 'echo x >> ~/.bashrc'`])
        expect([c, (await command(c)).risk]).toEqual([c, "high"]);
      expect((await command("/bin/bash -lc 'make test'")).risk).toBe("low");
      expect((await command("make test")).risk).toBe("low");
      // A command it does not name, and more permissions, are the owner's to weigh: high.
      expect((await command("")).risk).toBe("high");
      expect((await asks("Codex permissions", { network: { enabled: true } })).risk).toBe("high");
      // A change of several files is judged by each: one in the folder and one that runs at every login is high.
      const mine = join(r.cwd, "a.ts"), rc = join(homeDir(), ".bashrc");
      expect((await asks("Codex file change", { file_path: mine, paths: [mine] }, "edit")).risk).toBe("low");
      expect((await asks("Codex file change", { file_path: mine, paths: [mine, rc] }, "edit")).risk).toBe("high");
    } finally { r.done(); }
  });

  test("each kind of approval Codex asks for says what it is, the host its network asks for, and every entry of a permission", () => {
    expect(commandWords({}, "make test")).toEqual({ name: "Codex command", why: "Codex runs this command in the session if you allow it", judged: "make test" });
    const net = commandWords({ networkApprovalContext: { host: "collect.example.net", protocol: "https" } }, "");
    expect(net).toMatchObject({ name: "Codex command", judged: "", shown: "Codex asks to reach collect.example.net (https)", host: "collect.example.net (https)" });
    expect(commandWords({ networkApprovalContext: { host: "x.example", protocol: "http" } }, "curl x.example").shown).toBe("curl x.example\nCodex asks to reach x.example (http) for it");
    // Typed into a command it runs: weighed as no command, its text shown.
    expect(commandWords({ kind: "writeStdin" }, "y\n")).toMatchObject({ name: "Codex input", judged: "", shown: "Codex types into a command it runs:\ny\n" });
    expect(commandWords({ kind: "humanCommand" }, "deploy")).toMatchObject({ name: "Codex checkpoint", judged: "deploy" });
    expect(permissionLines({ network: { enabled: true }, fileSystem: { write: ["/a"], read: ["/b"], entries: [
      { access: "write", path: { type: "path", path: "/c" } }, { access: "read", path: { type: "glob_pattern", pattern: "**/*.pem" } },
      { access: "write", path: { type: "special", value: { kind: "root" } } }, { access: "deny", path: { type: "special", value: { kind: "project_roots", subpath: "secrets" } } },
    ] }, macos: { x: 1 } })).toEqual(["the network", "write to /a", "read /b", "write to /c", "read the files matching **/*.pem", "write to / (every file)", "no access to the project's folders/secrets", 'macos: {"x":1}']);
  });

  test("Codex's question is a question card; its answer goes back by question id", async () => {
    const r = rig();
    try {
      const s = await r.session();
      r.app().send(s.id, "ask me about the button", "k1");
      const q = await until(() => allPendingQuestions().find((x) => x.session_id === s.id));
      expect(q.asked?.from).toBe("Codex");
      expect(q.asked?.questions).toEqual([{ id: "color", header: "Color", question: "Which color should the button be?", options: [{ label: "Blue", description: "The brand color" }, { label: "Green", description: undefined }], secret: undefined }]);
      expect(answer(s.id, q.call_id, { color: { picked: ["Green"] } }, false, q.asked!.id)).toBe(true);
      await until(() => readFileSync(r.rollout, "utf8").includes("You picked Green."), 15_000);
      await until(() => !r.app().ours(s.id));
      // A question of the next turn (a new child, whose request ids start again) is another question: an answer
      // sent for the first one does not answer it.
      r.app().send(s.id, "ask me again", "k2");
      const q2 = await until(() => allPendingQuestions().find((x) => x.session_id === s.id));
      expect(q2.asked!.id).not.toBe(q.asked!.id);
      expect(answer(s.id, q2.call_id, { color: { picked: ["Blue"] } }, false, q.asked!.id)).toBe("stale");
      expect(answer(s.id, q2.call_id, { color: { picked: ["Blue"] } }, false, q2.asked!.id)).toBe(true);
      await until(() => readFileSync(r.rollout, "utf8").includes("You picked Blue."), 15_000);
      await until(() => !r.app().ours(s.id));
    } finally { r.done(); }
  }, 30_000);

  test("Stop interrupts the turn Keel runs; a send while it runs steers it", async () => {
    const r = rig();
    try {
      const s = await r.session();
      r.app().send(s.id, "wait for me", "k1");
      await until(() => r.app().running(s.id));
      expect(r.app().route(s.id)).toBe("steer");
      r.app().send(s.id, "and also this", "k2");
      await until(() => readFileSync(r.rollout, "utf8").includes('"message":"and also this"'));
      expect(await r.app().interrupt(s.id)).toBe(true);
      await until(() => !r.app().ours(s.id), 15_000);
      expect(readFileSync(r.rollout, "utf8")).toContain('"type":"turn_aborted"');
      expect(r.store.db.query<{ key: string; state: string }, []>("SELECT key, state FROM outside_sends ORDER BY key").all()).toEqual([{ key: "k1", state: "delivered" }, { key: "k2", state: "delivered" }]);
    } finally { r.done(); }
  }, 30_000);

  test("a Codex that stops answering: Stop gives up on it in seconds, and a second Stop ends it at once", async () => {
    const r = rig();
    try {
      const s = await r.session();
      r.app().send(s.id, "stuck now", "k1");
      await until(() => r.frames.some((f) => f.t === "delta" && f.session_id === s.id && f.text.includes("Stuck")));
      let t = Date.now();
      // The first Stop asks Codex to interrupt; nothing answers, so it ends the child after a few seconds.
      expect(await r.app().interrupt(s.id)).toBe(true);
      await until(() => !r.app().ours(s.id), 20_000);
      expect(Date.now() - t).toBeLessThan(15_000);
      // Again, with a second Stop while the first waits: the child ends at once.
      r.app().send(s.id, "stuck again", "k2");
      await until(() => r.frames.filter((f) => f.t === "delta" && f.session_id === s.id && f.text.includes("Stuck")).length >= 2, 15_000);
      void r.app().interrupt(s.id);
      t = Date.now();
      expect(await r.app().interrupt(s.id)).toBe(true);
      await until(() => !r.app().ours(s.id), 20_000);
      expect(Date.now() - t).toBeLessThan(4_000);
    } finally { r.done(); }
  }, 60_000);

  test("a row the owner deletes while Keel runs its turn: the turn is stopped and the child ends", async () => {
    const r = rig();
    try {
      const s = await r.session();
      r.app().send(s.id, "wait for me", "k1");
      await until(() => r.app().running(s.id));
      r.store.deleteSession(s.id);
      r.bus.emit({ t: "session", session: s, deleted: true });
      await until(() => !r.app().ours(s.id), 15_000);
      expect(readFileSync(r.rollout, "utf8")).toContain('"type":"turn_aborted"');
    } finally { r.done(); }
  }, 30_000);

  test("a send taken just before Keel stops is kept for the next daemon, which sends it", async () => {
    const r = rig();
    try {
      const s = await r.session();
      expect("send" in r.app().send(s.id, "please go on", "k1")).toBe(true);
      // The drain comes while the child is being prepared.
      r.app().stop();
      await Bun.sleep(300);
      expect(r.app().sends(s.id).map((x) => x.state)).toEqual(["stored"]);
      r.make().start();
      // (Delivered sends are no longer listed: the row says it.)
      await until(() => r.store.db.query<{ state: string }, []>("SELECT state FROM outside_sends").get()?.state === "delivered", 15_000);
      await until(() => !r.app().ours(s.id), 15_000);
    } finally { r.done(); }
  }, 30_000);

  test("a delivered send is kept a day (its key stores a resend once), then let go", async () => {
    const r = rig();
    try {
      const s = await r.session();
      const put = r.store.db.query("INSERT INTO outside_sends (id, session_id, key, text, state, offset, said, created) VALUES (?, ?, ?, 'x', ?, 0, NULL, ?)");
      put.run("old", s.id, "k-old", "delivered", Date.now() - 25 * 3600_000);
      put.run("new", s.id, "k-new", "delivered", Date.now() - 3600_000);
      put.run("lost", s.id, "k-lost", "lost", Date.now() - 25 * 3600_000);
      r.app().stop();
      r.make().start();
      expect(r.store.db.query<{ id: string }, []>("SELECT id FROM outside_sends ORDER BY id").all().map((x) => x.id)).toEqual(["lost", "new"]);
    } finally { r.done(); }
  });

  test.skipIf(!PROC)("a child an earlier daemon left running is ended at the start, with what it started, and nothing Keel did not start", async () => {
    const r = rig();
    const forever = ["-e", "setInterval(() => {}, 1 << 30)"];
    // Keel's own child, a launcher whose native it started after the row was kept (the daemon ended first): the
    // native holds the thread's writer lock. Beside it a job of a turn whose arguments say app-server too.
    const lock = join(r.codex, "thread-writer-locks", `${r.thread}.lock`);
    const holds = `const { dlopen, FFIType } = require("bun:ffi"); const l = dlopen("libc.so.6", { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } }); l.symbols.flock(require("node:fs").openSync(${JSON.stringify(lock)}, "a"), 2); setInterval(() => {}, 1 << 30)`;
    const kids = `const cp = require("node:child_process"); cp.spawn(process.execPath, ["-e", ${JSON.stringify(holds)}, "app-server"], { stdio: "ignore" }); cp.spawn(process.execPath, ${JSON.stringify(forever)}.concat(["app-server"]), { stdio: "ignore" }); setInterval(() => {}, 1 << 30)`;
    const orphan = Bun.spawn([process.execPath, "-e", kids, "app-server"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    // Not Keel's: another program with Keel's start time, a server whose start time is not the row's (its pid
    // taken again), and a pid that is this process with a start time of another.
    const other = Bun.spawn(["sleep", "30"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    const decoy = Bun.spawn([process.execPath, ...forever, "app-server"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    const startOf = (pid: number) => statFields(readFileSync(`/proc/${pid}/stat`, "utf8"))!.start;
    let native = 0;
    let job = 0;
    try {
      const s = await r.session();
      const under = await until(() => descendants(orphan.pid).length === 2 && descendants(orphan.pid));
      native = await until(() => lockHolder(lock, readLocks()));
      job = under.find((p) => p.pid !== native)!.pid;
      const put = r.store.db.query("INSERT INTO outside_procs (session_id, pid, start) VALUES (?, ?, ?)");
      put.run(s.id, orphan.pid, startOf(orphan.pid));
      put.run("not-a-session", other.pid, startOf(other.pid));
      put.run("taken-again", decoy.pid, String(Number(startOf(decoy.pid)) - 7));
      put.run("this-one", process.pid, "1");
      r.app().stop();
      r.make().start();
      await until(() => orphan.signalCode !== null || orphan.exitCode !== null, 8000);
      expect(orphan.signalCode).toBe("SIGTERM");
      await until(() => { try { return statFields(readFileSync(`/proc/${native}/stat`, "utf8"))?.state === "Z"; } catch { return true; } }, 8000);
      await Bun.sleep(100);
      // A job of the turn is not Keel's, whatever its arguments say.
      expect(readFileSync(`/proc/${job}/stat`, "utf8")).not.toMatch(/\) Z /);
      expect(other.exitCode).toBeNull();
      expect(other.signalCode).toBeNull();
      expect(decoy.exitCode).toBeNull();
      expect(decoy.signalCode).toBeNull();
      // The rows of what is gone go; the row of a process that still lives (not Keel's to end) stays.
      await until(() => r.store.db.query("SELECT * FROM outside_procs").all().length === 1);
      expect(r.store.db.query("SELECT session_id FROM outside_procs").all()).toEqual([{ session_id: "not-a-session" }]);
    } finally { other.kill(); orphan.kill(); decoy.kill(); for (const p of [native, job]) if (p) try { process.kill(p, "SIGKILL"); } catch {} r.done(); }
  }, 30_000);

  test.skipIf(!PROC)("a codex that is a launcher (the npm package's): Stop ends the native under it too, which holds the thread", async () => {
    const r = rig({ bin: LAUNCHER });
    let native = 0;
    try {
      const s = await r.session();
      r.app().send(s.id, "stuck now", "k1");
      await until(() => r.frames.some((f) => f.t === "delta" && f.session_id === s.id && f.text.includes("Stuck")), 15_000);
      const launcher = (r.app() as any).runs.get(s.id).conn.pid as number;
      native = (await until(() => descendants(launcher)[0])).pid;
      expect(await r.app().interrupt(s.id)).toBe(true);
      expect(await r.app().interrupt(s.id)).toBe(true);
      await until(() => !r.app().ours(s.id), 15_000);
      const gone = (pid: number) => { try { return statFields(readFileSync(`/proc/${pid}/stat`, "utf8"))?.state === "Z"; } catch { return true; } };
      expect(gone(launcher)).toBe(true);
      expect(gone(native)).toBe(true);
      expect(r.store.db.query("SELECT * FROM outside_procs").all()).toEqual([]);
    } finally { if (native) try { process.kill(native, "SIGKILL"); } catch {} r.done(); }
  }, 30_000);

  test.skipIf(!PROC)("what Codex starts under it (an MCP server's helper, a job of the turn) outlives the child: at a turn's end and at a forced Stop", async () => {
    const r = rig();
    const left: number[] = [];
    const lives = (pid: number) => { try { return statFields(readFileSync(`/proc/${pid}/stat`, "utf8"))?.state !== "Z"; } catch { return false; } };
    try {
      const s = await r.session();
      const file = join(r.codex, "standin-helpers");
      writeFileSync(file, "");
      const pids = (n: number) => until(() => { const l = readFileSync(file, "utf8").split("\n").filter(Boolean).map((x) => Number(x.split(" ")[1])); return l.length >= n && l; });
      // A turn that ends: the child goes, what it started stays.
      r.app().send(s.id, "fix the build", "k1");
      const [helper, job] = await pids(2);
      left.push(helper!, job!);
      const child = (r.app() as any).runs.get(s.id).conn.pid as number;
      await until(() => !r.app().ours(s.id), 15_000);
      expect(lives(child)).toBe(false);
      expect([lives(helper!), lives(job!)]).toEqual([true, true]);
      // A Codex that stops answering, ended by a second Stop: the same.
      r.app().send(s.id, "stuck now", "k2");
      const [, , helper2, job2] = await pids(4);
      left.push(helper2!, job2!);
      await until(() => r.frames.some((f) => f.t === "delta" && f.session_id === s.id && f.text.includes("Stuck")), 15_000);
      const child2 = (r.app() as any).runs.get(s.id).conn.pid as number;
      expect(await r.app().interrupt(s.id)).toBe(true);
      expect(await r.app().interrupt(s.id)).toBe(true);
      await until(() => !r.app().ours(s.id), 15_000);
      expect(lives(child2)).toBe(false);
      expect([lives(helper!), lives(job!), lives(helper2!), lives(job2!)]).toEqual([true, true, true, true]);
    } finally { for (const p of left) try { process.kill(p, "SIGKILL"); } catch {} r.done(); }
  }, 40_000);

  test("a Stop of the next turn the same child runs asks Codex again: the first Stop's mark ends with its turn", async () => {
    const r = rig();
    try {
      const s = await r.session();
      const app = r.app() as any;
      const heard0 = app.heard.bind(app);
      let next = false;
      // The owner's next message lands as the stopped turn ends: the same child runs it.
      app.heard = (run: any, method: string, p: any) => { if (method === "turn/completed" && !next) { next = true; app.send(s.id, "wait two", "k2"); } return heard0(run, method, p); };
      r.app().send(s.id, "wait one", "k1");
      const working = () => r.frames.filter((f) => f.t === "delta" && f.session_id === s.id && f.text.startsWith("Working")).length;
      await until(() => working() === 1, 15_000);
      expect(await r.app().interrupt(s.id)).toBe(true);
      await until(() => working() === 2, 15_000);
      expect(await r.app().interrupt(s.id)).toBe(true);
      await until(() => !r.app().ours(s.id), 15_000);
      const log = readFileSync(`${r.rollout}.standin.log`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).method);
      expect(log.filter((m) => m === "thread/resume").length).toBe(1);
      expect(log.filter((m) => m === "turn/interrupt").length).toBe(2);
      expect(readFileSync(r.rollout, "utf8").split('"type":"turn_aborted"').length - 1).toBe(2);
    } finally { r.done(); }
  }, 30_000);

  test("a Stop of a child that is already ending ends it now, and asks Codex nothing", async () => {
    const r = rig();
    try {
      const s = await r.session();
      r.app().send(s.id, "stuck now", "k1");
      await until(() => r.frames.some((f) => f.t === "delta" && f.session_id === s.id && f.text.includes("Stuck")), 15_000);
      const app = r.app() as any;
      const run = app.runs.get(s.id);
      const asked: string[] = [];
      const request0 = run.conn.request.bind(run.conn);
      run.conn.request = (m: string, p: unknown) => { asked.push(m); return request0(m, p); };
      // Its end began (its input closes after thread/unsubscribe), and the Codex does not answer.
      void app.end(run);
      await until(() => asked.includes("thread/unsubscribe"));
      expect(await r.app().interrupt(s.id)).toBe(true);
      await until(() => !r.app().ours(s.id), 15_000);
      expect(asked).not.toContain("turn/interrupt");
    } finally { r.done(); }
  }, 30_000);

  test("a send that lands while the child ends goes with one new child, never two", async () => {
    const r = rig();
    try {
      const s = await r.session();
      const app = r.app() as any;
      const end0 = app.end.bind(app);
      let sent = false;
      // The owner's next message lands in the tick the child begins to end.
      app.end = (run: any) => { const p = end0(run); if (!sent) { sent = true; app.send(s.id, "fix the build once more", "k2"); } return p; };
      r.app().send(s.id, "fix the build", "k1");
      await until(() => r.store.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM outside_sends WHERE state = 'delivered'").get()!.n === 2 && !r.app().ours(s.id), 20_000);
      const log = readFileSync(`${r.rollout}.standin.log`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).method);
      expect(log.filter((m) => m === "thread/resume").length).toBe(2);
      expect(readFileSync(r.rollout, "utf8").split('"message":"fix the build once more"').length - 1).toBe(1);
    } finally { r.done(); }
  }, 30_000);

  test("the last record of a type is found however far back it is, with the loop free while it reads", async () => {
    const f = join(top, "long.jsonl");
    const ctx = (n: number) => JSON.stringify({ type: "turn_context", payload: { turn_id: `t${n}` } }) + "\n";
    const out = JSON.stringify({ type: "response_item", payload: { output: "é".repeat(20_000) } }) + "\n";
    writeFileSync(f, ctx(1) + out.repeat(1000));
    let ticks = 0;
    const tick = setInterval(() => ticks++, 0);
    try {
      expect((await lastRecord(f, "turn_context"))?.payload.turn_id).toBe("t1");
    } finally { clearInterval(tick); }
    expect(ticks).toBeGreaterThan(0);
    // A record cut across parts (a two-byte character at the boundary), a decoy in a string, a cut last line, none.
    writeFileSync(f, ctx(1) + JSON.stringify({ type: "response_item", payload: { text: 'he quoted "type":"turn_context" here' } }) + "\n" + ctx(2) + out.slice(0, 301) + "\n");
    for (const part of [7, 64, 1000, 4096]) expect((await lastRecord(f, "turn_context", part))?.payload.turn_id).toBe("t2");
    writeFileSync(f, ctx(1) + '{"type":"turn_context","payload":{"turn_id":"cut');
    expect((await lastRecord(f, "turn_context", 50))?.payload.turn_id).toBe("t1");
    writeFileSync(f, out);
    expect(await lastRecord(f, "turn_context", 100)).toBeUndefined();
    expect(await lastRecord(`${f}.none`, "turn_context")).toBeUndefined();
  });

  test("what a thread gained since a send is read a part at a time, the loop free, and only its marked lines decoded", async () => {
    const f = join(top, "grown.jsonl");
    const line = (type: string, payload: object) => JSON.stringify({ type, payload }) + "\n";
    const out = line("response_item", { type: "function_call_output", output: "é".repeat(20_000) });
    const before = line("event_msg", { type: "user_message", message: "before the send" });
    writeFileSync(f, before + out.repeat(500) + line("event_msg", { type: "user_message", message: "שלום, go on" }) + out.repeat(500) + line("event_msg", { type: "task_complete", turn_id: "t1" }));
    let ticks = 0;
    const tick = setInterval(() => ticks++, 0);
    let got: any[] = [];
    try { got = await recordsFrom(f, before.length); } finally { clearInterval(tick); }
    expect(ticks).toBeGreaterThan(0);
    // Only the marked lines: the message and the turn's end, none of the outputs, nothing before the offset.
    expect(got.map((r) => r.payload.type)).toEqual(["user_message", "task_complete"]);
    expect(holdsMessage(got, "שלום, go on") && turnEnded(got, "שלום, go on")).toBe(true);
    // Parts that cut a line (and a character) anywhere; a mark quoted inside a string decodes to nothing of its
    // kind; a last line still being written; no file.
    writeFileSync(f, line("response_item", { type: "function_call_output", output: 'it said "type":"user_message" here' }) + line("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "é go on" }] }) + '{"type":"event_msg","payload":{"type":"task_compl');
    for (const part of [5, 33, 64, 4096]) {
      const r = await recordsFrom(f, 0, part);
      expect(holdsMessage(r, "é go on")).toBe(true);
      expect(turnEnded(r, "é go on")).toBe(false);
      expect(holdsMessage(r, "here")).toBe(false);
    }
    expect(await recordsFrom(`${f}.none`, 0)).toEqual([]);
    // A writer that puts spacing after its colons (any JSON serializer may): the same records.
    writeFileSync(f, JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "spaced" } }).replaceAll('":', '": ') + "\n" + '{"type": "event_msg", "payload": {"type" :\t"task_complete"}}\n');
    const spaced = await recordsFrom(f, 0);
    expect(holdsMessage(spaced, "spaced") && turnEnded(spaced, "spaced")).toBe(true);
    writeFileSync(f, '{"type": "turn_context", "payload": {"turn_id": "t9"}}\n' + out);
    expect((await lastRecord(f, "turn_context", 64))?.payload.turn_id).toBe("t9");
  });

  test("a daemon that stops while a send's delivery is read checks nothing more: its store may be closed", async () => {
    const r = rig();
    const s = await r.session();
    r.store.db.query("INSERT INTO outside_sends (id, session_id, key, text, state, offset, said, created) VALUES ('g', ?, 'kg', 'given', 'started', 0, NULL, ?)").run(s.id, Date.now());
    // A rollout long enough that the read takes parts (each one a turn of the loop).
    appendFileSync(r.rollout, JSON.stringify({ type: "response_item", payload: { output: "x".repeat(4 << 20) } }) + "\n");
    const checking = (r.app() as any).check({ path: r.rollout, given: new Set(["g"]) });
    r.done();
    await checking;
  });

  test("who holds the rows a page shows is read from one look at /proc/locks a tick", async () => {
    const r = rig();
    try {
      await r.session();
      // Two more threads of the same Codex.
      for (const n of [1, 2]) {
        const id = `${r.thread.slice(0, -2)}9${n}`;
        const path = r.rollout.replace(r.thread, id);
        appendFileSync(path, readFileSync(r.rollout, "utf8").replaceAll(r.thread, id));
      }
      await until(() => r.store.sessions({ outside: true }).length === 3);
      const before = r.o.stats.lock_reads;
      (r.o as any).tick();
      expect(r.o.stats.lock_reads - before).toBe(1);
    } finally { r.done(); }
  });

  test("a session another process holds takes nothing, and says who holds it", async () => {
    const r = rig({ holder: () => ({ kind: "terminal", pid: 4242 }) });
    try {
      const s = await r.session();
      expect(r.app().route(s.id, { kind: "terminal", pid: 4242 })).toBe("held");
      const got = r.app().send(s.id, "hello", "k1");
      expect(got).toEqual({ error: "Open in a terminal (pid 4242): answer it there. Keel sends nothing to a session another process holds.", status: 409, holder: { kind: "terminal", pid: 4242 } });
      expect(r.store.db.query("SELECT * FROM outside_sends").all()).toEqual([]);
    } finally { r.done(); }
  });

  test("a Codex that keeps no writer locks is not answered in place: Keel could not tell a terminal has it open", async () => {
    const r = rig({ locks: false });
    try {
      const s = await r.session();
      expect(r.app().route(s.id)).toBe("unlocked");
      const got = r.app().send(s.id, "hello", "k1");
      expect(got).toMatchObject({ status: 409 });
      expect("error" in got && got.error).toContain("keeps no writer locks");
      expect(r.store.db.query("SELECT * FROM outside_sends").all()).toEqual([]);
    } finally { r.done(); }
  });

  test("after a restart a send that started is looked for in the rollout, never sent again; a turn it cut and its cards say so", async () => {
    const r = rig({ realGate: true });
    try {
      const s = await r.session();
      const size = readFileSync(r.rollout).length;
      const put = r.store.db.query("INSERT INTO outside_sends (id, session_id, key, text, state, offset, said, created) VALUES (?, ?, ?, ?, 'started', ?, NULL, ?)");
      put.run("a", s.id, "ka", "it went", size, Date.now());
      put.run("b", s.id, "kb", "it did not", size, Date.now());
      put.run("c", s.id, "kc", "it was cut", size, Date.now());
      r.rec("event_msg", { type: "user_message", message: "it went" });
      r.rec("event_msg", { type: "task_complete", turn_id: "t1" });
      r.rec("event_msg", { type: "user_message", message: "it was cut" });
      // The daemon ended while Codex waited on a card: the card is still open in the store.
      const call = { id: "codex-x-c1-c1", tool: { name: "Codex command", kind: "shell", description: "", readOnly: false, input_schema: { properties: { command: {} } }, run: async () => ({ content: "" }) }, input: { command: "make" }, ctx: { sessionId: s.id, cwd: r.cwd, signal: new AbortController().signal, spillDir: "", seen: new Map() } } as any;
      void r.gate()!.askOnce(r.store.session(s.id)!, call, "Codex command", "Codex asks", "harness");
      const card = await until(() => r.gate()!.approvals({ session: s.id, pending: true })[0]);
      r.app().stop();
      r.nextGate();
      let cut = 0;
      r.make({ cutAsks: () => void cut++ }).start();
      expect(cut).toBe(1);
      expect(r.gate()!.approval(card.id)).toMatchObject({ state: "cancelled", reason: "Keel restarted while Codex worked: the turn stopped there" });
      const states = () => r.store.db.query<{ id: string; state: string }, []>("SELECT id, state FROM outside_sends ORDER BY id").all();
      await until(() => !states().some((x) => x.state === "started"));
      expect(states()).toEqual([{ id: "a", state: "delivered" }, { id: "b", state: "lost" }, { id: "c", state: "cut" }]);
      expect(r.app().sends(s.id).map((x) => x.said)).toEqual(["Keel restarted while it went, and the session does not hold it: send it again", "Keel restarted while Codex worked: the turn stopped there"]);
      expect(r.app().dismiss(s.id, "c")).toBe(true);
      expect(readFileSync(r.rollout, "utf8").match(/it did not/g)).toBeNull();
      // Sent again by the owner, it replaces the lost one.
      const again = r.app().send(s.id, "it did not", "kd", "b");
      expect("send" in again ? again.send.state : again).toBe("stored");
      const asked = await until(() => {
        const gone = r.app().sends(s.id).find((x) => x.key === "kd" && (x.state === "lost" || x.state === "failed"));
        if (gone) throw new Error(`the send did not go: ${gone.said}`);
        return r.gate()!.approvals({ session: s.id, pending: true })[0];
      }, 15_000);
      r.gate()!.resolve(asked.id, s.id, { choice: "once", seen: "whole" });
      await until(() => readFileSync(r.rollout, "utf8").includes("The command was allowed: it did not"), 15_000);
      await until(() => !r.app().ours(s.id));
      expect(r.store.db.query<{ id: string }, []>("SELECT id FROM outside_sends WHERE id = 'b'").all()).toEqual([]);
    } finally { r.done(); }
  }, 30_000);
});

import { lineage } from "../core/tree.ts";
import { registerHooks } from "../engine/hooks.ts";
import { sandboxStatus } from "../safety/sandbox.ts";
import { gate } from "../server/routes/permissions.ts";
import * as agents from "./agents.ts";
import { D } from "./core.ts";
import { pickAllowed } from "../safety/content-routes.ts";
import { check, extractJson } from "./schema.ts";

// The independent check before a goal counts as met. The judge reads the
// working session's own conversation, and an agent grading its own work tends
// to pass it. So when the judge says met, a verifier with a clean context (a
// read-only child session in the same folder, no network where the sandbox
// runs) gets the objective and the worker's claim, not the conversation, and
// checks the work itself: reads the files, runs what proves it, and looks for
// shortcuts (weakened or skipped tests, special cases for test inputs, faked
// output). Only its "met" achieves the goal; its "not met" sends the next turn
// its findings. An independent critic at completion is the harness mechanism
// with the clearest measured gain on agent benchmarks (arXiv 2610.34577);
// Claude Code's agent Stop hooks, OpenCode's /goal reviewer and Cline's goal
// plugin check completion the same way.

export type Verdict = { verdict: "met" | "not_met"; reason: string; evidence: string[] };
const SCHEMA = { type: "object", required: ["verdict", "reason"], properties: { verdict: { enum: ["met", "not_met"] }, reason: { type: "string" }, evidence: { type: "array", items: { type: "string" } } } };
// The most one verification takes, from its start (kept in the goal's row) to
// its verdict, whatever happens in between: a daemon restart does not start
// the count again.
export const WAIT_MS = Number(process.env.KEEL_VERIFY_TIMEOUT_MS ?? 15 * 60_000);

// The verifier's answer, from its last reply. A reply that is not the JSON
// asked for is no verdict, and neither is a met that names nothing it saw
// (`unproven`): met is a claim until evidence comes with it. A not met needs
// none: its reason says what is missing.
export function parseVerdict(text: string): Verdict | { error: string; unproven?: true } {
  const got = extractJson(text);
  if ("error" in got || check(SCHEMA, got.value)) return { error: `the verifier gave no verdict: ${text.slice(0, 200) || "(no reply)"}` };
  const v = got.value as Verdict;
  const evidence = (Array.isArray(v.evidence) ? v.evidence : []).map((e) => String(e).trim().slice(0, 400)).filter(Boolean).slice(0, 12);
  if (v.verdict === "met" && !evidence.length) return { error: "the verifier said met and named no evidence it saw", unproven: true };
  return { verdict: v.verdict, reason: String(v.reason).slice(0, 2000), evidence };
}

const EVIDENCE =
  'Your verdict was "met" with no evidence, and met counts only with what you saw. Reply again with only the JSON: the same verdict with "evidence" listing each check (file:line, command and its result), or "not_met" with what is missing.';

export const task = (o: { objective: string; claim: string; judged: string; commands: string[]; cwd: string }) =>
  [
    "You are an independent verifier. Another agent worked toward the goal below in this folder and its session's judge says the goal is met. Do not trust that: check it yourself.",
    "Read the files, the git state (git status, git diff) and the outputs that matter. Run the checks that prove it (the tests, the build, the command the goal names) where your read-only tools allow; a check that needs to write is judged from what is on disk and why it cannot run here.",
    "Look for shortcuts: tests weakened, skipped or deleted; special cases for test inputs; output printed instead of computed; work left as TODO or stubbed; a claim no file or run supports.",
    "Met means you saw the evidence. When something is missing or wrong, say exactly what, so the worker can fix it.",
    'Reply with only JSON: {"verdict": "met" | "not_met", "reason": "<what you checked and found, two sentences at most>", "evidence": ["<file:line, command and result, one per item>"]}.',
    `\nFolder: ${o.cwd}`,
    `\nThe goal:\n${o.objective}`,
    `\nWhat the worker said at the end (a claim, not evidence):\n${o.claim || "(nothing)"}`,
    `\nWhy the judge said met:\n${o.judged}`,
    o.commands.length ? `\nCommands the worker ran (newest last):\n${o.commands.map((c) => `- ${c}`).join("\n")}` : "",
  ].join("\n");

// What the working session claimed and ran since the goal was set.
function trail(sessionId: string, since: number): { claim: string; commands: string[] } {
  const evs = D().store.events(sessionId).filter((e) => e.ts >= since);
  let claim = "";
  const commands: string[] = [];
  for (const e of evs) {
    if (e.kind !== "assistant") continue;
    const blocks = e.data.blocks as any[];
    const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    if (text) claim = text;
    for (const b of blocks) {
      if (b.type !== "tool_use") continue;
      const c = b.input?.command ?? b.input?.cmd;
      const cmd = typeof c === "string" ? c : Array.isArray(c) ? c.join(" ") : null;
      if (cmd) commands.push(cmd.replace(/\s+/g, " ").slice(0, 240));
    }
  }
  return { claim: claim.length > 4000 ? `${claim.slice(0, 2000)}\n...\n${claim.slice(-2000)}` : claim, commands: commands.slice(-25) };
}

const waiting = new Map<string, (reason: string) => void>();
let hooked = false;
function hook() {
  if (hooked) return;
  hooked = true;
  registerHooks({
    // A turn parked for a daemon stop has not ended: the wait goes with the
    // daemon, the goal stays verifying, and the next start waits for the same
    // verifier again (reattach), whose turn the engine continues.
    turnEnd: (s, reason) => { if (reason !== "restart") waiting.get(s.id)?.(reason); },
    // The engine did not continue its cut turn: nothing runs for it any more.
    cutTurnHeld: (s) => waiting.get(s.id)?.("held"),
  });
}

const lastText = (childId: string) => {
  const evs = D().store.events(childId);
  for (let i = evs.length - 1; i >= 0; i--) {
    const e = evs[i]!;
    if (e.kind === "assistant") {
      const t = (e.data.blocks as any[]).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
      if (t) return t;
    }
  }
  return "";
};

export type Outcome = { result: Verdict | { error: string }; child_id: string | null; tokens: number };

// The end of the verifier's turn that runs now or is about to: one it was just
// sent, or one a restart cut that the engine continues. The wait always ends:
// at `until` (the verification's start plus its limit), and at once when the
// session is archived or gone, where no turn runs or is continued.
const turnEnd = (childId: string, until: number) =>
  new Promise<string>((resolve) => {
    const s = D().store.session(childId);
    if (!s || s.archived) return resolve(s ? "archived" : "deleted");
    const left = until - Date.now();
    if (left <= 0) return resolve("timeout");
    const timer = setTimeout(() => { waiting.delete(childId); resolve("timeout"); }, left);
    waiting.set(childId, (reason) => { clearTimeout(timer); waiting.delete(childId); resolve(reason); });
  });

// The verifier's session was archived or deleted (a session frame): a
// verification waiting on it ends there.
export function verifierSession(s: { id: string; archived?: boolean }, deleted: boolean) {
  if (deleted || s.archived) waiting.get(s.id)?.(deleted ? "deleted" : "archived");
}

// Why a verification ended with no turn end of its verifier to read.
const WHY: Record<string, string> = {
  timeout: `the verifier ran past ${Math.round(WAIT_MS / 60_000)} minutes`,
  held: "the verifier's turn was cut by daemon restarts and was not resumed",
  archived: "the verifier's session was archived",
  deleted: "the verifier's session was deleted",
};
const answer = (childId: string, reason: string): Verdict | { error: string; unproven?: true } =>
  reason === "end_turn" ? parseVerdict(lastText(childId)) : { error: WHY[reason] ?? `the verifier's turn ended: ${reason}` };

// The prompts the verifier got: its task, then at most one request for its evidence.
const prompts = (childId: string) => D().store.events(childId).filter((e) => e.kind === "user" && e.data.kind === "verify_goal").length;
// Sent only while there is something to wait for (not past the limit, the session there).
const ask = (childId: string, text: string, until: number) => {
  const ended = turnEnd(childId, until);
  if (waiting.has(childId)) D().engine.send(childId, text, { meta: { kind: "verify_goal" } });
  return ended;
};

// From the end of a verifier's turn to the verification's outcome.
async function conclude(childId: string, ended: string | Promise<string>, until: number): Promise<Outcome> {
  const { store, engine } = D();
  let reason = await ended;
  let result = answer(childId, reason);
  if ("unproven" in result && prompts(childId) < 2) {
    // Asked once for what it saw, in its own context (what it read is cached there).
    await engine.idle(childId);
    reason = await ask(childId, EVIDENCE, until);
    result = answer(childId, reason);
  }
  // Ended without its verifier: nothing more is wanted from it. A turn of its
  // that runs is stopped, and its record ends, so a turn a restart cut is not
  // continued either (agents.onCutTurn).
  if (reason === "timeout" || reason === "archived" || reason === "deleted") {
    const a = agents.byChild(childId);
    if (a && (!agents.isEnded(a) || engine.isRunning(childId))) agents.stop(a.id, reason === "timeout" ? "time_limit" : "parent");
  }
  const u = store.session(childId)?.usage as any;
  const tokens = (u?.input ?? 0) + (u?.output ?? 0) + (u?.cache_read ?? 0) + (u?.cache_write ?? 0);
  return { result, child_id: childId, tokens };
}

// `verify_started_ms`: when this verification began, as the goal's row keeps it.
type Checked = { objective: string; started_ms: number; judge_model?: string | null; verifier_model?: string | null; verify_started_ms?: number | null };
const untilOf = (g: Checked) => (g.verify_started_ms ?? Date.now()) + WAIT_MS;
const taskFor = (sessionId: string, g: Checked, judged: string) => {
  const t = trail(sessionId, g.started_ms);
  return task({ objective: g.objective, claim: t.claim, judged, commands: t.commands, cwd: D().store.session(sessionId)!.workspace });
};

// Runs one verification; resolves with its verdict (or why there is none),
// the child session and what it spent. `still`: whether the goal it checks is
// still the one there; asked before its session is made, so a goal cleared or
// replaced while the model resolved gets no verifier (and no child session).
export async function verify(sessionId: string, g: Checked, judged: string, onChild?: (childId: string) => void, still?: () => boolean): Promise<Outcome> {
  hook();
  const { store, providers, bus } = D();
  const s = store.session(sessionId)!;
  // The first of them the session's folder allows (src/safety/content-routes.ts); the session's own when none is.
  const model = pickAllowed(store, sessionId, "verifier", [g.verifier_model, g.judge_model, s.model]) ?? s.model;
  const { info } = await providers.resolve(model);
  if (still && !still()) return { result: { error: "the goal changed before its verifier started" }, child_id: null, tokens: 0 };
  const child = store.createSession({ model, workspace: s.workspace, title: `Verify goal: ${g.objective}`.slice(0, 80) });
  store.db.query("UPDATE sessions SET parent_id = ? WHERE id = ?").run(sessionId, child.id);
  const sb = sandboxStatus().available;
  gate?.setPerm(child.id, { mode: "read-only", sandbox: sb ? "read-only" : "off", network: !sb });
  agents.adopt(sessionId, child.id, { title: child.title || "Verify goal", type: "verifier", model: info.id });
  bus.emit({ t: "session", session: store.session(child.id)! });
  onChild?.(child.id);
  const until = untilOf(g);
  return conclude(child.id, ask(child.id, taskFor(sessionId, g, judged), until), until);
}

// After a restart: the verification goes on with the verifier it had. Its turn
// the restart cut is the engine's to continue (it asks agents.onCutTurn), and
// the wait is put back on that same session; a turn that had ended before the
// daemon went down is read now; a verifier that never got its task gets it.
// One verifier and one verdict per check, however many restarts it spans, and
// one limit: the time left is counted from the verification's start, and a
// verifier whose session is archived or gone ends it at once (turnEnd).
export function reattach(sessionId: string, g: Checked, judged: string, childId: string): Promise<Outcome> {
  hook();
  const { store, engine } = D();
  const until = untilOf(g);
  const s = store.session(childId);
  if (!s || s.archived) return conclude(childId, s ? "archived" : "deleted", until);
  if (!prompts(childId)) return conclude(childId, ask(childId, taskFor(sessionId, g, judged), until), until);
  const line = lineage(store.events(childId), s.head ?? null);
  const last = line.findLast((e) => e.kind === "user" || e.kind === "turn_start" || e.kind === "turn_end");
  const over = last?.kind === "turn_end" && !engine.isRunning(childId);
  // Held by the daemon before this one (its note follows the cut turn): no turn is coming.
  if (over && last.data.reason === "restart" && line.at(-1)?.kind === "note" && line.at(-1)!.data.kind === "restart") return conclude(childId, "held", until);
  return conclude(childId, over && last.data.reason !== "restart" ? String(last.data.reason) : turnEnd(childId, until), until);
}

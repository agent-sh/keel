import { expect, test } from "./isolate.ts";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { StoredEvent } from "../../src/core/types.ts";
import { exited, ownDaemon, ownEnv } from "./peer.ts";

// Feature: a model can trace a failure by itself. The notice a session gets
// when its agent fails names the tool that reads the agent's timeline, with
// the agent's id filled in: it sits in the history, so no session's system
// prompt changes. An agent is named by its id or a prefix of it in the
// timeline tool, the timeline route and keel debug; and the timeline tool
// opens one failure in full, with nothing of another session in it. The spec
// runs its own daemon on a scratch state folder, on the scripted stand-in
// (which sends the calls the notice names; no real model is asked), with
// nothing of the caller's environment but the path.
const ROOT = join(process.env.HOME!, ".cache/keel-work/bun/e2e-state");
const daemon = async (state: string, port = 0) => ({ ...(await ownDaemon(state, port, { KEEL_RESUME_GAP_MS: "0" })), env: ownEnv(state) });
const script = (calls: unknown[]) => `script:calls ${JSON.stringify(calls)}`;

const made: string[] = [];
test.afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

test("a failure notice names the tool that tells why, and a session reads its agent's failure by the agent's id or a prefix", async () => {
  test.setTimeout(240_000);
  const state = join(ROOT, `model-tracing-${Date.now()}`);
  made.push(state);
  mkdirSync(state, { recursive: true });
  let d = await daemon(state);
  const call = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
    fetch(d.url + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => r.json() as any);
  const keel = (...args: string[]) => {
    const r = spawnSync("bun", ["src/main.ts", ...args, "--url", d.url], { env: d.env, encoding: "utf8" });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  try {
    const open = async (title: string) => {
      const { session } = await call("/api/sessions", { model: "scripted:stand-in", title });
      await call(`/api/sessions/${session.id}/permissions`, { mode: "full-auto" }, "PUT");
      return session.id as string;
    };
    const view = (id: string) => call(`/api/sessions/${id}`);
    const idle = (id: string, ends: number) =>
      expect.poll(async () => { const v = await view(id); return !v.running && (v.events as StoredEvent[]).filter((e) => e.kind === "turn_end").length; }, { timeout: 60_000 }).toBe(ends);
    const results = async (id: string) => ((await view(id)).events as StoredEvent[]).flatMap((e) => (e.kind === "tool_result" ? (e.data.results as { content: string; is_error?: boolean }[]) : []));
    const tool = (input: Record<string, unknown>) => ({ name: "keel__session_timeline", input });
    const prompt = (id: string) => call(`/api/telemetry/prompt?session_id=${id}&text=1`);

    // A coordinator starts an agent whose model request is refused for billing; another session has an agent of its own.
    const id = await open("Coordinator");
    const other = await open("Someone else's work");
    await call(`/api/sessions/${id}/messages`, { text: script([{ name: "spawn_agent", input: { message: "Fetch the feed\nscript:billing", isolation: "none" } }]) });
    await call(`/api/sessions/${other}/messages`, { text: script([{ name: "spawn_agent", input: { message: "Sort the list\nsay it is sorted", isolation: "none" } }]) });
    const agentOf = async (sid: string) => (await call(`/api/sessions/${sid}/agents`)).agents[0] as { id: string; session_id: string; status: string } | undefined;
    await expect.poll(async () => (await agentOf(id))?.status, { timeout: 60_000 }).toBe("failed");
    await expect.poll(async () => (await agentOf(other))?.status, { timeout: 60_000 }).toBe("completed");
    await expect.poll(async () => (await view(id)).running || (await view(other)).running, { timeout: 60_000 }).toBe(false);
    const agent = (await agentOf(id))!;
    const theirs = (await agentOf(other))!;
    expect(agent.id).toMatch(/^[0-9a-f]{12}$/);
    const turns = async (sid: string) => ((await view(sid)).events as StoredEvent[]).filter((e) => e.kind === "turn_end").length;

    // Told, where it matters: the notice of the failure names the tool and the agent's id. It is one
    // more line of an input in the history; the system prompt holds no block of its own for it.
    const notice = ((await view(id)).events as StoredEvent[]).filter((e) => e.kind === "user").map((e) => String(e.data.text)).find((t) => t.includes("[harness] Failures in this session's work"))!;
    expect(notice).toContain(`1 agent failed (quota), with no report of its own\n    ${agent.id} `);
    expect(notice.trimEnd().split("\n").at(-1)).toBe(`keel__session_timeline with session: ${agent.id} tells what that agent did and where it failed.`);
    const mine = await prompt(id);
    expect((mine.blocks as { name: string }[]).map((b) => b.name)).not.toContain("Tracing");
    expect(mine.text).not.toContain("keel__session_timeline");
    // An unrelated session fails too: an open error of the daemon that is none of the coordinator's.
    const third = await open("Unrelated failure");
    await call(`/api/sessions/${third}/messages`, { text: "model-tracing-private-marker script:rate-limit-long" });
    await idle(third, 1);

    // "Why did the agent fail": the timeline by a prefix of the agent's id says the class, and names the failure.
    const n = await turns(id);
    await call(`/api/sessions/${id}/messages`, { text: script([tool({ session: agent.id.slice(0, 6), only: "failures" }), tool({ session: agent.id }), tool({ session: theirs.id }), tool({ session: theirs.id.slice(0, 6) })]) });
    await idle(id, n + 1);
    const got = (await results(id)).slice(-4);
    expect(got[0]!.is_error ?? false).toBe(false);
    expect(got[0]!.content).toContain(`(${agent.session_id}), newest first`);
    expect(got[0]!.content).toMatch(/! Model request (failed|error) \(quota or billing\)/);
    expect(got[0]!.content).not.toContain("credit balance"); // the rows stay free of the message
    expect(got[1]!.content).toContain(`(${agent.session_id}), newest first`);
    // Another session's agent is not this session's to read, by id or by prefix.
    for (const r of got.slice(2)) expect(r).toMatchObject({ is_error: true, content: expect.stringContaining("NOT_YOURS") });
    const failedTurn = got[0]!.content.match(/Parent's task: failed.*\[turn=([0-9a-f-]{36})/)?.[1];
    const errorId = got[0]!.content.match(/\[(?:turn=[0-9a-f-]+ )?error=([0-9a-f-]{36})\]/)?.[1];
    expect(failedTurn).toBeTruthy();
    expect(errorId).toBeTruthy();
    // The other session's agent, read from where it may be read, for the next check.
    const theirTurn = ((await view(theirs.session_id)).events as StoredEvent[]).find((e) => e.kind === "turn_start")!.id;

    // The same tool opens that failure in full: the message, its trace and what led to it, and nothing
    // of the daemon's other sessions (their open errors, the daemon's log and folders, a way to resend).
    await call(`/api/sessions/${id}/messages`, { text: script([tool({ open: `error=${errorId}` }), tool({ session: agent.id.slice(0, 6), open: `turn=${failedTurn}` }), tool({ open: `turn=${theirTurn}` }), tool({ open: "nothing" })]) });
    await idle(id, n + 2);
    const opened = (await results(id)).slice(-4);
    for (const r of opened.slice(0, 2)) {
      expect(r.is_error ?? false).toBe(false);
      expect(r.content).toContain("credit balance is too low");
      expect(r.content).toContain("## Trace of the turn");
      expect(r.content).toContain("## Transcript before the failure");
      for (const part of ["Other open errors", "rate limited", "model-tracing-private-marker", third, "Looking further", "/replay", "keel.db", "daemon pid", ", state "]) expect(r.content, part).not.toContain(part);
    }
    expect(opened[2]).toMatchObject({ is_error: true, content: expect.stringContaining("NOT_YOURS") });
    expect(opened[3]).toMatchObject({ is_error: true, content: "open takes an id a timeline row ends with: error=ID or turn=ID." });
    // The owner's own bundle of the same turn keeps what the tool's leaves out.
    const owners = await (await fetch(`${d.url}/api/debug/bundle?session_id=${agent.session_id}&turn_event=${failedTurn}`)).text();
    expect(owners).toContain("## Other open errors");
    expect(owners).toContain("## Looking further");

    // The same kind of failure happens in another session: the Errors row is that session's now. The id
    // this session's timeline gave says so and points at the turn, which still opens.
    await call(`/api/sessions/${other}/messages`, { text: "script:billing" });
    await idle(other, (await turns(other)) + 1);
    const foreign = ((await call("/api/errors")).errors as { id: string; session_id?: string }[]).find((e) => e.session_id === third)!.id;
    await call(`/api/sessions/${id}/messages`, { text: script([tool({ open: `error=${errorId}` }), tool({ open: `turn=${failedTurn}` }), tool({ open: `error=${foreign}` })]) });
    await idle(id, n + 3);
    const moved = (await results(id)).slice(-3);
    expect(moved[0]).toMatchObject({ is_error: true, content: expect.stringMatching(/^NOT_YOURS: this error id is not this session's, or no longer .*Open the turn instead \(turn=ID/) });
    expect(moved[1]!.is_error ?? false).toBe(false);
    expect(moved[1]!.content).toContain("credit balance is too low");
    // An error id that never was this session's reads the same: nothing says which of the two it is.
    expect(moved[2]).toMatchObject({ is_error: true, content: moved[0]!.content });

    // The command line names the agent the same way: its id, a prefix of it, and the bundle of its session.
    const head = `Timeline of session "Fetch the feed" (${agent.session_id}), newest first.`;
    for (const ref of [agent.id, agent.id.slice(0, 6), agent.session_id]) {
      const r = keel("debug", "timeline", ref, "--only", "failures");
      expect(r.code, r.err).toBe(0);
      expect(r.out).toContain(head);
      expect(r.out).toMatch(/! Parent's task: failed before its first step/);
    }
    const bundle = keel("debug", "--session", agent.id);
    expect(bundle.code, bundle.err).toBe(0);
    expect(bundle.out).toContain("credit balance is too low");
    // An id that names no error is read as a session: the short id a report's row ends with opens its last turn.
    const byShort = keel("debug", agent.session_id.slice(-12));
    expect(byShort.code, byShort.err).toBe(0);
    expect(byShort.out).toContain(`Session \`${agent.session_id}\``);
    expect(byShort.out).toContain("credit balance is too low");
    // The short id is the last twelve characters and nothing shorter.
    expect((await fetch(`${d.url}/api/sessions/${agent.session_id.slice(-12)}/timeline`)).status).toBe(200);
    expect((await fetch(`${d.url}/api/sessions/${agent.session_id.slice(-11)}/timeline`)).status).toBe(404);
    const none = keel("debug", "timeline", "ffffffffffff");
    expect(none.code).toBe(1);
    expect(none.err).toContain("no session ffffffffffff");
    expect((await fetch(`${d.url}/api/sessions/${agent.id.slice(0, 6)}/timeline`)).status).toBe(200);
    expect((await fetch(`${d.url}/api/sessions/not-a-session/timeline`)).status).toBe(404);

    // The prompt is the same bytes after a daemon restart: nothing of this is in it.
    d.proc.kill("SIGTERM");
    await exited(d.proc);
    d = await daemon(state, d.port);
    await call(`/api/sessions/${id}/messages`, { text: "say something" });
    await idle(id, n + 4);
    const after = await prompt(id);
    expect(after.hash).toBe(mine.hash);
    expect(after.changed).toBeNull();
  } finally {
    d.proc.kill("SIGTERM");
    await exited(d.proc);
  }
});

// What `keel send` says when the daemon does not take the prompt cleanly: a
// stand-in daemon answers the way a failing one does (a real daemon gives a
// 500 or a dropped answer only when something in it breaks).
import { expect, spyOn, test } from "bun:test";
import { ApiError, Client } from "./client.ts";
import { join } from "node:path";
import { answerOf, sendFailure, sessionCommands } from "./sessions.ts";

const SID = "0a1b2c3d-0000-7000-8000-000000000001";

async function sendTo(answer: () => Response): Promise<{ code: number; said: string; posts: number }> {
  let posts = 0;
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/api/health") return Response.json({ pid: 1 });
      if (u.pathname === "/api/cli/resolve") return Response.json({ session: { id: SID } });
      if (u.pathname.endsWith("/draft")) return Response.json({ text: "", attachments: [] });
      if (u.pathname.startsWith("/api/cli/state/")) return Response.json({ last_seq: 0 });
      if (u.pathname.endsWith("/messages")) { posts++; return answer(); }
      return new Response("", { status: 404 });
    },
  });
  const err = spyOn(console, "error").mockImplementation(() => {});
  try {
    const code = await sessionCommands.send(["--url", `http://127.0.0.1:${server.port}`, SID, "hello"]);
    return { code, said: err.mock.calls.map((c) => c.join(" ")).join("\n"), posts };
  } finally {
    err.mockRestore();
    server.stop(true);
  }
}

test("keel send says nothing was sent only when the failure proves it", async () => {
  // The daemon refused: it says why, and the prompt is not in the session.
  const refused = await sendTo(() => Response.json({ error: "the session is archived" }, { status: 409 }));
  expect(refused).toEqual({ code: 3, said: "keel send: the session is archived: nothing was sent", posts: 1 });
  // The daemon failed after it read the request: the prompt may be stored.
  const failed = await sendTo(() => Response.json({ error: "the disk is full" }, { status: 500 }));
  expect(failed).toEqual({ code: 3, said: `keel send: the disk is full: the prompt may not have been sent; look before sending it again: keel logs ${SID}`, posts: 1 });

  // No connection was taken: nothing was read. An answer lost on the way says nothing.
  const closed = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = closed.port;
  await closed.stop(true);
  const unreached = await new Client(`http://127.0.0.1:${port}`).post("/api/sessions/x/messages", {}).catch((e) => e as ApiError);
  expect(unreached).toMatchObject({ status: 0, unreached: true });
  expect(sendFailure(unreached, SID, true)).toEndWith(": nothing was sent and the draft is as it was");
  expect(sendFailure(new ApiError("no daemon answers", 0), SID, true)).toEndWith(`: the prompt may not have been sent (the draft is as it was); look before sending it again: keel logs ${SID}`);
});

test("/answer takes a choice by its exact label before its number", () => {
  const q = (labels: string[], multi = false) => ({ id: "q", question: "Which?", multi, options: labels.map((label) => ({ label })) });
  // Choices that read as numbers: the one that reads 3, not the third.
  expect(answerOf(q(["1", "3", "5"]), "3")).toEqual({ picked: ["3"] });
  expect(answerOf(q(["1", "3", "5"]), "2")).toEqual({ picked: ["3"] });
  expect(answerOf(q(["Teal", "Amber"]), "2")).toEqual({ picked: ["Amber"] });
  expect(answerOf(q(["Teal", "Amber"]), " amber ")).toEqual({ picked: ["Amber"] });
  expect(answerOf(q(["Teal", "Amber", "Grey"], true), "1,3")).toEqual({ picked: ["Teal", "Grey"] });
  expect(answerOf(q(["Teal", "Amber"]), "plain grey")).toEqual({ picked: [], other: "plain grey" });
});

// keel attach against a stand-in daemon (a real one fails a read or opens a
// second question inside one poll only by chance): a question whose read
// failed is read again, and an answer typed for the question on the screen
// never goes to one that opened since and was not shown yet.
test("attach reads a question again after a failed read, and does not answer one it had not shown", async () => {
  const ask = (id: string, question: string, labels: string[]) => ({
    kind: "assistant", id: `e-${id}`, session_id: SID, seq: 1, ts: 0,
    data: { blocks: [{ type: "tool_use", id, name: "AskUserQuestion", input: { questions: [{ question, header: "Pick", options: labels.map((label) => ({ label, description: "" })), multiSelect: false }] } }] },
  });
  const cards = [ask("q1", "Which color?", ["Teal", "Amber"]), ask("q2", "Which size?", ["Small", "Large"])];
  let open: string | null = "q1";
  let failNext = false, failed = 0, polls = 0;
  const answers: [string, unknown][] = [];
  let typeSecond: (() => void) | undefined;
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/api/health") return Response.json({ pid: 1 });
      if (u.pathname === "/api/cli/resolve") return Response.json({ session: { id: SID, title: "Stand-in" } });
      if (u.pathname.startsWith("/api/cli/state/")) {
        polls++;
        if (open === "q1") failNext = failed === 0;
        const body = Response.json({ last_seq: 1, running: true, queue: 0, held: false, approvals: [], questions: open ? [{ session_id: SID, call_id: open }] : [], background: { agents: 0, waits: 0, jobs: 0 } });
        // The first question was answered: right after a look that saw none open, the second opens and the owner types.
        if (open === null && typeSecond) { open = "q2"; typeSecond(); typeSecond = undefined; }
        return body;
      }
      if (u.pathname.endsWith("/events")) {
        if (failNext) { failNext = false; failed++; return Response.json({ error: "the store is busy" }, { status: 500 }); }
        return Response.json({ events: u.searchParams.has("after") ? [] : cards });
      }
      const m = /\/questions\/(q\d)$/.exec(u.pathname);
      if (m && req.method === "POST") { answers.push([m[1]!, (await req.json()).answers]); open = null; return Response.json({ ok: true }); }
      return new Response("", { status: 404 });
    },
  });
  const p = Bun.spawn(["bun", join(import.meta.dir, "../main.ts"), "attach", SID, "--url", `http://127.0.0.1:${server.port}`], {
    env: { ...process.env, KEEL_CONFIG_DIR: join(process.env.TMPDIR ?? "/var/tmp", "keel-attach-config"), KEEL_STATE_DIR: join(process.env.TMPDIR ?? "/var/tmp", "keel-attach-state") },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  let out = "", err = "";
  const drain = async (s: ReadableStream<Uint8Array>, add: (t: string) => void) => { const d = new TextDecoder(); for await (const c of s) add(d.decode(c, { stream: true })); };
  void drain(p.stdout, (t) => (out += t));
  void drain(p.stderr, (t) => (err += t));
  const type = (text: string) => { p.stdin.write(text + "\n"); p.stdin.flush(); };
  const until = async (what: string, f: () => boolean) => { for (let i = 0; i < 400; i++) { if (f()) return; await Bun.sleep(25); } throw new Error(`never: ${what}\nstdout:\n${out}\nstderr:\n${err}`); };
  try {
    // The first read of the question fails; the terminal says so and reads it again at its next look.
    await until("the failed read is told", () => err.includes("a question could not be read (the store is busy); it is read again shortly"));
    await until("the question is shown after the read was made again", () => out.includes("?? question (Pick): Which color?") && out.includes("   2. Amber"));
    expect(failed).toBe(1);
    expect(out.split("?? question (Pick): Which color?").length - 1).toBe(1);
    expect(err).not.toMatch(/Unhandled|unhandled|error: /);
    // Answered; then the second question opens just after a look, and the owner's line arrives before the next one.
    typeSecond = () => type("/answer 1");
    type("/answer 2");
    await until("the first answer is sent", () => answers.length === 1);
    expect(answers[0]).toEqual(["q1", { "0": { picked: ["Amber"] } }]);
    await until("the new question is shown and not answered", () => out.includes("?? question (Pick): Which size?") && err.includes("this question is new here, shown above: nothing was answered"));
    await Bun.sleep(200);
    expect(answers).toHaveLength(1);
    // Read now, the same line answers it.
    type("/answer 1");
    await until("the second answer is sent", () => answers.length === 2);
    expect(answers[1]).toEqual(["q2", { "0": { picked: ["Small"] } }]);
    type("/detach");
    expect(await p.exited).toBe(0);
  } finally {
    p.kill();
    server.stop(true);
  }
}, 30_000);

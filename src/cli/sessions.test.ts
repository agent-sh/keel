// What `keel send` says when the daemon does not take the prompt cleanly: a
// stand-in daemon answers the way a failing one does (a real daemon gives a
// 500 or a dropped answer only when something in it breaks).
import { expect, spyOn, test } from "bun:test";
import { ApiError, Client } from "./client.ts";
import { sendFailure, sessionCommands } from "./sessions.ts";

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

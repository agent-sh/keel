import { expect, test, type APIRequestContext, type Page } from "./isolate.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HAIKU, ask, shoot } from "./shots.ts";

// A command a session runs is a process of the owner's account on loopback, but it is not the owner:
// a request it makes to the daemon's API has its session's authority only. It reads its own session and
// nothing else, changes nothing (not even its own mode or approvals), and the access token it can read
// from disk outside the sandbox does not make it the owner. The same requests from the owner's own
// process (this test's) pass the door. Inside the sandbox the API is not reachable at all.
type Route = { name: string; method: string; path: string; body?: unknown; token?: boolean };

const routes = (id: string, other: string): Route[] => [
  { name: "read-other", method: "GET", path: `/api/sessions/${other}` },
  { name: "read-other-with-token", method: "GET", path: `/api/sessions/${other}`, token: true },
  { name: "list-sessions", method: "GET", path: "/api/sessions" },
  { name: "read-token", method: "GET", path: "/api/remote-access" },
  { name: "read-vault", method: "GET", path: "/api/secrets" },
  { name: "read-other-secrets", method: "GET", path: `/api/sessions/${other}/secrets` },
  { name: "read-own-secrets", method: "GET", path: `/api/sessions/${id}/secrets` },
  { name: "approve-card", method: "POST", path: `/api/sessions/${id}/approvals/none`, body: { choice: "once" } },
  { name: "change-own-mode", method: "PUT", path: `/api/sessions/${id}/permissions`, body: { mode: "full-auto", sandbox: "off" } },
  { name: "change-other-mode", method: "PUT", path: `/api/sessions/${other}/permissions`, body: { mode: "full-auto" }, token: true },
  { name: "stop-other", method: "POST", path: `/api/sessions/${other}/interrupt`, body: {} },
  { name: "message-other", method: "POST", path: `/api/sessions/${other}/messages`, body: { text: "" } },
  { name: "delete-session", method: "DELETE", path: `/api/sessions/none-${id}` },
  { name: "edit-settings", method: "PATCH", path: "/api/settings", body: {} },
  { name: "default-mode", method: "PUT", path: "/api/permissions/settings", body: {} },
  { name: "widen-sandbox", method: "PUT", path: "/api/permissions/sandbox", body: { workspace: 5 } },
  { name: "install-ui", method: "POST", path: "/api/ui", body: "not a bundle" },
  { name: "add-mcp-server", method: "POST", path: "/api/mcp/servers", body: {} },
  { name: "trust-hooks", method: "POST", path: "/api/hooks/trust", body: {} },
  { name: "drain", method: "POST", path: "/api/drain", body: { timeout_seconds: "x" } },
  { name: "run", method: "POST", path: "/api/run", body: {} },
  { name: "errors", method: "GET", path: "/api/errors" },
  { name: "daemon", method: "GET", path: "/api/daemon" },
  { name: "socket", method: "GET", path: "/ws" },
];

// The probe, as a shell script in the workspace: one line per route, its status and the start of its answer.
function probe(api: string, tokenFile: string, list: Route[], own: string): string {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const lines = list.map((r) => {
    const args = ["-X", r.method, ...(r.body !== undefined ? ["-H", "content-type: application/json", "--data-binary", typeof r.body === "string" ? r.body : JSON.stringify(r.body)] : [])];
    return `r ${r.name} ${args.map(q).join(" ")} ${r.token ? `-H "authorization: Bearer $(cat ${q(tokenFile)})"` : ""} ${q(api + r.path)}`;
  });
  return [
    `d=$(mktemp -d)`,
    `r() { n=$1; shift; c=$(curl -s -m 5 --noproxy '*' -o "$d/b" -w '%{http_code}' "$@"); echo "$n $c $(head -c 400 "$d/b" 2>/dev/null | tr '\\n' ' ')"; }`,
    ...lines,
    `r own-session -X GET ${q(`${api}/api/sessions/${own}?events=0`)}`,
    // A process that left the command's scope for one of its own (as `systemd-run --scope` does), where the machine has scopes.
    `if systemd-run --user --scope --quiet true 2>/dev/null; then echo "via-scope $(systemd-run --user --scope --quiet -- curl -s -m 5 --noproxy '*' -o /dev/null -w '%{http_code}' ${q(api + "/api/remote-access")})"; else echo "via-scope none"; fi`,
    // A child that outlives the command and asks once the command has ended.
    `setsid bash -c ${q(`sleep 1; curl -s -m 5 --noproxy '*' -o /dev/null -w 'late %{http_code}' ${api}/api/remote-access > late.out`)} < /dev/null > /dev/null 2>&1 &`,
    `echo probed`,
  ].join("\n") + "\n";
}

async function run(page: Page, request: APIRequestContext, id: string, command: string, n: number): Promise<string> {
  await page.getByTestId("composer").fill(ask(`Run this command and end your turn: ${command}`, `script:calls ${JSON.stringify([{ name: "Bash", input: { command } }])}`));
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await page.getByTestId("turn-end").count()) >= n || (await page.getByTestId("approval").count()) > 0, { timeout: 60_000 }).toBe(true);
  if ((await page.getByTestId("turn-end").count()) < n) {
    const card = page.getByTestId("approval").first();
    if (await card.getByTestId("approval-expand").count()) await card.getByTestId("approval-expand").click();
    await card.getByTestId("allow-once").click();
  }
  await expect(page.getByTestId("turn-end")).toHaveCount(n, { timeout: 60_000 });
  const events = (await (await request.get(`/api/sessions/${id}`)).json()).events as any[];
  return String(events.filter((e) => e.kind === "tool_result").at(-1)!.data.results[0].content);
}

const statusOf = (out: string, name: string) => new RegExp(`^${name} (\\d{3}) (.*)$`, "m").exec(out);

async function setup(request: APIRequestContext, tag: string) {
  const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `authority-${tag}-${Date.now()}`);
  mkdirSync(ws, { recursive: true });
  const { session: other } = await (await request.post("/api/sessions", { data: { workspace: ws, model: HAIKU, title: `OTHER-SESSION-${Date.now()}` } })).json();
  const { session } = await (await request.post("/api/sessions", { data: { workspace: ws, model: HAIKU } })).json();
  const daemon = await (await request.get("/api/daemon")).json();
  return { ws, other, id: session.id as string, tokenFile: join(daemon.state_dir, "api-token") };
}

test("a session's command outside the sandbox has its session's authority only, and the owner's requests pass", async ({ page, request, baseURL }) => {
  const { ws, other, id, tokenFile } = await setup(request, "off");
  const api = `http://127.0.0.1:${new URL(baseURL!).port}`;
  const list = routes(id, other.id);
  writeFileSync(join(ws, "probe.sh"), probe(api, tokenFile, list, id));
  await request.put(`/api/sessions/${id}/permissions`, { data: { mode: "full-auto", sandbox: "off" } });
  await page.goto(`/s/${id}`);
  const out = await run(page, request, id, "bash probe.sh", 1);
  expect(out).toContain("probed");
  for (const r of list) {
    const m = statusOf(out, r.name);
    expect({ route: r.name, status: m?.[1], says: m?.[2]?.includes("acts with that session's authority only") }).toEqual({ route: r.name, status: "403", says: true });
  }
  expect(statusOf(out, "read-token")![2]).toContain(`a command of session ${id} acts with that session's authority only`);
  expect(out).not.toContain(other.title);
  expect(out).not.toContain("/api/remote/enter?token=");
  const via = /^via-scope (\S+)$/m.exec(out)?.[1];
  if (via !== "none") expect(via).toBe("403");
  // Its own session it reads.
  expect(statusOf(out, "own-session")?.[1]).toBe("200");
  // A child that outlived the command, asking after the command ended: still the session's.
  const late = await run(page, request, id, "for i in $(seq 100); do [ -s late.out ] && break; sleep 0.1; done; cat late.out", 2);
  expect(late).toContain("late 403");
  // Nothing changed: the other session is as it was, the session's own mode too.
  expect((await (await request.get(`/api/sessions/${other.id}/permissions`)).json()).perm.mode).not.toBe("full-auto");
  await page.getByTestId("tool-call").first().click();
  await expect(page.getByTestId("tool-call").first()).toContainText("authority only");
  await shoot(page, "session-authority-01-refused");

  // The owner's own process (this test, as the command line is) passes the door on every route.
  const token = (await (await request.get("/api/remote-access")).json()).path.split("token=")[1];
  for (const r of list) {
    if (r.name === "change-other-mode") continue; // (the owner's mode change is real: left out)
    const res = await request.fetch(r.path, { method: r.method, headers: { ...(r.body !== undefined ? { "content-type": "application/json" } : {}), ...(r.token ? { authorization: `Bearer ${decodeURIComponent(token)}` } : {}) }, data: typeof r.body === "string" ? r.body : r.body === undefined ? undefined : JSON.stringify(r.body) });
    const text = await res.text();
    expect({ route: r.name, refused: res.status() === 403, says: text.includes("authority only") }).toEqual({ route: r.name, refused: false, says: false });
  }
});

test("a sandboxed command does not reach the daemon's API at all", async ({ page, request, baseURL }) => {
  const settings = await (await request.get("/api/permissions/settings")).json();
  test.skip(!settings.sandbox.available, `needs the sandbox: ${settings.sandbox.reason}`);
  const { ws, other, id, tokenFile } = await setup(request, "on");
  const api = `http://127.0.0.1:${new URL(baseURL!).port}`;
  const list = routes(id, other.id);
  writeFileSync(join(ws, "probe.sh"), probe(api, tokenFile, list, id));
  await request.put(`/api/sessions/${id}/permissions`, { data: { mode: "full-auto", sandbox: "workspace-write", network: true } });
  await page.goto(`/s/${id}`);
  const out = await run(page, request, id, "bash probe.sh", 1);
  expect(out).toContain("probed");
  for (const r of list) expect({ route: r.name, status: statusOf(out, r.name)?.[1] }).toEqual({ route: r.name, status: "000" });
  expect(out).not.toContain(other.title);
  await shoot(page, "session-authority-02-sandboxed");
});

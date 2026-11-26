import { expect, test, type APIRequestContext, type Page } from "./isolate.ts";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HAIKU, SCRIPTED, ask, endsAre, shoot, turnEnds } from "./shots.ts";
import { ROOT, daemon, exited, sessionsFolder } from "./own-daemon.ts";

// A command a session runs is a process of the owner's account on loopback, but it is not the owner:
// a request it makes to the daemon's API has its session's authority only. A top-level session's command
// reads its own session and the daemon's read-only lists (the sessions, their events, timeline and hours,
// the agents, errors, telemetry, resources, the daemon); an agent's command reads its own session only,
// unless its parent granted it the same lists at its start (api: "read"), a grant that holds across a
// restart, passes to its own agents only when it names it again, and the owner revokes from its card.
// Neither changes anything (not even its own mode or approvals) or reads a secret, the vault, the settings
// or the access token, which it can read from disk outside the sandbox and which does not make it the
// owner. The same requests from the owner's own process (this test's) pass the door. Inside the sandbox
// the API is not reachable at all.
type Route = { name: string; method: string; path: string; body?: unknown };

// What a top-level session's command may read.
const reads = (other: string): Route[] => [
  { name: "list-sessions", method: "GET", path: "/api/sessions" },
  { name: "read-other", method: "GET", path: `/api/sessions/${other}` },
  { name: "other-events", method: "GET", path: `/api/sessions/${other}/events` },
  { name: "other-timeline", method: "GET", path: `/api/sessions/${other}/timeline` },
  { name: "other-hours", method: "GET", path: `/api/sessions/${other}/hours` },
  { name: "other-agents", method: "GET", path: `/api/sessions/${other}/agents` },
  { name: "errors", method: "GET", path: "/api/errors" },
  { name: "telemetry", method: "GET", path: "/api/telemetry" },
  { name: "resources", method: "GET", path: "/api/resources" },
  { name: "daemon", method: "GET", path: "/api/daemon" },
  { name: "automation", method: "GET", path: "/api/automation" },
];
// What no session's command may do: every write, every secret, the token, the settings, the socket.
const closed = (id: string, other: string): Route[] => [
  { name: "read-token", method: "GET", path: "/api/remote-access" },
  { name: "read-vault", method: "GET", path: "/api/secrets" },
  { name: "read-other-secrets", method: "GET", path: `/api/sessions/${other}/secrets` },
  { name: "read-own-secrets", method: "GET", path: `/api/sessions/${id}/secrets` },
  { name: "read-settings", method: "GET", path: "/api/settings" },
  { name: "approve-card", method: "POST", path: `/api/sessions/${id}/approvals/none`, body: { choice: "once" } },
  { name: "change-own-mode", method: "PUT", path: `/api/sessions/${id}/permissions`, body: { mode: "full-auto", sandbox: "off" } },
  { name: "change-other-mode", method: "PUT", path: `/api/sessions/${other}/permissions`, body: { mode: "full-auto" } },
  { name: "stop-other", method: "POST", path: `/api/sessions/${other}/interrupt`, body: {} },
  { name: "message-other", method: "POST", path: `/api/sessions/${other}/messages`, body: { text: "" } },
  { name: "create-session", method: "POST", path: "/api/sessions", body: { workspace: "/nonexistent-authority-probe" } },
  { name: "delete-session", method: "DELETE", path: `/api/sessions/none-${id}` },
  { name: "edit-settings", method: "PATCH", path: "/api/settings", body: {} },
  { name: "default-mode", method: "PUT", path: "/api/permissions/settings", body: {} },
  { name: "widen-sandbox", method: "PUT", path: "/api/permissions/sandbox", body: { workspace: 5 } },
  { name: "install-ui", method: "POST", path: "/api/ui", body: "not a bundle" },
  { name: "add-mcp-server", method: "POST", path: "/api/mcp/servers", body: {} },
  { name: "trust-hooks", method: "POST", path: "/api/hooks/trust", body: {} },
  { name: "drain", method: "POST", path: "/api/drain", body: { timeout_seconds: "x" } },
  { name: "run", method: "POST", path: "/api/run", body: {} },
  { name: "errors-read-all", method: "POST", path: "/api/errors/read-all", body: {} },
  { name: "socket", method: "GET", path: "/ws" },
];
const all = (id: string, other: string) => [...reads(other), ...closed(id, other)];

// The probe, as a shell script in the workspace: one line per route, its status and the start of its answer,
// each route asked twice, without the token and with it (NAME+t). The whole answers go to bodies.out.
function probe(api: string, tokenFile: string, list: Route[], other: string): string {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const port = new URL(api).port;
  const lines = list.flatMap((r) => {
    const args = ["-X", r.method, ...(r.body !== undefined ? ["-H", "content-type: application/json", "--data-binary", typeof r.body === "string" ? r.body : JSON.stringify(r.body)] : [])];
    return [`r ${r.name} ${args.map(q).join(" ")} ${q(api + r.path)}`, `r ${r.name}+t ${args.map(q).join(" ")} -H "authorization: Bearer $(cat ${q(tokenFile)})" ${q(api + r.path)}`];
  });
  return [
    `d=$(mktemp -d); : > bodies.out`,
    `r() { n=$1; shift; c=$(curl -s -m 5 --noproxy '*' -o "$d/b" -w '%{http_code}' "$@"); cat "$d/b" >> bodies.out 2>/dev/null; echo >> bodies.out; echo "$n $c $(head -c 400 "$d/b" 2>/dev/null | tr '\\n' ' ')"; }`,
    ...lines,
    `r own-session -X GET "${api}/api/sessions/$KEEL_SESSION?events=0"`,
    // A process that left the command's scope for one of its own (as `systemd-run --scope` does), where the machine has scopes.
    `if systemd-run --user --scope --quiet true 2>/dev/null; then echo "via-scope $(systemd-run --user --scope --quiet -- curl -s -m 5 --noproxy '*' -o /dev/null -w '%{http_code}' ${q(api + "/api/remote-access")})"; else echo "via-scope none"; fi`,
    // A child that outlives the command and asks once the command has ended.
    `setsid bash -c ${q(`sleep 1; curl -s -m 5 --noproxy '*' -o /dev/null -w 'late %{http_code}' ${api}/api/remote-access > late.out`)} < /dev/null > /dev/null 2>&1 &`,
    // A request sent and the connection reset before the daemon reads who made it: carried out for no one.
    `python3 - <<'PY'\nimport socket, struct\nbody = '{"mode":"full-auto"}'\nfor _ in range(10):\n    s = socket.create_connection(("127.0.0.1", ${port}))\n    s.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))\n    s.sendall(("PUT /api/sessions/${other}/permissions HTTP/1.1\\r\\nHost: 127.0.0.1:${port}\\r\\nContent-Type: application/json\\r\\nContent-Length: %d\\r\\n\\r\\n%s" % (len(body), body)).encode())\n    s.close()\nPY`,
    `echo probed`,
  ].join("\n") + "\n";
}

async function run(page: Page, request: APIRequestContext, id: string, command: string, n: number): Promise<string> {
  await page.getByTestId("composer").fill(ask(`Run this command and end your turn: ${command}`, `script:calls ${JSON.stringify([{ name: "Bash", input: { command } }])}`));
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await turnEnds(page)) >= n || (await page.getByTestId("approval").count()) > 0, { timeout: 60_000 }).toBe(true);
  if ((await turnEnds(page)) < n) {
    const card = page.getByTestId("approval").first();
    if (await card.getByTestId("approval-expand").count()) await card.getByTestId("approval-expand").click();
    await card.getByTestId("allow-once").click();
  }
  await endsAre(page, n, 60_000);
  const events = (await (await request.get(`/api/sessions/${id}`)).json()).events as any[];
  return String(events.filter((e) => e.kind === "tool_result").at(-1)!.data.results[0].content);
}

const statusOf = (out: string, name: string) => new RegExp(`^${name.replace("+", "\\+")} (\\d{3}) (.*)$`, "m").exec(out);

async function setup(request: APIRequestContext, tag: string, model = HAIKU) {
  const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `authority-${tag}-${Date.now()}`);
  mkdirSync(ws, { recursive: true });
  const { session: other } = await (await request.post("/api/sessions", { data: { workspace: ws, model: HAIKU, title: `OTHER-SESSION-${Date.now()}` } })).json();
  const { session } = await (await request.post("/api/sessions", { data: { workspace: ws, model } })).json();
  const daemon = await (await request.get("/api/daemon")).json();
  return { ws, other, id: session.id as string, tokenFile: join(daemon.state_dir, "api-token") };
}

// The probe's lines and what it read, from the workspace (too long for a tool's output).
const probeOut = (ws: string) => readFileSync(join(ws, "probe.out"), "utf8");
const bodies = (ws: string) => readFileSync(join(ws, "bodies.out"), "utf8");
const PROBE = "bash probe.sh > probe.out 2>&1; tail -n 1 probe.out";
const said = (m: RegExpExecArray | null) => !!m?.[2]?.includes("acts with that session's authority only");

// Each closed route refused with the reason, with and without the token.
function expectClosed(out: string, list: Route[]) {
  for (const r of list) for (const n of [r.name, `${r.name}+t`]) {
    const m = statusOf(out, n);
    expect({ route: n, status: m?.[1], says: said(m) }).toEqual({ route: n, status: "403", says: true });
  }
}

test("a top-level session's command reads the daemon's lists, changes nothing and reads no secret, and the owner's requests pass", async ({ page, request, baseURL }) => {
  const { ws, other, id, tokenFile } = await setup(request, "off");
  const api = `http://127.0.0.1:${new URL(baseURL!).port}`;
  // A secret in the other session's history: kept as a placeholder, so no list carries its value.
  const secret = `ghp_${Date.now().toString(36)}a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5`.slice(0, 40);
  await request.post(`/api/sessions/${other.id}/messages`, { data: { text: ask(`Reply ok. (deploy key ${secret})`, `script:say ok ${secret}`) } });
  await expect.poll(async () => JSON.stringify(await (await request.get(`/api/sessions/${other.id}`)).json()).includes("[secret:"), { timeout: 60_000 }).toBe(true);
  writeFileSync(join(ws, "probe.sh"), probe(api, tokenFile, all(id, other.id), other.id));
  await request.put(`/api/sessions/${id}/permissions`, { data: { mode: "full-auto", sandbox: "off" } });
  await page.goto(`/s/${id}`);
  expect(await run(page, request, id, PROBE, 1)).toContain("probed");
  const out = probeOut(ws);
  for (const r of reads(other.id)) for (const n of [r.name, `${r.name}+t`]) expect({ route: n, status: statusOf(out, n)?.[1] }).toEqual({ route: n, status: "200" });
  expect(out).toContain(other.title); // the list and the other session's reads are its
  expectClosed(out, closed(id, other.id));
  expect(statusOf(out, "read-token")![2]).toContain(`a command of session ${id} acts with that session's authority only`);
  expect(statusOf(out, "read-token")![2]).toContain("the daemon's read-only lists");
  // No secret value in anything it read: not the other session's, not the access token.
  const token = readFileSync(tokenFile, "utf8").trim();
  expect(bodies(ws)).not.toContain(secret);
  expect(bodies(ws)).not.toContain(token);
  expect(out).not.toContain("/api/remote/enter?token=");
  const via = /^via-scope (\S+)$/m.exec(out)?.[1];
  if (via !== "none") expect(via).toBe("403");
  expect(statusOf(out, "own-session")?.[1]).toBe("200");
  // A child that outlived the command, asking after the command ended: still the session's.
  const late = await run(page, request, id, "for i in $(seq 100); do [ -s late.out ] && break; sleep 0.1; done; cat late.out", 2);
  expect(late).toContain("late 403");
  // Nothing changed: the other session is as it was (the reset requests too), the session's own mode too.
  expect((await (await request.get(`/api/sessions/${other.id}/permissions`)).json()).perm.mode).not.toBe("full-auto");
  await page.getByTestId("tool-call").first().click();
  await shoot(page, "session-authority-01-top-level");

  // The owner's own process (this test, as the command line is) passes the door on every route.
  const link = (await (await request.get("/api/remote-access")).json()).path.split("token=")[1];
  for (const r of all(id, other.id)) {
    if (r.name === "change-other-mode") continue; // (the owner's mode change is real: left out)
    const res = await request.fetch(r.path, { method: r.method, headers: { ...(r.body !== undefined ? { "content-type": "application/json" } : {}), authorization: `Bearer ${decodeURIComponent(link)}` }, data: typeof r.body === "string" ? r.body : r.body === undefined ? undefined : JSON.stringify(r.body) });
    const text = await res.text();
    expect({ route: r.name, refused: res.status() === 403, says: text.includes("authority only") }).toEqual({ route: r.name, refused: false, says: false });
  }
});

test("an agent's command reads its own session only", async ({ page, request, baseURL }) => {
  // (The stand-in of a Claude model, whose tools hold Agent, where the daemon is scripted.)
  const { ws, other, id, tokenFile } = await setup(request, "agent", SCRIPTED ? "scripted:claude-stand-in" : HAIKU);
  const api = `http://127.0.0.1:${new URL(baseURL!).port}`;
  writeFileSync(join(ws, "probe.sh"), probe(api, tokenFile, all(id, other.id), other.id));
  await request.put(`/api/sessions/${id}/permissions`, { data: { mode: "full-auto", sandbox: "off" } });
  await page.goto(`/s/${id}`);
  const bash = `script:calls ${JSON.stringify([{ name: "Bash", input: { command: PROBE } }])}`;
  const call = { name: "Agent", input: { description: "Probe the API", prompt: ask(`Run this command and report its last line: ${PROBE}`, bash) } };
  await page.getByTestId("composer").fill(ask(`Start one agent with the Agent tool, description "Probe the API", prompt: run exactly this command and report its last line: ${PROBE}`, `script:calls ${JSON.stringify([call])}`));
  await page.keyboard.press("Enter");
  await expect.poll(() => { try { return probeOut(ws).includes("probed"); } catch { return false; } }, { timeout: 120_000 }).toBe(true);
  const out = probeOut(ws);
  // Its own session it reads; nothing of another, not the list, not the daemon's lists.
  expect(statusOf(out, "own-session")?.[1]).toBe("200");
  const agent = /^own-session 200 .*?"id":"([^"]+)"/m.exec(out)?.[1];
  expect(agent).not.toBe(id);
  expect((await (await request.get(`/api/sessions/${agent}`)).json()).session.parent_id).toBe(id);
  expectClosed(out, [...reads(other.id), ...closed(id, other.id)]);
  expect(out).not.toContain(other.title);
  expect(statusOf(out, "list-sessions")![2]).not.toContain("read-only lists");
  // It says what its parent would pass for it.
  expect(statusOf(out, "list-sessions")![2]).toContain('granted it at its start (api: \\"read\\")');
  // The reset requests changed nothing.
  expect((await (await request.get(`/api/sessions/${other.id}/permissions`)).json()).perm.mode).not.toBe("full-auto");
  await shoot(page, "session-authority-02-agent");
});

test("a sandboxed command does not reach the daemon's API at all", async ({ page, request, baseURL }) => {
  const settings = await (await request.get("/api/permissions/settings")).json();
  test.skip(!settings.sandbox.available, `needs the sandbox: ${settings.sandbox.reason}`);
  const { ws, other, id, tokenFile } = await setup(request, "on");
  const api = `http://127.0.0.1:${new URL(baseURL!).port}`;
  const list = all(id, other.id);
  writeFileSync(join(ws, "probe.sh"), probe(api, tokenFile, list, other.id));
  await request.put(`/api/sessions/${id}/permissions`, { data: { mode: "full-auto", sandbox: "workspace-write", network: true } });
  await page.goto(`/s/${id}`);
  expect(await run(page, request, id, PROBE, 1)).toContain("probed");
  const out = probeOut(ws);
  for (const r of list) expect({ route: r.name, status: statusOf(out, r.name)?.[1] }).toEqual({ route: r.name, status: "000" });
  expect(out).not.toContain(other.title);
  await shoot(page, "session-authority-03-sandboxed");
});

test("an agent its parent granted reads the daemon's lists, its own agent does not unless passed, the grant holds across a restart and the owner revokes it", async ({ page }) => {
  test.setTimeout(300_000);
  // A daemon of its own: the spec stops and starts it.
  const state = join(ROOT, `authority-grant-${Date.now()}`);
  let d = await daemon(state);
  const api = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
    fetch(d.url + path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }).then((r) => r.json() as any);
  try {
    const ws = join(sessionsFolder(state), "authority");
    mkdirSync(ws, { recursive: true });
    const { session: other } = await api("/api/sessions", { workspace: ws, model: "scripted:stand-in", title: `OTHER-SESSION-${Date.now()}` });
    const { session } = await api("/api/sessions", { workspace: ws, model: "scripted:claude-stand-in", title: "Grants" });
    const id = session.id as string;
    await api(`/api/sessions/${id}/permissions`, { mode: "full-auto", sandbox: "off" }, "PUT");
    writeFileSync(join(ws, "probe.sh"), probe(d.url, join(state, "api-token"), all(id, other.id), other.id));
    const out = (name: string) => { try { return readFileSync(join(ws, name), "utf8"); } catch { return ""; } };
    const bash = (command: string) => `script:calls ${JSON.stringify([{ name: "Bash", input: { command } }])}`;
    // The granted agent probes, then starts an agent of its own without passing the grant, which probes too.
    // (The child tries to pass on a grant it does not hold first.)
    const widen = { name: "Agent", input: { description: "Widened", prompt: "script:say no", api: "read" } };
    const child = { name: "Agent", input: { description: "Ungranted child", prompt: `script:calls ${JSON.stringify([widen, { name: "Bash", input: { command: "bash probe.sh > child.out 2>&1; tail -n 1 child.out" } }])}` } };
    const granted = `script:calls ${JSON.stringify([{ name: "Bash", input: { command: "bash probe.sh > granted.out 2>&1; tail -n 1 granted.out" } }, child])}`;
    await api(`/api/sessions/${id}/messages`, { text: `script:calls ${JSON.stringify([{ name: "Agent", input: { description: "Granted probe", prompt: granted, api: "read" } }])}` });
    await expect.poll(() => out("child.out").includes("probed"), { timeout: 120_000 }).toBe(true);

    const g = out("granted.out");
    for (const r of reads(other.id)) for (const n of [r.name, `${r.name}+t`]) expect({ route: n, status: statusOf(g, n)?.[1] }).toEqual({ route: n, status: "200" });
    expect(g).toContain(other.title);
    expectClosed(g, closed(id, other.id));
    expect(statusOf(g, "read-token")![2]).toContain("the daemon's read-only lists (its parent granted them)");
    expect(bodies(ws)).not.toContain(readFileSync(join(state, "api-token"), "utf8").trim());
    // Its own agent, started without the grant: its own session only.
    const c = out("child.out");
    expect(statusOf(c, "own-session")?.[1]).toBe("200");
    expectClosed(c, [...reads(other.id), ...closed(id, other.id)]);
    expect(c).not.toContain(other.title);

    const agent = (await api(`/api/sessions/${id}/agents`)).agents.find((a: any) => a.title === "Granted probe");
    expect(agent.api).toBe("read");
    const below = (await api(`/api/sessions/${agent.session_id}/agents`)).agents.find((a: any) => a.title === "Ungranted child");
    expect(below.api ?? null).toBeNull();
    // The agent's task told it what it holds.
    const task = (await api(`/api/sessions/${agent.session_id}`)).events.find((e: any) => e.kind === "user").data.text as string;
    expect(task).toContain("Your commands may read the daemon's read-only lists");
    // It cannot widen what it has: its spawn that names the grant is refused, and no agent is made.
    const refused = (await api(`/api/sessions/${below.session_id}`)).events.filter((e: any) => e.kind === "tool_result").map((e: any) => JSON.stringify(e.data)).join("\n");
    expect(refused).toContain("is given only by a session whose own commands read the daemon's lists");
    expect((await api(`/api/sessions/${below.session_id}/agents`)).agents).toEqual([]);

    // A restart: the grant is the agent's record, kept on disk.
    d.proc.kill("SIGTERM");
    await exited(d.proc);
    d = await daemon(state);
    await expect.poll(async () => (await api(`/api/sessions/${id}/agents`)).agents?.find((a: any) => a.id === agent.id)?.api, { timeout: 30_000 }).toBe("read");

    // The agent reads the list again and again in one command; the owner revokes from its card while it does,
    // and the next request is refused.
    await api(`/api/sessions/${id}/agents/${agent.id}/start`, { force: "carry" }, "PUT");
    const poll = `for i in $(seq 600); do echo "$(curl -s -m 5 --noproxy '*' -o /dev/null -w '%{http_code}' ${d.url}/api/sessions)" >> poll.out; [ -e stop.flag ] && break; sleep 0.1; done; echo polled`;
    await api(`/api/sessions/${id}/agents/${agent.id}/message`, { message: bash(poll) });
    await expect.poll(() => out("poll.out").includes("200"), { timeout: 60_000 }).toBe(true);
    await page.setViewportSize({ width: 1920, height: 1040 });
    await page.goto(`${d.url}/s/${id}`);
    await page.getByTestId("lens-to-stream").click({ timeout: 10_000 });
    const card = page.getByTestId("agent-call").filter({ hasText: "Granted probe" });
    await expect(card.getByTestId("agent-call-api")).toHaveText("reads API");
    await shoot(page, "session-authority-04-granted-line");
    await card.getByTestId("agent-call-title").click();
    await expect(card.getByTestId("agent-api")).toHaveAttribute("data-grant", "read");
    await shoot(page, "session-authority-05-granted-card");
    await card.getByTestId("agent-api-revoke").click();
    await expect(card.getByTestId("agent-api")).toHaveAttribute("data-grant", "revoked");
    await expect(card.getByTestId("agent-call-api")).toHaveCount(0);
    await expect.poll(() => out("poll.out").includes("403"), { timeout: 30_000 }).toBe(true);
    writeFileSync(join(ws, "stop.flag"), "");
    // 200 until the revoke, 403 from the request after it on, in the same command.
    const seen = out("poll.out").trim().split("\n");
    const first = seen.indexOf("403");
    expect(seen.slice(0, first).every((s) => s === "200")).toBe(true);
    expect(seen.slice(first).every((s) => s === "403")).toBe(true);
    expect((await api(`/api/sessions/${id}/agents`)).agents.find((a: any) => a.id === agent.id).api).toBe("revoked");
    await shoot(page, "session-authority-06-revoked");
  } finally {
    d.proc.kill("SIGTERM");
    await exited(d.proc);
  }
});

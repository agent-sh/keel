// Who a loopback caller is, from the kernel's record of its socket and where sessions' commands run.
// The e2e (test/e2e/session-authority.spec.ts) shows a command refused; these are the cases it cannot
// stage: a process that ended, a pid used again, a kernel that does not say.
import { expect, test } from "bun:test";
import { blindTo, namedSessions, peerAuthority, peerVerdict, sessionMay, type Authority, type ListReach, type PeerFacts } from "./peer-scope.ts";

const scopes = new Map<bigint, string>([[101n, "s-a"], [102n, "s-b"]]);
const of = (o: Partial<PeerFacts>): PeerFacts => ({ facts: { uid: 1000, inode: 55, cgroup: 9n }, linux: true, cgroups: scopes, loose: false, holder: () => null, ...o });

test("a socket made in a session's scope is that session's, whatever happened to its maker since", () => {
  expect(peerAuthority(of({ facts: { uid: 1000, inode: 55, cgroup: 102n } }))).toEqual({ kind: "session", session: "s-b", by: "cgroup" });
  // Its maker ended (no process holds it, inode 0): still that session's, never the owner's.
  expect(peerAuthority(of({ facts: { uid: 1000, inode: 0, cgroup: 101n } }))).toEqual({ kind: "session", session: "s-a", by: "cgroup" });
  // Its pid is now another process's, which holds no such socket: the record names the cgroup, not a pid.
  expect((peerAuthority(of({ facts: { uid: 1000, inode: 55, cgroup: 101n }, holder: () => null })) as Authority).kind).toBe("session");
});

test("a socket made elsewhere is the owner's while a process holds it, and refused once none does", () => {
  expect(peerAuthority(of({}))).toEqual({ kind: "owner" });
  // The process that made it closed it or ended before it was answered: who made it cannot be told.
  expect(peerAuthority(of({ facts: { uid: 1000, inode: 0, cgroup: 9n } }))).toEqual({ kind: "ended" });
  expect(peerAuthority(of({ facts: { uid: 1000, inode: 0, cgroup: 9n }, cgroups: new Map() }))).toEqual({ kind: "ended" });
});

test("without cgroups the socket is found by its open file among the sessions' processes", async () => {
  const holder = (inode: number) => (inode === 55 ? "s-c" : null);
  expect(peerAuthority(of({ loose: true, holder }))).toEqual({ kind: "session", session: "s-c", by: "process" });
  expect(peerAuthority(of({ loose: true, holder, facts: { uid: 1000, inode: 56, cgroup: 9n } }))).toEqual({ kind: "owner" });
  // A kernel that does not record the cgroup: the open file decides, also for commands in scopes.
  expect(peerAuthority(of({ holder, facts: { uid: 1000, inode: 55, cgroup: null } }))).toEqual({ kind: "session", session: "s-c", by: "process" });
  // Nothing a session runs, and no cgroup said: nobody is asked.
  let asked = 0;
  expect(peerAuthority(of({ cgroups: new Map(), holder: () => (asked++, "s-c"), facts: { uid: 1000, inode: 55, cgroup: null } }))).toEqual({ kind: "owner" });
  expect(asked).toBe(0);
  // Read off the loop where no cgroup holds them: the answer waits for the read.
  expect(await peerAuthority(of({ loose: true, holder: async () => "s-d" }))).toEqual({ kind: "session", session: "s-d", by: "process" });
  expect(await peerAuthority(of({ loose: true, holder: async () => null }))).toEqual({ kind: "owner" });
});

test("no record of the socket: unknown while sessions run, and elsewhere than Linux nothing changes", () => {
  expect(peerAuthority(of({ facts: null }))).toEqual({ kind: "unknown" });
  expect(peerAuthority(of({ facts: null, cgroups: new Map(), loose: true }))).toEqual({ kind: "unknown" });
  expect(peerAuthority(of({ facts: null, cgroups: new Map() }))).toEqual({ kind: "owner" });
  expect(peerAuthority(of({ facts: null, linux: false, loose: true }))).toEqual({ kind: "owner" });
});

test("a session's command reads its own session and nothing else, and changes nothing", () => {
  const may = (m: string, p: string) => sessionMay(m, p, "s-a");
  expect([may("GET", "/api/sessions/s-a"), may("GET", "/api/sessions/s-a/plan"), may("HEAD", "/api/sessions/s-a/events"), may("GET", "/api/health")]).toEqual([true, true, true, true]);
  // Another session, the list, its own secrets, an approval or a mode of its own, the token, the settings.
  for (const [m, p] of [["GET", "/api/sessions/s-b"], ["GET", "/api/sessions"], ["GET", "/api/sessions/s-a/secrets"], ["POST", "/api/sessions/s-a/approvals/x"],
    ["PUT", "/api/sessions/s-a/permissions"], ["GET", "/api/remote-access"], ["PUT", "/api/settings"], ["GET", "/ws"], ["GET", "/api/sessions/s-a%2F..%2Fs-b"], ["GET", "/api/sessions/s-a//x"], ["GET", "/api/sessions/s-ab"]])
    expect({ m, p, ok: may(m!, p!) }).toEqual({ m, p, ok: false });
});

test("a top-level session's command reads the daemon's lists too, never a secret and never a write", () => {
  const top = (m: string, p: string) => sessionMay(m, p, "s-a", true);
  for (const p of ["/api/sessions", "/api/sessions/s-b", "/api/sessions/s-b/events", "/api/sessions/s-b/timeline", "/api/sessions/s-b/hours", "/api/sessions/s-b/agents",
    "/api/sessions/s-b/agents/a1/report", "/api/errors", "/api/telemetry", "/api/telemetry/tokens", "/api/usage", "/api/usage/drivers", "/api/resources", "/api/daemon", "/api/health", "/api/automation", "/api/automation/now"])
    expect({ p, ok: top("GET", p) }).toEqual({ p, ok: true });
  for (const [m, p] of [["GET", "/api/sessions/s-b/secrets"], ["GET", "/api/sessions/s-a/secrets"], ["GET", "/api/secrets"], ["GET", "/api/remote-access"], ["GET", "/api/settings"],
    ["GET", "/ws"], ["GET", "/api/sessions/s-b/permissions"], ["GET", "/api/sessions/s-b/queue"], ["GET", "/api/telemetry/x"], ["POST", "/api/usage/rollup"], ["GET", "/api/sessions/s-b%2Fsecrets"],
    ["POST", "/api/sessions"], ["PUT", "/api/sessions/s-b/permissions"], ["POST", "/api/sessions/s-b/interrupt"], ["POST", "/api/errors/read-all"], ["DELETE", "/api/sessions/s-b"]])
    expect({ m, p, ok: top(m!, p!) }).toEqual({ m, p, ok: false });
  // An agent's command (not top-level) keeps its own session only.
  for (const p of ["/api/sessions", "/api/sessions/s-b", "/api/errors", "/api/daemon", "/api/automation", "/api/usage"]) expect({ p, ok: sessionMay("GET", p, "s-a", false) }).toEqual({ p, ok: false });
});

test("the door: a session by its standing, a socket of no maker refused, the token never deciding for one", () => {
  const req = (method: string, path: string, o: Partial<{ ownAuth: boolean; open: boolean }> = {}) => ({ method, path, ownAuth: false, open: false, ...o });
  const s: Authority = { kind: "session", session: "s-a", by: "cgroup" };
  const tops = (id: string): ListReach => (id === "s-a" ? { reads: "top" } : { reads: false, why: "no grant" });
  const none = (): ListReach => ({ reads: false, why: "its parent did not grant it" });
  expect(peerVerdict(s, req("GET", "/api/sessions"), tops)).toEqual({ pass: true });
  expect(peerVerdict(s, req("GET", "/api/sessions"), none)).toMatchObject({ refuse: expect.stringContaining("authority only") });
  expect(peerVerdict(s, req("GET", "/api/remote-access"), tops)).toMatchObject({ refuse: expect.stringContaining("read-only lists") });
  expect(peerVerdict(s, req("GET", "/portal/k/x", { open: true }), none)).toEqual({ pass: true });
  // An agent its parent granted the lists reads them as a top-level session's command does, and nothing more.
  const granted = (): ListReach => ({ reads: "granted" });
  expect(peerVerdict(s, req("GET", "/api/telemetry"), granted)).toEqual({ pass: true });
  expect(peerVerdict(s, req("GET", "/api/secrets"), granted)).toMatchObject({ refuse: expect.stringContaining("its parent granted them") });
  expect(peerVerdict(s, req("POST", "/api/sessions"), granted)).toMatchObject({ refuse: expect.any(String) });
  // A read of the lists it was not granted says why; a write or a secret does not.
  expect(peerVerdict(s, req("GET", "/api/sessions"), none)).toMatchObject({ refuse: expect.stringContaining("its parent did not grant it") });
  expect(peerVerdict(s, req("GET", "/api/secrets"), none)).toMatchObject({ refuse: expect.not.stringContaining("grant") });
  // The kernel names no maker while sessions run: refused, whatever the request carries, except where a path authenticates itself.
  expect(peerVerdict({ kind: "unknown" }, req("GET", "/api/sessions"), tops)).toMatchObject({ refuse: expect.stringContaining("cannot be told") });
  expect(peerVerdict({ kind: "unknown" }, req("GET", "/api/health", { ownAuth: true }), tops)).toEqual({ account: true });
  expect(peerVerdict({ kind: "ended" }, req("GET", "/api/health", { ownAuth: true }), tops)).toMatchObject({ refuse: expect.any(String) });
  expect(peerVerdict({ kind: "owner" }, req("PUT", "/api/settings"), tops)).toEqual({ account: true });
});

// A session another harness runs exists for the owner only: for a session's command, a request another machine
// forwarded and the phone, every request that names one is answered as for no such session.
test("the door: a session another harness runs does not exist for anyone but the owner", () => {
  const req = (path: string, o: Partial<{ search: string; linked: boolean; ownAuth: boolean }> = {}) => ({ method: "GET", path, ownAuth: false, open: false, ...o });
  const s: Authority = { kind: "session", session: "s-a", by: "cgroup" };
  const owner: Authority = { kind: "owner" };
  const tops = (): ListReach => ({ reads: "top" });
  const noReads = (): ListReach => ({ reads: false, why: "not granted" });
  const out = (id: string) => id === "o-1";
  for (const [path, search] of [["/api/sessions/o-1", ""], ["/api/sessions/o-1/events", ""], ["/api/sessions/o-1/timeline", ""], ["/api/sessions/o-1/hours", ""], ["/api/sessions/o-1/agents", ""],
    ["/api/errors", "?session=o-1"], ["/api/resources", "?session_id=o-1"], ["/api/overview", "?of=o-1"], ["/api/usage", "?children_of=o-1"], ["/api/sessions/o%2D1", ""]] as const) {
    // What it gets is what a session that does not exist gets: a refusal a missing id would get comes first, the
    // same words but for the id, before anything says whether the session is there; else the route answers it as
    // for a missing id (`then`, admission.ts standIn).
    const missing = (p: string) => p.replace("o-1", "m-1").replace("o%2D1", "m%2D1");
    const back = (v: unknown) => JSON.parse(JSON.stringify(v).replaceAll("m-1", "o-1").replaceAll("m%2D1", "o%2D1"));
    for (const [a, reach, linked] of [[s, tops, false], [s, noReads, false], [owner, tops, true]] as const) {
      const m = back(peerVerdict(a, req(missing(path), { search: missing(search), linked }), reach, out));
      const v = peerVerdict(a, req(path, { search, linked }), reach, out);
      expect({ path, search, v }).toEqual({ path, search, v: "refuse" in m ? m : { absent: "no such session", ids: ["o-1"], then: m } });
    }
    expect({ path, search, v: peerVerdict(owner, req(path, { search }), tops, out) }).toEqual({ path, search, v: { account: true } });
  }
  // The phone's signed API is blind too (its own routes leave them out: src/integrations/mobile/v1.ts).
  expect(blindTo(owner, { path: "/v1/chats" })).toBe(true);
  // Another session, and the lists, as before.
  expect(peerVerdict(s, req("/api/sessions/s-b/events"), tops, out)).toEqual({ pass: true });
  expect(peerVerdict(s, req("/api/sessions"), tops, out)).toEqual({ pass: true });
  expect(blindTo(s, { path: "/api/sessions" })).toBe(true);
  expect(blindTo(owner, { path: "/api/sessions", linked: true })).toBe(true);
  expect(blindTo(owner, { path: "/api/sessions" })).toBe(false);
  expect(namedSessions("/api/fleet/linked/sessions/o-1/events", "?of=x&session=y")).toEqual(["o-1", "y", "x"]);
  // The sessions elsewhere routes name one by the agent view's id of it, <harness>:<its own id>.
  expect(namedSessions("/api/fleet/outside/claude%3Ao-src")).toEqual(["claude:o-src"]);
  expect(namedSessions("/api/fleet/outside/settings")).toEqual([]);
  const far = (id: string) => id === "claude:o-src";
  expect(peerVerdict(owner, req("/api/fleet/outside/claude:o-src", { linked: true }), tops, far)).toEqual({ absent: "no such session", ids: ["claude:o-src"], then: { account: true } });
  expect(peerVerdict(owner, req("/api/fleet/outside/claude:o-src"), tops, far)).toEqual({ account: true });
});

// The door's stand-in (admission.ts standIn) for a request another machine forwarded: the agent view's id of an
// outside session is swapped for one of the same harness no session has, and the phone's signed API is never
// rewritten (its signature is over the url it sent; its routes leave such sessions out themselves).
test("the stand-in: the sessions elsewhere id of an outside session is swapped, the phone's url never", async () => {
  const { callerCheck, standIn, useSessionScopes } = await import("./admission.ts");
  const { innerHeaders } = await import("../safety/presence.ts");
  const OUT = "01a20000-0000-7000-8000-00000000000f";
  useSessionScopes({ cgroups: () => new Map(), loose: () => false, holder: () => null, lists: () => ({ reads: false, why: "" }), outside: (id) => id === OUT || id === "claude:src-1" });
  try {
    const srv = { port: 1, hostname: "127.0.0.1", requestIP: () => ({ address: "127.0.0.1", port: 2, family: "IPv4" }) } as any;
    const linked = (path: string) => new Request(`http://127.0.0.1:1${path}`, { headers: innerHeaders({ local: false, enrolled: true, present: null }, "far box") });
    const far = linked("/api/fleet/outside/claude:src-1?lines=5");
    await callerCheck(far, srv);
    const back = standIn(far);
    expect(typeof back).toBe("function");
    expect(new URL(far.url).pathname).toMatch(/^\/api\/fleet\/outside\/claude:[0-9a-f-]{36}$/);
    const said = await (back as (r: Response) => Promise<Response>)(Response.json({ error: `no session ${decodeURIComponent(new URL(far.url).pathname.split("/").pop()!)} is listed by the agent view now` }, { status: 404 }));
    expect(await said.json()).toEqual({ error: "no session claude:src-1 is listed by the agent view now" });
    const phone = new Request(`http://127.0.0.1:1/v1/chats/${OUT}/messages?session=${OUT}`);
    await callerCheck(phone, srv);
    expect(standIn(phone)).toBeNull();
    expect(phone.url).toBe(`http://127.0.0.1:1/v1/chats/${OUT}/messages?session=${OUT}`);
  } finally { useSessionScopes(undefined); }
});

// Who a loopback caller is, from the kernel's record of its socket and where sessions' commands run.
// The e2e (test/e2e/session-authority.spec.ts) shows a command refused; these are the cases it cannot
// stage: a process that ended, a pid used again, a kernel that does not say.
import { expect, test } from "bun:test";
import { peerAuthority, sessionMay, type Authority, type PeerFacts } from "./peer-scope.ts";

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

test("no record of the socket: the token decides while sessions run, and elsewhere than Linux nothing changes", () => {
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

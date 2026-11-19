// Pure pieces of the fleet an e2e cannot reach: the ssh configuration's hosts,
// the fence on what a peer's tool call names, and the link proof.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execArgv, outsideRoot } from "./hands.ts";
import { remoteExec } from "./remote.ts";
import { proof } from "./link.ts";
import { sshHosts } from "./sshconfig.ts";

test("ssh hosts: concrete aliases in file order, includes followed, patterns skipped", () => {
  const home = mkdtempSync(join(tmpdir(), "keel-ssh-"));
  mkdirSync(join(home, ".ssh/conf.d"), { recursive: true });
  writeFileSync(join(home, ".ssh/config"), "Include conf.d/*\nHost alpha beta\n  HostName 10.0.0.1\nHost *.corp !gamma\nHost=delta # comment\nMatch all\nHost -oProxyCommand=x\n");
  writeFileSync(join(home, ".ssh/conf.d/a"), "Host first\nHost alpha\n");
  expect(sshHosts(home)).toEqual(["first", "alpha", "beta", "delta"]);
});

test("the fence: every path spelling inside the granted root, links followed", () => {
  const root = mkdtempSync(join(tmpdir(), "keel-root-"));
  const out = mkdtempSync(join(tmpdir(), "keel-out-"));
  symlinkSync(out, join(root, "escape"));
  const spill = join(out, "spill");
  expect(outsideRoot({ file_path: "a.txt" }, root, root, spill)).toEqual([]);
  expect(outsideRoot({ file_path: "../x" }, root, root, spill)).toEqual(["../x"]);
  expect(outsideRoot({ path: "escape/f" }, root, root, spill)).toEqual(["escape/f"]);
  expect(outsideRoot({ absolute_path: "/etc/passwd" }, root, root, spill)).toEqual(["/etc/passwd"]);
  expect(outsideRoot({}, "/etc", root, spill)).toEqual(["/etc"]);
  expect(outsideRoot({ input: "*** Begin Patch\n*** Update File: ../../x\n*** End Patch" }, root, root, spill)).toEqual(["../../x"]);
  expect(outsideRoot({ file_path: join(spill, "out.txt") }, root, root, spill)).toEqual([]); // the connection's own output files
});

test("the proof binds the nonce and the answering daemon", () => {
  expect(proof("k", "n1", "d1")).not.toEqual(proof("k", "n2", "d1"));
  expect(proof("k", "n1", "d1")).not.toEqual(proof("k", "n1", "d2"));
  expect(proof("k", "n1", "d1")).toMatch(/^[0-9a-f]{64}$/);
});

test("placement: explicit wins, first matching rule, never an offline machine, else here", async () => {
  const { place } = await import("./placement.ts");
  const local = { id: "local", name: "laptop", state: "ready" };
  const ms: Record<string, { id: string; name: string; state: string }> = { m1: { id: "m1", name: "gpu", state: "offline" }, m2: { id: "m2", name: "server", state: "ready" } };
  const ctx = { local, localBusy: true, machine: (id: string) => ms[id] };
  const rules = [{ when: { needs_gpu: true }, machine: "m1" }, { when: { local_busy: true, kind: "run" as const }, machine: "m2", note: "laptop busy" }];
  expect(place({ kind: "run", machine: "m1" }, rules, ctx)).toMatchObject({ machine_id: "m1", explicit: true });
  expect(place({ kind: "run", needs_gpu: true }, rules, ctx)).toMatchObject({ machine_id: "m2", rule: 1, reason: "rule 2 (laptop busy)" });
  expect(place({ kind: "session" }, rules, ctx)).toMatchObject({ machine_id: "local", explicit: false });
  expect(place({ kind: "run" }, rules, { ...ctx, localBusy: false })).toMatchObject({ machine_id: "local" });
});

test("the outbox: handed out until acknowledged, and kept once however often it comes", async () => {
  const { Store } = await import("../core/store.ts");
  const { Bus } = await import("../core/bus.ts");
  const { Messages } = await import("./messages.ts");
  const { migrate } = await import("./db.ts");
  const engine: any = { isHeld: () => true, emitQueue() {}, isRunning: () => false, send() { return {}; } };
  const daemon = (id: string) => {
    const store = new Store(mkdtempSync(join(tmpdir(), `keel-msg-${id}-`)));
    migrate(store);
    const f: any = { id, name: id, rows: () => [], pairs: () => [] };
    const perm = () => ({ mode: "full-auto", sandbox: "off" });
    return { store, msgs: new Messages(store, new Bus(), engine, f, perm, () => {}) };
  };
  const a = daemon("dA"), b = daemon("dB");
  const ws = mkdtempSync(join(tmpdir(), "keel-ws-"));
  const from = a.store.createSession({ model: "m", workspace: ws });
  const to = b.store.createSession({ model: "m", workspace: ws });
  a.msgs.queueOutbound("dB", to.id, "hello", a.msgs.senderOf(from), true);
  // The first answer is lost on the way: it is handed out again.
  expect(a.msgs.pendingOutbound("dB")).toHaveLength(1);
  const [m] = a.msgs.pendingOutbound("dB");
  // Received, then the acknowledgement is lost: received again, kept once.
  b.msgs.receiveOutbound(to, m!, true);
  b.msgs.receiveOutbound(to, a.msgs.pendingOutbound("dB")[0]!, true);
  expect(b.msgs.list({ session_id: to.id })).toHaveLength(1);
  a.msgs.ackOutbound("dB", [m!.id]);
  expect(a.msgs.pendingOutbound("dB")).toHaveLength(0);
  expect(a.msgs.get(m!.id)!.state).toBe("delivered");
  // Another daemon's acknowledgement does nothing to it.
  a.msgs.queueOutbound("dB", to.id, "again", a.msgs.senderOf(from), true);
  a.msgs.ackOutbound("dC", a.msgs.pendingOutbound("dB").map((x) => x.id));
  expect(a.msgs.pendingOutbound("dB")).toHaveLength(1);
});

test("keel__run_on asks the far daemon to confine its command as the session's own shell is", async () => {
  let sent: any;
  const key = "k", daemonId = "far";
  const srv = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      sent = await req.json();
      return Response.json({ code: 0, out: "ok" }, { headers: { "x-keel-proof": proof(key, req.headers.get("x-keel-nonce")!, daemonId) } });
    },
  });
  try {
    const fleet = { step() {}, peer: async () => ({ url: `http://127.0.0.1:${srv.port}`, myId: "me", key, daemonId }) } as any;
    const ctx = { sessionId: "s", cwd: "/", signal: new AbortController().signal, spillDir: "/", seen: new Map(), confined: { sandbox: "workspace-write" as const, network: false } };
    await remoteExec(fleet, { id: "m", name: "m", workspace_root: "/r" } as any, ctx, "make");
    expect(sent.confined).toEqual({ sandbox: "workspace-write", network: false });
  } finally {
    srv.stop(true);
  }
  // The far side: no confinement asked runs the script as it is; one asked is
  // confined, or refused when that machine cannot confine.
  expect(execArgv("make", "/r")).toEqual(["bash", "-c", "make"]);
  const c = execArgv("make", "/r", { sandbox: "workspace-write", network: false });
  if (Array.isArray(c)) expect(c[0]).not.toBe("bash");
  else expect(c.error).toContain("cannot sandbox");
});

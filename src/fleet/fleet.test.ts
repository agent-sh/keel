// Pure pieces of the fleet an e2e cannot reach: the ssh configuration's hosts,
// the fence on what a peer's tool call names, and the link proof.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execArgv, outsideRoot } from "./hands.ts";
import { remoteExec } from "./remote.ts";
import { linkFetch, proof } from "./link.ts";
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

test("two first requests to a machine pair once and hold the same key", async () => {
  const { Store } = await import("../core/store.ts");
  const { Bus } = await import("../core/bus.ts");
  const { Fleet } = await import("./fleet.ts");
  let pairings = 0;
  const srv = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch() {
      const n = ++pairings;
      await Bun.sleep(20); // both callers are waiting before the first answer
      return Response.json({ daemon_id: "far", key: `key-${n}` });
    },
  });
  const store = new Store(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "keel-pair-")));
  const f = new Fleet(store, new Bus(), { capture: (_s: string, e: unknown) => { throw e; } } as any);
  try {
    const m = f.add({ name: "far box", source: "daemon", daemon_url: `http://127.0.0.1:${srv.port}` });
    const [a, b] = await Promise.all([f.peer(m.id), f.peer(m.id)]);
    expect(pairings).toBe(1);
    expect([a.key, b.key]).toEqual(["key-1", "key-1"]);
    expect((await f.peer(m.id)).key).toBe("key-1");
  } finally {
    f.stop();
    srv.stop(true);
    store.db.close();
  }
});

// A scratch daemon's messages: its own store, no engine and no link.
async function scratchDaemon(id: string) {
  const { Store } = await import("../core/store.ts");
  const { Bus } = await import("../core/bus.ts");
  const { Messages } = await import("./messages.ts");
  const { migrate } = await import("./db.ts");
  const engine: any = { isHeld: () => true, emitQueue() {}, isRunning: () => false, send() { return {}; } };
  const store = new Store(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), `keel-msg-${id}-`)));
  migrate(store);
  const f: any = { id, name: id, rows: () => [], pairs: () => [] };
  const ws = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "keel-ws-"));
  return { store, ws, msgs: new Messages(store, new Bus(), engine, f, () => ({ mode: "full-auto", sandbox: "off" }), () => {}) };
}

test("the outbox: one destination's older message is handed out whatever waits for the others", async () => {
  const a = await scratchDaemon("dA");
  const from = a.store.createSession({ model: "m", workspace: a.ws });
  const sender = a.msgs.senderOf(from);
  const old = a.msgs.queueOutbound("dB", "s-b", "the old one", sender, true);
  a.store.db.query("UPDATE fleet_messages SET created_ms = created_ms - 60000 WHERE id = ?").run(old.id);
  for (const d of ["dC", "dD"]) for (let i = 0; i < 100; i++) a.msgs.queueOutbound(d, `s-${d}`, `later ${i}`, sender, true);
  expect(a.msgs.list({ state: "outbound" })).toHaveLength(200); // 201 wait in all
  expect(a.msgs.pendingOutbound("dB").map((m) => m.id)).toEqual([old.id]);
  expect(a.msgs.pendingOutbound("dC")).toHaveLength(100);
  expect(a.msgs.pendingOutbound("dC")[0]!.text).toBe("later 0"); // oldest first
});

test("the outbox: a lost acknowledgement is retried within a bound, the message kept once", async () => {
  const { OutboxDrain } = await import("./outbox.ts");
  const { LinkError } = await import("./link.ts");
  const a = await scratchDaemon("dA"), b = await scratchDaemon("dB");
  const from = a.store.createSession({ model: "m", workspace: a.ws });
  const to = b.store.createSession({ model: "m", workspace: b.ws });
  const sent = a.msgs.queueOutbound("dB", to.id, "hello", a.msgs.senderOf(from), true);
  let live = true, lose = 1, fetches = 0, acks = 0;
  const failed: unknown[] = [];
  const drain = new OutboxDrain({
    link: async () => ({
      pending: async () => { fetches++; return a.msgs.pendingOutbound("dB"); },
      keep: (m) => b.msgs.keepOutbound(m, true),
      ack: async (ids, refused) => { acks++; if (lose-- > 0) throw new LinkError("the answer was lost"); a.msgs.ackOutbound("dB", ids, refused); },
    }),
    live: () => live,
    failed: (e) => failed.push(e),
    retryMs: [5, 5],
    slowMs: 20,
  });
  const settled = async () => { for (let i = 0; i < 200 && !drain.idle("mB"); i++) await Bun.sleep(5); };
  drain.kick("mB");
  await settled();
  expect([fetches, acks]).toEqual([2, 2]); // one retry, no new trigger
  expect(a.msgs.pendingOutbound("dB")).toHaveLength(0);
  expect(a.msgs.get(sent.id)!.state).toBe("delivered");
  expect(b.msgs.list({ session_id: to.id })).toHaveLength(1);
  expect(failed).toEqual([]);

  // The bound: a link that stays broken while its relay is open is reported
  // once after the listed retries and asked again at the slow pace. When it
  // answers, the receipt clears.
  a.msgs.queueOutbound("dB", to.id, "again", a.msgs.senderOf(from), true);
  lose = Infinity; fetches = 0;
  drain.kick("mB");
  for (let i = 0; i < 400 && fetches < 5; i++) await Bun.sleep(5);
  expect(fetches).toBeGreaterThanOrEqual(5); // three quick tries, then slow ones
  expect(failed).toHaveLength(1);
  expect(a.msgs.pendingOutbound("dB")).toHaveLength(1);
  lose = 0;
  await settled();
  expect(a.msgs.pendingOutbound("dB")).toHaveLength(0);
  expect(b.msgs.list({ session_id: to.id })).toHaveLength(2);
  expect(failed).toHaveLength(1);
  // A closed relay is not retried: its reopening drains.
  a.msgs.queueOutbound("dB", to.id, "third", a.msgs.senderOf(from), true);
  live = false; lose = Infinity; fetches = 0;
  drain.kick("mB");
  await settled();
  expect(fetches).toBe(1);
  expect(failed).toHaveLength(1);
  expect(a.msgs.pendingOutbound("dB")).toHaveLength(1); // still waits for the next relay
  drain.stop();
});

test("the outbox: one message that cannot be kept does not hold back the ones behind it", async () => {
  const { OutboxDrain } = await import("./outbox.ts");
  const a = await scratchDaemon("dA"), b = await scratchDaemon("dB");
  const from = a.store.createSession({ model: "m", workspace: a.ws });
  const to = b.store.createSession({ model: "m", workspace: b.ws });
  const [bad, good] = ["first", "second"].map((t) => a.msgs.queueOutbound("dB", to.id, t, a.msgs.senderOf(from), true));
  const failed: unknown[] = [];
  const drain = new OutboxDrain({
    link: async () => ({
      pending: async () => a.msgs.pendingOutbound("dB"),
      keep: (m) => { if (m.id === bad!.id) throw new Error("a bug in keeping this one"); return b.msgs.keepOutbound(m, true); },
      ack: async (ids, refused) => { a.msgs.ackOutbound("dB", ids, refused); },
    }),
    live: () => true,
    failed: (e) => failed.push(e),
  });
  drain.kick("mB");
  for (let i = 0; i < 200 && !drain.idle("mB"); i++) await Bun.sleep(5);
  expect(a.msgs.get(good!.id)!.state).toBe("delivered");
  expect(a.msgs.pendingOutbound("dB").map((m) => m.id)).toEqual([bad!.id]); // handed out again at the next drain
  expect(b.msgs.list({ session_id: to.id }).map((m) => m.text)).toEqual(["second"]);
  expect(failed.map((e) => (e as Error).message)).toEqual(["a bug in keeping this one"]);
});

test("the outbox: a message given to its session before the daemon died is not given again", async () => {
  const a = await scratchDaemon("dA"), b = await scratchDaemon("dB");
  const from = a.store.createSession({ model: "m", workspace: a.ws });
  const to = b.store.createSession({ model: "m", workspace: b.ws });
  let sends = 0;
  (b.msgs as any).engine.send = () => { sends++; return {}; };
  const [first, second] = ["one", "two"].map((t) => a.msgs.queueOutbound("dB", to.id, t, a.msgs.senderOf(from), true));
  // What the engine had stored when the daemon died, before the message's own row:
  // one as the session's event, one still in its queue.
  const meta = (m: typeof first, id: string) => ({ kind: "peer", from: { ...m!.from, outbox_id: m!.id }, message_id: id });
  b.store.append(to.id, "user", { text: "framed one", ...meta(first, "kept-1") });
  b.store.enqueue(to.id, "framed two", false, undefined, meta(second, "kept-2"));
  expect(b.msgs.list({ session_id: to.id })).toHaveLength(0);
  for (const m of a.msgs.pendingOutbound("dB")) expect(b.msgs.keepOutbound(m, true)).toEqual({});
  expect(sends).toBe(0);
  expect(b.msgs.list({ session_id: to.id }).map((m) => [m.id, m.state]).sort()).toEqual([["kept-1", "delivered"], ["kept-2", "queued"]]);
  // And once more, now from its row.
  for (const m of a.msgs.pendingOutbound("dB")) b.msgs.keepOutbound(m, true);
  expect(sends).toBe(0);
  expect(b.msgs.list({ session_id: to.id })).toHaveLength(2);
});

test("the outbox: a refused message settles with its reason, never as delivered, and an answer replayed changes nothing", async () => {
  const { OutboxDrain } = await import("./outbox.ts");
  const a = await scratchDaemon("dA"), b = await scratchDaemon("dB");
  (a.msgs as any).fleet.pairs = () => [{ daemon_id: "dB", name: "other box" }];
  const from = a.store.createSession({ model: "m", workspace: a.ws });
  const open = b.store.createSession({ model: "m", workspace: b.ws });
  const archived = b.store.createSession({ model: "m", workspace: b.ws });
  b.store.updateSession(archived.id, { archived: true });
  const deleted = b.store.createSession({ model: "m", workspace: b.ws });
  b.store.deleteSession(deleted.id);
  const sender = a.msgs.senderOf(from);
  const [ok, arch, gone] = [open, archived, deleted].map((s, i) => a.msgs.queueOutbound("dB", s.id, `message ${i}`, sender, true));
  const answers: { ids: string[]; refused: Record<string, string> }[] = [];
  const drain = new OutboxDrain({
    link: async () => ({
      pending: async () => a.msgs.pendingOutbound("dB"),
      keep: (m) => b.msgs.keepOutbound(m, true),
      ack: async (ids, refused) => { answers.push({ ids, refused }); a.msgs.ackOutbound("dB", ids, refused); },
    }),
    live: () => true,
    failed: (e) => { throw e; },
  });
  drain.kick("mB");
  for (let i = 0; i < 200 && !drain.idle("mB"); i++) await Bun.sleep(5);
  const settled = () => [ok, arch, gone].map((m) => { const x = a.msgs.get(m!.id)!; return [x.state, x.reason]; });
  const want = [
    ["delivered", "received by its daemon"],
    ["dropped", "refused by its daemon: the session is archived"],
    ["dropped", "refused by its daemon: no such session there (deleted)"],
  ];
  expect(settled()).toEqual(want);
  expect(a.msgs.pendingOutbound("dB")).toEqual([]);
  expect(b.msgs.list({}).map((m) => m.to_session)).toEqual([open.id]); // only the accepted one was kept
  // The sending session reads each refusal once, as a note its model sees too.
  const notes = () => a.store.events(from.id).filter((e) => e.kind === "note").map((e) => String(e.data.text));
  expect(notes()).toHaveLength(2);
  expect(notes()[0]).toContain(`Your message to session ${archived.id} on other box`);
  expect(notes()[0]).toContain("was refused there and not delivered: the session is archived.");
  expect(notes()[1]).toContain("no such session there (deleted)");

  // The same answer again, and a contradicting one: nothing changes, nothing is said twice.
  a.msgs.ackOutbound("dB", answers[0]!.ids, answers[0]!.refused);
  a.msgs.ackOutbound("dB", [ok!.id, arch!.id, gone!.id], { [ok!.id]: "late refusal" });
  expect(settled()).toEqual(want);
  expect(notes()).toHaveLength(2);
});

// A message for a session the owner stopped waits in its held queue through
// the engine's own queue path, so it is still a peer message when it runs.
test("a peer message held by a Stop keeps who sent it", async () => {
  const { rmSync } = await import("node:fs");
  const { Store } = await import("../core/store.ts");
  const { Bus } = await import("../core/bus.ts");
  const { allHooks } = await import("../engine/hooks.ts");
  const { Engine } = await import("../engine/turn.ts");
  const { Messages } = await import("./messages.ts");
  const { migrate } = await import("./db.ts");
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "keel-peer-held-"));
  const store = new Store(dir);
  migrate(store);
  const engine = new Engine(store, new Bus(), {} as any, { capture: (_s: string, e: unknown) => { throw e; } } as any, dir);
  const f: any = { id: "dA", name: "dA", rows: () => [], pairs: () => [] };
  const msgs = new Messages(store, new Bus(), engine, f, () => ({ mode: "full-auto", sandbox: "off" }), () => {});
  const from = store.createSession({ model: "fixture:m", workspace: dir });
  const to = store.createSession({ model: "fixture:m", workspace: dir });
  const running = Promise.withResolvers<void>();
  let pause = true;
  allHooks().push({ external: (session) => session.id === to.id ? async ({ signal }) => {
    if (pause) {
      running.resolve();
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    }
    return { reason: "end_turn" };
  } : undefined });
  try {
    engine.send(to.id, "work");
    await running.promise;
    await engine.interrupt(to.id, "owner");
    pause = false;
    const stopped = store.events(to.id).at(-1)!;
    const sender = msgs.senderOf(from);
    const m = msgs.receive(to, "hello", sender, true, true);
    expect(m.state).toBe("queued");
    expect(engine.isRunning(to.id)).toBe(false);
    expect(engine.isHeld(to.id)).toBe(true);
    const meta = { kind: "peer", from: sender, message_id: m.id };
    expect(store.queue(to.id)).toMatchObject([{ steer: false, meta }]);
    engine.resumeQueue(to.id);
    await engine.idle(to.id);
    const prompts = store.events(to.id, stopped.seq).filter((e) => e.kind === "user");
    expect(prompts.map((e) => e.data)).toMatchObject([{ ...meta, origin: "queued" }]);
    expect(String(prompts[0]!.data.text)).toContain(`message_id="${m.id}"`);
  } finally {
    await engine.interrupt(to.id);
    allHooks().pop();
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
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
    const peer = { url: `http://127.0.0.1:${srv.port}`, myId: "me", key, daemonId };
    const fleet = { step() {}, hands: (_id: string, path: string, init: any) => linkFetch(peer, path, init) } as any;
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

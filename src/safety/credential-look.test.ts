import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Bus } from "../core/bus.ts";
import { Store } from "../core/store.ts";
import type { Session } from "../core/types.ts";
import type { ToolCall } from "../engine/hooks.ts";
import type { Tool } from "../tools/types.ts";
import { diskLook, shellCredentialReads, type Classifier, type Found } from "./credential-reads.ts";
import { forgetLooks, lookUnder } from "./credential-look.ts";
import { Gate } from "./gate.ts";
import { credentialAt } from "./credentials.ts";
import { looking } from "./looked.ts";
import { splitCommand } from "./shell.ts";

// A folder of about 1,100 entries, in forty folders.
function folderOf(entries = 1100) {
  const h = realpathSync(mkdtempSync(join(tmpdir(), "keel-look-")));
  for (let i = 0; i < entries; i++) {
    const dir = join(h, "p", `d${i % 40}`);
    if (i < 40) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `f${i}.ts`), "x\n");
  }
  return h;
}
// What a disk under load costs: each file named costs a tenth of a millisecond of the thread's time.
const slow = (h: string, counts = { by: 0 }): Classifier => ({
  by: (p) => { counts.by++; const end = performance.now() + 0.1; while (performance.now() < end); return credentialAt(p, { home: h }); },
  link: () => null,
});
const grep = splitCommand("grep -r TOKEN .")!;

test("a search of a folder of 1,100 entries is answered while the loop is busy, where the look on the loop gives up", async () => {
  const h = folderOf();
  const is = slow(h);
  const read = (look: ReturnType<typeof diskLook>) => shellCredentialReads(grep, join(h, "p"), h, (p) => credentialAt(p, { home: h }), undefined, look);
  // The look on the loop has 60 ms: a slow disk's 1,100 entries do not fit, and the search is refused as unread.
  expect(read(diskLook(() => is))?.hits[0]?.unread).toBe(true);
  // The look off the loop is asked for by the call (the gate's own flow), with a timer busy beside it.
  const busy = setInterval(() => { const end = performance.now() + 5; while (performance.now() < end); }, 1);
  try {
    const l = looking(h, undefined, undefined, (f) => lookUnder(f, is, { scope: "a" }));
    let reads: ReturnType<typeof read> = null;
    for (let pass = 0, asked = new Map<string, () => Promise<unknown>>(); pass < 4; pass++, asked = new Map()) {
      const view = l.view(asked);
      reads = read(diskLook(() => is, undefined, new Map(), (f) => view.named!(f)));
      if (!asked.size) break;
      await l.answer(asked);
    }
    expect(reads).toBeNull();
  } finally { clearInterval(busy); }
});

test("a repeat search is answered from the kept look, and a folder that changed is looked through again", async () => {
  forgetLooks();
  const h = folderOf(400);
  const counts = { by: 0 };
  const is = slow(h, counts);
  const first = await lookUnder(join(h, "p"), is, { scope: "b" });
  expect(first).toEqual([]);
  const made = counts.by;
  expect(made).toBeGreaterThanOrEqual(400);
  expect(await lookUnder(join(h, "p"), is, { scope: "b" })).toEqual([]);
  expect(counts.by).toBe(made);
  // Two searches at once share one look.
  forgetLooks();
  counts.by = 0;
  await Promise.all([lookUnder(join(h, "p"), is, { scope: "c" }), lookUnder(join(h, "p"), is, { scope: "c" })]);
  expect(counts.by).toBe(made);
  // A file made in a folder changes its time: the next search looks again, and finds it.
  writeFileSync(join(h, "p/d7/server.key"), "k\n");
  const later = new Date(Date.now() + 5000);
  utimesSync(join(h, "p/d7"), later, later);
  const found = await lookUnder(join(h, "p"), is, { scope: "c" });
  expect(found.map((f: Found) => f.path)).toEqual([join(h, "p/d7/server.key")]);
  expect(counts.by).toBeGreaterThan(made);
});

test("a credential file inside still holds the search, and a look that runs out of time says how long it took", async () => {
  forgetLooks();
  const h = folderOf(200);
  writeFileSync(join(h, "p/d3/.env"), "TOKEN=x\n");
  const l = looking(h, undefined, undefined, (f) => lookUnder(f, slow(h), { scope: "d" }));
  const run = async () => {
    let reads: ReturnType<typeof shellCredentialReads> = null;
    for (let pass = 0, asked = new Map<string, () => Promise<unknown>>(); pass < 4; pass++, asked = new Map()) {
      const view = l.view(asked);
      reads = shellCredentialReads(grep, join(h, "p"), h, (p) => credentialAt(p, { home: h }), undefined, diskLook(() => slow(h), undefined, new Map(), (f) => view.named!(f)));
      if (!asked.size) break;
      await l.answer(asked);
    }
    return reads;
  };
  const held = await run();
  expect(held?.hits.map((x) => x.path)).toEqual([join(h, "p/d3/.env")]);
  expect(held?.hits[0]?.unread).toBeUndefined();
  // No time at all: the folder is unread, with how far the look got and what to do.
  const late = await lookUnder(join(h, "p"), slow(h), { scope: "e", ms: -1 });
  expect(late).toHaveLength(1);
  expect(late[0]).toMatchObject({ path: join(h, "p"), unread: true });
  expect(late[0]!.why).toMatch(/\d+ entries read so far in 1 part, \d+ folders still to read; this part took \d+ ms of its -1 ms and ran out of time/);
  const refused = shellCredentialReads(grep, join(h, "p"), h, () => null, undefined, { named: () => late });
  expect(refused?.what).toMatch(/too big to be looked through.*entries read so far.*Search it again/);
});

test("the gate answers a search of a folder it looks through off the loop, and refuses one that holds a credential file", async () => {
  forgetLooks();
  const g = new Gate(new Store(mkdtempSync(join(tmpdir(), "keel-gate-"))), new Bus(), () => true);
  const ws = folderOf(1100);
  const session = { id: "s1", workspace: ws, parent_id: "p0" } as Session; // an agent: a read of credentials is refused, not asked
  const bash: Tool = { name: "Bash", readOnly: false, kind: "shell", description: "", input_schema: { type: "object", properties: { command: {} } }, run: async () => ({ content: "" }) };
  const call = (command: string): ToolCall => ({ id: crypto.randomUUID(), tool: bash, input: { command }, ctx: { sessionId: "s1", cwd: ws, signal: new AbortController().signal, spillDir: ws, seen: new Map() } });
  g.setSandboxCheck(() => false);
  g.setPerm("s1", { mode: "read-only", sandbox: "off" });
  const busy = setInterval(() => { const end = performance.now() + 5; while (performance.now() < end); }, 20);
  try {
    const clean = await g.check(session, call("grep -r TOKEN p"));
    expect(clean).not.toHaveProperty("deny");
    expect(await g.check(session, call("grep -r TOKEN p"))).not.toHaveProperty("deny");
    writeFileSync(join(ws, "p/d9/.env"), "TOKEN=x\n");
    const later = new Date(Date.now() + 5000);
    utimesSync(join(ws, "p/d9"), later, later);
    const held = await g.check(session, call("grep -r TOKEN p"));
    expect(held).toHaveProperty("deny");
    expect(JSON.stringify(held)).toContain(".env");
    expect(JSON.stringify(held)).not.toContain("could not be looked through");
  } finally { clearInterval(busy); }
});

test("a kept look is not trusted when a folder's modification time was put back, or a folder that could not be read changed", async () => {
  forgetLooks();
  const h = folderOf(60);
  const is = slow(h);
  const top = join(h, "p");
  expect(await lookUnder(top, is, { scope: "f" })).toEqual([]);
  // A file made in a folder, and the folder's modification time put back: its change time still moved.
  const dir = join(top, "d5"), was = statSync(dir);
  writeFileSync(join(dir, ".env"), "TOKEN=x\n");
  utimesSync(dir, was.atime, was.mtime);
  expect((await lookUnder(top, is, { scope: "f" })).map((f: Found) => f.path)).toEqual([join(dir, ".env")]);
  // A folder that is missing at the first look, and made later.
  const later = join(h, "later");
  expect(await lookUnder(later, is, { scope: "f" })).toEqual([]);
  mkdirSync(later);
  writeFileSync(join(later, ".env"), "TOKEN=x\n");
  expect((await lookUnder(later, is, { scope: "f" })).map((f: Found) => f.path)).toEqual([join(later, ".env")]);
  // A folder that is closed at the first look, and opened later.
  if (process.getuid?.() !== 0) {
    const closed = join(top, "d6");
    chmodSync(closed, 0o000);
    try {
      expect((await lookUnder(top, is, { scope: "g" })).map((f: Found) => f.path)).toEqual([join(dir, ".env")]);
      writeFileSync(join(dir, ".env"), "TOKEN=y\n");
    } finally { chmodSync(closed, 0o755); }
    writeFileSync(join(closed, "id_rsa"), "k\n");
    expect((await lookUnder(top, is, { scope: "g" })).map((f: Found) => f.path)).toContain(join(closed, "id_rsa"));
  }
});

test("a look that stops at its entry limit with folders unread goes on at the next search, and the answer is kept when it is done", async () => {
  forgetLooks();
  const h = folderOf(200);
  const counts = { by: 0 };
  const is = slow(h, counts);
  const o = { scope: "h", entries: 100 };
  const first = await lookUnder(join(h, "p"), is, o);
  expect(first).toHaveLength(1);
  expect(first[0]).toMatchObject({ path: join(h, "p"), unread: true, resumes: true });
  expect(first[0]!.why).toContain("in 1 part");
  const seenFirst = counts.by;
  // The next search reads the rest, not the folder again from its start.
  const second = await lookUnder(join(h, "p"), is, o);
  expect(second[0]).toMatchObject({ unread: true, resumes: true });
  expect(second[0]!.why).toContain("in 2 parts");
  expect(await lookUnder(join(h, "p"), is, o)).toEqual([]);
  // (Each file is classified once: 200 files, with the folders they are in read once each.)
  expect(counts.by).toBe(200);
  expect(seenFirst).toBeLessThan(200);
  const made = counts.by;
  expect(await lookUnder(join(h, "p"), is, o)).toEqual([]);
  expect(counts.by).toBe(made);
});

// A folder of 50,000 entries: more than one look reads (20,000 entries), so it is read over successive searches.
function bigFolder() {
  const h = realpathSync(mkdtempSync(join(tmpdir(), "keel-look-big-")));
  for (let d = 0; d < 50; d++) {
    const dir = join(h, "w", `d${d}`);
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 999; i++) writeFileSync(join(dir, `f${i}.ts`), "");
  }
  return h;
}
test("a folder of 50,000 entries is looked through over successive searches, then answered at once; a key added in a part already read is caught", async () => {
  forgetLooks();
  const h = bigFolder();
  const counts = { by: 0 };
  const classified = new Map<string, number>();
  const is: Classifier = { by: (p) => { counts.by++; classified.set(dirname(p), (classified.get(dirname(p)) ?? 0) + 1); return credentialAt(p, { home: h }); }, link: () => null };
  const top = join(h, "w");
  let key = "";
  const asks: Found[][] = [];
  for (let i = 0; i < 6 && (i === 0 || asks.at(-1)!.some((f) => f.unread)); i++) {
    asks.push(await lookUnder(top, is, { scope: "big" }));
    // Between the first and the second part, a key is made in a folder the first part has already read.
    if (i === 0) {
      expect(asks[0]!.at(-1)).toMatchObject({ unread: true, resumes: true });
      const readDir = [...classified].find(([, n]) => n === 999)![0];
      key = join(readDir, "server.key");
      writeFileSync(key, "k\n");
      const later = new Date(Date.now() + 5000);
      utimesSync(readDir, later, later);
    }
  }
  // Two or three looks finish it, and the key is found.
  expect(asks.length).toBeGreaterThanOrEqual(2);
  expect(asks.length).toBeLessThanOrEqual(4);
  expect(asks.at(-1)!.map((f) => f.path)).toEqual([key]);
  const made = counts.by;
  expect(await lookUnder(top, is, { scope: "big" })).toEqual(asks.at(-1)!);
  expect(counts.by).toBe(made);
}, 60_000);

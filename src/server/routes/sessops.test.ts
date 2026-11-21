// Pure logic of the session-operations routes the e2e cannot reach: what the
// editor command becomes, image kinds by bytes, a recap reply's shape, tags.
import { describe, expect, test } from "bun:test";
import { parseDigest } from "./convo.ts";
import { cleanTags, failSeen, failSeenBefore } from "./marks.ts";
import { imageKind, openPlan } from "./places.ts";

describe("openPlan", () => {
  test("a configured template is filled, the request only names the file", () => {
    expect(openPlan({ KEEL_OPEN_COMMAND: "code -g {path}:{line}" }, "/w/a.ts", 7).argv).toEqual(["code", "-g", "/w/a.ts:7"]);
    expect(openPlan({ KEEL_EDITOR: "zed" }, "/w/a.ts").argv).toEqual(["zed", "/w/a.ts"]);
  });
  test("a windowed $VISUAL or $EDITOR opens the file; VS Code gets the line", () => {
    expect(openPlan({ VISUAL: "/usr/bin/code --wait" }, "/w/a.ts", 3)).toEqual({ argv: ["/usr/bin/code", "--wait", "-g", "/w/a.ts:3"], opened: "file" });
    expect(openPlan({ EDITOR: "subl" }, "/w/a.ts").argv).toEqual(["subl", "/w/a.ts"]);
  });
  test("a terminal editor or none opens the folder, never the file by its type", () => {
    const p = openPlan({ EDITOR: "vim" }, "/w/page.html");
    expect(p.opened).toBe("folder");
    expect(p.argv.at(-1)).toBe("/w");
  });
});

test("imageKind reads the bytes, not the name", () => {
  expect(imageKind(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))).toBe("image/png");
  expect(imageKind(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
  expect(imageKind(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
  expect(imageKind(new TextEncoder().encode("<svg xmlns="))).toBeNull();
});

test("parseDigest takes JSON, fenced JSON or plain text, and caps the lengths", () => {
  expect(parseDigest('{"recap": "Tests pass.", "next": "ship it"}')).toEqual({ recap: "Tests pass.", next: "ship it" });
  expect(parseDigest('Here:\n```json\n{"recap": "Done.", "next": ""}\n```')).toEqual({ recap: "Done.", next: undefined });
  expect(parseDigest("The build is green.")).toEqual({ recap: "The build is green." });
  expect(parseDigest(JSON.stringify({ recap: "x".repeat(900) })).recap).toHaveLength(400);
});

test("cleanTags trims, drops repeats and refuses control characters", () => {
  expect(cleanTags([" a ", "A", "b", ""])).toEqual(["a", "b"]);
  expect(() => cleanTags(["bad\u0007"])).toThrow();
  expect(() => cleanTags("a")).toThrow();
});

// A summary written on one branch never lands on another: the owner switches
// branch (or a turn moves the head) while the summary call is out. The route and
// the engine are real; only the model's answer is held until the test releases it.
describe("a summary is bound to the branch it was written from", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { Store } = await import("../../core/store.ts");
  const { Bus } = await import("../../core/bus.ts");
  const { ErrorTracker } = await import("../../core/errors.ts");
  const { Engine, toMessages } = await import("../../engine/turn.ts");
  const { convoRoutes } = await import("./convo.ts");
  const { turnRoutes } = await import("./turns.ts");
  const answer = { blocks: [{ type: "text", text: "SUMMARY OF A" }], usage: { input: 0, output: 0 }, model_id: "p:m", stop: "end_turn" };
  const setup = () => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "summary-branch-"));
    const store = new Store(dir);
    const bus = new Bus();
    const errors = new ErrorTracker(store, bus);
    const engine = new Engine(store, bus, {} as any, errors, join(dir, "spill"));
    const s = store.createSession({ workspace: dir, model: "p:m" });
    store.append(s.id, "user", { text: "COMMON" });
    const common = store.append(s.id, "assistant", { blocks: [{ type: "text", text: "COMMON REPLY" }] });
    store.append(s.id, "user", { text: "A EARLIER" });
    store.append(s.id, "assistant", { blocks: [{ type: "text", text: "A EARLIER REPLY" }] });
    const ua = store.append(s.id, "user", { text: "A QUESTION" });
    const aa = store.append(s.id, "assistant", { blocks: [{ type: "text", text: "A REPLY" }] });
    store.append(s.id, "user", { text: "B QUESTION" }, common.id);
    const ab = store.append(s.id, "assistant", { blocks: [{ type: "text", text: "B REPLY" }] });
    store.updateSession(s.id, { head: aa.id });
    let release!: () => void;
    let started!: () => void;
    const out = new Promise<void>((r) => (started = r));
    const held = new Promise<void>((r) => (release = r));
    const hold = async () => { started(); await held; };
    (engine as any).ask = async () => { await hold(); return answer; };
    (engine as any).step = async () => ({ info: { id: "p:m" } });
    (engine as any).call = async () => { await hold(); return answer; };
    const deps = { store, bus, engine, providers: {}, errors } as any;
    const routes = { ...(convoRoutes(deps) as any), ...(turnRoutes(deps) as any) };
    const post = (path: string, body: unknown) => {
      const r = new Request(`http://x/api/sessions/${s.id}/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) as any;
      r.params = { id: s.id };
      return routes[`/api/sessions/:id/${path}`].POST(r) as Promise<Response>;
    };
    const input = () => JSON.stringify(toMessages(engine.lineage(s.id)));
    return { store, engine, s, ua, ab, out, release, post, input };
  };
  for (const direction of ["from", "up_to"] as const) {
    test(`${direction}: unchanged head applies the summary`, async () => {
      const t = setup();
      const pending = t.post("summarize", { direction, event_id: t.ua.id });
      await t.out;
      t.release();
      expect((await pending).status).toBe(200);
      expect(t.input()).toContain("SUMMARY OF A");
    });
    test(`${direction}: a switch to B meanwhile is refused and B stays as it was`, async () => {
      const t = setup();
      const pending = t.post("summarize", { direction, event_id: t.ua.id });
      await t.out;
      expect((await t.post("head", { head_event_id: t.ab.id, leaf: false })).status).toBe(200);
      const before = t.input();
      const events = t.store.events(t.s.id).length;
      t.release();
      const r = await pending;
      expect(r.status).toBe(409);
      expect(((await r.json()) as any).code).toBe("head_moved");
      expect(t.store.session(t.s.id)!.head).toBe(t.ab.id);
      expect(t.input()).toBe(before);
      expect(t.input()).toContain("B REPLY");
      expect(t.store.events(t.s.id)).toHaveLength(events);
    });
  }
  test("the owner's compaction: a switch meanwhile is refused, else it applies", async () => {
    const t = setup();
    const pending = t.engine.compactNow(t.s.id);
    await t.out;
    await t.post("head", { head_event_id: t.ab.id, leaf: false });
    const before = t.input();
    t.release();
    await expect(pending).rejects.toMatchObject({ status: 409, code: "head_moved" });
    expect(t.input()).toBe(before);
    const ok = setup();
    const done = ok.engine.compactNow(ok.s.id);
    await ok.out;
    ok.release();
    expect((await done).kind).toBe("compaction");
  });
});

test("a failure is seen when a device showed that failure, and old ones count as seen unless their alert is unread", () => {
  const s = (settings: object, updated = 50) => ({ updated, settings } as any);
  expect(failSeen(s({ failed_ms: 100, fail_seen_ms: 0 }), 100)).toEqual({ fail_seen_ms: 100 });
  // The page showed an older failure: this one is still news. Seen already: nothing to write.
  expect(failSeen(s({ failed_ms: 200, fail_seen_ms: 0 }), 100)).toBeNull();
  expect(failSeen(s({ failed_ms: 100, fail_seen_ms: 100 }), 100)).toBeNull();
  // A failure known from the events alone has a stamp of its own, which the session's activity does not move.
  expect(failSeen(s({}, 70), -1)).toEqual({ fail_seen_ms: -1 });
  expect(failSeen(s({ fail_seen_ms: -1 }, 99), -1)).toBeNull();
  expect(failSeen(s({}, 70), 70)).toBeNull();
  // The first start with the mark.
  expect(failSeenBefore(s({ failed_ms: 100 }), false)).toEqual({ fail_seen_ms: 100 });
  expect(failSeenBefore(s({ failed_ms: 100 }), true)).toEqual({ fail_seen_ms: 0 });
  // An unread alert of a failure older than the owner's last prompt anywhere: seen. Newer than it: news.
  expect(failSeenBefore(s({ failed_ms: 100 }), true, 500)).toEqual({ fail_seen_ms: 100 });
  expect(failSeenBefore(s({ failed_ms: 600 }), true, 500)).toEqual({ fail_seen_ms: 0 });
  expect(failSeenBefore(s({ failed_ms: 100, fail_seen_ms: 0 }), false)).toBeNull();
  expect(failSeenBefore(s({}), false)).toBeNull();
});

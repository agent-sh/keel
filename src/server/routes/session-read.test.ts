// A whole session's answer put together from the stored rows is, byte for
// byte, the answer written from the parsed events.
import { afterAll, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../core/store.ts";
import { sessionWhole } from "./session-read.ts";

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

test("a whole session written from its stored rows is the answer written from its parsed events, with no body parsed", () => {
  const dir = mkdtempSync(join(tmpdir(), "keel-whole-"));
  dirs.push(dir);
  const store = new Store(dir);
  const s = store.createSession({ model: "m", workspace: "/", title: 'A "quoted" title, é and 🙂' });
  const first = store.append(s.id, "user", { text: 'line one\nline "two" \\ back\u2028slash é 🙂 \u0000 </script>', images: [{ type: "image", media_type: "image/png", data: "AAAA" }] });
  store.append(s.id, "assistant", { blocks: [{ type: "text", text: "ok" }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "echo 1", n: 1.5, big: 1e21, neg: -0, list: [null, true, { a: [] }] } }], usage: { input: 1, output: 2 }, stop: "tool_use" });
  store.append(s.id, "tool_result", { results: [{ type: "tool_result", tool_use_id: "t1", content: "x".repeat(5000) }] });
  // An edited prompt: a second branch, and the session shows it.
  store.append(s.id, "user", { text: "edited" }, first.parent);
  store.append(s.id, "note", { kind: "restart", text: "held" });
  const rest = { running: false, bytes_per_token: 3.2, queue: [], held: false, status: { kind: "idle" }, rev: 7 };
  const now = store.session(s.id)!;
  // The answer as it was written: every event parsed, then the whole written out.
  const want = JSON.stringify({ session: now, events: store.events(s.id), seq: store.lastSeq(s.id), ...rest });
  const parse = spyOn(JSON, "parse");
  const got = sessionWhole(store.db, { session: s.id, head: `{"session":${JSON.stringify(now)},"events":`, tail: `,${JSON.stringify(rest).slice(1)}`, coding: null });
  expect(parse).toHaveBeenCalledTimes(0);
  parse.mockRestore();
  expect(got.coding).toBeNull();
  expect(got.events).toBe(5);
  expect(new TextDecoder().decode(got.body)).toBe(want);
  // Compressed when the request takes a coding, and the same answer when it is read back.
  const packed = sessionWhole(store.db, { session: s.id, head: `{"session":${JSON.stringify(now)},"events":`, tail: `,${JSON.stringify(rest).slice(1)}`, coding: "gzip" });
  expect(packed.coding).toBe("gzip");
  expect(packed.body.length).toBeLessThan(got.body.length);
  expect(new TextDecoder().decode(Bun.gunzipSync(packed.body))).toBe(want);
  // A session with no event.
  const empty = store.createSession({ model: "m", workspace: "/" });
  expect(new TextDecoder().decode(sessionWhole(store.db, { session: empty.id, head: "{\"events\":", tail: "}", coding: "zstd" }).body)).toBe('{"events":[],"seq":0}');
  store.db.close();
});

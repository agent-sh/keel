// A backup is only a backup if it restores: back up a store with a session,
// events and an attachment, restore it into an empty state folder, and read
// the same thing back from a fresh Store. A changed file fails the check.
import { expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../core/bus.ts";
import { Store } from "../core/store.ts";
import { restore, Storage, verify } from "./storage.ts";

test("a backup restores into an empty state folder", () => {
  const root = mkdtempSync(join(tmpdir(), "keel-backup-"));
  try {
    const src = new Store(join(root, "src"));
    const s = src.createSession({ model: "p:m", workspace: root, title: "kept" });
    const image = { type: "image", media_type: "image/png", data: "iVBORw0KGgo=" };
    src.append(s.id, "user", { text: "hello", images: [image] });
    src.append(s.id, "assistant", { blocks: [{ type: "text", text: "hi" }], model: "p:m", usage: {}, stop: "end_turn" });
    const storage = new Storage(src, {} as any, new Bus(), {} as any);
    const b = storage.backup("test");
    expect(b.sessions).toBe(1);
    expect(b.events).toBe(2);

    const dst = join(root, "dst");
    const r = restore(dst, b.path);
    expect(r.ok).toBe(true);
    const back = new Store(dst);
    expect(back.session(s.id)?.title).toBe("kept");
    expect(back.events(s.id).map((e) => [e.id, e.seq, e.kind])).toEqual(src.events(s.id).map((e) => [e.id, e.seq, e.kind]));
    expect(back.events(s.id)[0]!.data.images[0].data).toBe(image.data);

    appendFileSync(join(b.path, "keel.db"), "x");
    const bad = verify(b.path);
    expect(bad.ok).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

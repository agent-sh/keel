// The dev watcher's decisions, in a fixture folder with a slow fake installer.
// Run with: bun test ./scripts
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { holder, poke, reloader } from "./dev-watch.ts";

const made: string[] = [];
afterEach(() => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); });

// A checkout with one source file, and a reloader on it whose installer takes
// `ms` and exits with the next of `codes`. `events` is what happened, in order.
function fixture(ms = 40, codes: number[] = []) {
  const top = mkdtempSync(join(tmpdir(), "keel-dev-watch-"));
  made.push(top);
  mkdirSync(join(top, "src"));
  mkdirSync(join(top, "ui", "src"), { recursive: true });
  writeFileSync(join(top, "src", "a.ts"), "export {};\n");
  const events: string[] = [];
  let flying = 0, most = 0;
  const r = reloader({
    top,
    settle: { css: 5, reload: 10 },
    install: async () => {
      events.push("install starts");
      most = Math.max(most, ++flying);
      await Bun.sleep(ms);
      flying--;
      const code = codes.shift() ?? 0;
      events.push(`install ends ${code}`);
      return code;
    },
    poke: (f) => events.push(`poke ${f.slice(top.length + 1)}`),
    log: (l) => events.push(`log ${l}`),
  });
  return { r, events, most: () => most };
}

test("a burst of notifications runs one install at a time, and the last manifest change is installed before the last reload", async () => {
  const { r, events, most } = fixture();
  r.manifest("change", "package.json");
  r.source("rename", "a.ts");
  await Bun.sleep(25); // the first install is running
  for (let i = 0; i < 5; i++) {
    r.manifest("change", "bun.lock");
    r.source("rename", "a.ts");
    await Bun.sleep(12); // each notification arrives after the one before it settled
  }
  events.push("last manifest change");
  r.manifest("change", "package.json");
  await r.idle();
  expect(most()).toBe(1);
  const lastChange = events.indexOf("last manifest change");
  const lastInstall = events.lastIndexOf("install starts");
  expect(lastInstall).toBeGreaterThan(lastChange);
  expect(events.at(-1)).toBe("poke src/main.ts");
  expect(events.at(-2)).toBe("install ends 0");
});

test("a source file that came back reloads without an install; a file that is gone does not", async () => {
  const { r, events } = fixture();
  r.source("rename", "a.ts");
  r.source("rename", "gone.ts");
  r.source("change", "a.ts");
  r.manifest("change", "README.md");
  await r.idle();
  expect(events).toEqual(["poke src/main.ts"]);
});

test("a failed install is reported and reloads nothing; the next manifest change installs again", async () => {
  const { r, events } = fixture(5, [1, 0]);
  r.manifest("change", "package.json");
  await r.idle();
  expect(events.slice(0, 2)).toEqual(["install starts", "install ends 1"]);
  expect(events[2]).toContain("bun install failed (exit 1); nothing is reloaded");
  expect(events.some((e) => e.startsWith("poke"))).toBe(false);
  r.manifest("change", "bun.lock");
  await r.idle();
  expect(events.slice(3)).toEqual(["install starts", "install ends 0", "poke src/main.ts"]);
});

test("an imported stylesheet pokes styles.css; styles.css itself pokes nothing", async () => {
  const { r, events } = fixture();
  r.css("change", "styles.css");
  await r.idle();
  expect(events).toEqual([]);
  r.css("rename", "toolkit.css");
  r.css("change", "panels/bridge.css");
  r.css("change", "App.tsx");
  await r.idle();
  expect(events).toEqual(["poke ui/src/styles.css"]);
});

test("a poke changes the file's time and none of its bytes; the lock names the daemon", async () => {
  const top = mkdtempSync(join(tmpdir(), "keel-dev-watch-"));
  made.push(top);
  const f = join(top, "styles.css");
  writeFileSync(f, "@import \"./a.css\";\n");
  const before = statSync(f);
  await Bun.sleep(15);
  poke(f);
  const after = statSync(f);
  expect(readFileSync(f, "utf8")).toBe("@import \"./a.css\";\n");
  expect(after.ino).toBe(before.ino);
  expect(after.mtimeMs).toBeGreaterThan(before.mtimeMs);
  writeFileSync(join(top, "empty.css"), "");
  poke(join(top, "empty.css"));
  poke(join(top, "missing.css"));
  expect(statSync(join(top, "empty.css")).size).toBe(0);

  expect(holder(top)).toBeUndefined();
  writeFileSync(join(top, "daemon.lock"), JSON.stringify({ pid: process.pid }));
  expect(holder(top)).toBe(process.pid);
  writeFileSync(join(top, "daemon.lock"), JSON.stringify({ pid: 2 ** 22 + 1 }));
  expect(holder(top)).toBeUndefined();
});

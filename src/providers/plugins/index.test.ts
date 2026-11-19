import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Plugins } from "./index.ts";

// A hot reload builds a new plugin registry in the same process: a plugin
// whose entry did not change keeps its process; a changed entry restarts.
const stub = join(import.meta.dir, "../../../test/fixtures/plugin-check-stub.ts");

test("a reload keeps an unchanged plugin's process and restarts a changed one", async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? "/var/tmp", "keel-plugins-"));
  const conf = join(dir, "config");
  process.env.KEEL_CONFIG_DIR = conf;
  mkdirSync(conf);
  const write = (args: string) => writeFileSync(join(conf, "plugins.toml"), `[plugins.stub]\ncommand = "${stub}"\nargs = [${args}]\n`);
  write("");
  const a = new Plugins(dir, () => {});
  try {
    a.load();
    await a.settled();
    const pid = a.procs.get("stub")!.pid;
    expect(pid).toBeGreaterThan(0);
    const b = new Plugins(dir, () => {});
    b.load();
    await b.settled();
    expect(b.procs.get("stub")!.pid).toBe(pid);
    expect(b.procs.get("stub")!.state).toBe("ready");
    write(`"leak"`);
    b.load();
    await b.settled();
    expect(b.procs.get("stub")!.pid).not.toBe(pid);
    b.killAll();
  } finally {
    a.killAll();
    delete process.env.KEEL_CONFIG_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Plugins } from "./index.ts";

// Each test points the config folder at one of its own and puts back the one the run started with.
const CONFIG_BEFORE = process.env.KEEL_CONFIG_DIR!;

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
    process.env.KEEL_CONFIG_DIR = CONFIG_BEFORE;
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

// A plugin that cannot start is one failure: its process ends, the call the
// start was waiting on fails and the start itself fails, all for one cause.
for (const [name, command, said] of [
  ["exits at once", "/usr/bin/false", "plugin gone-a its output ended"],
  ["is not there", "/nonexistent/keel-plugin", "plugin gone-b start failed: ENOENT"],
] as const) {
  test(`a plugin whose command ${name} is captured once a start, and restarts once`, async () => {
    const id = said.split(" ")[1]!;
    const dir = mkdtempSync(join(process.env.TMPDIR ?? "/var/tmp", "keel-plugins-"));
    const conf = join(dir, "config");
    process.env.KEEL_CONFIG_DIR = conf;
    mkdirSync(conf);
    writeFileSync(join(conf, "plugins.toml"), `[plugins.${id}]\ncommand = "${command}"\n`);
    const got: { message: string; ctx: any }[] = [];
    const p = new Plugins(dir, (e, ctx) => got.push({ message: (e as Error).message, ctx }));
    try {
      p.load();
      await p.settled();
      await Bun.sleep(300);
      expect(got.map((g) => g.message.slice(0, said.length))).toEqual([said]);
      expect(got[0]!.ctx).toMatchObject({ plugin: id, at: "start" });
      expect(p.procs.get(id)!.state).toBe("restarting");
      // The restart a second later is one start, failing the same way once more (the one
      // after it waits two seconds, so a second report beside it would show here).
      for (let i = 0; i < 100 && got.length < 2; i++) await Bun.sleep(50);
      await Bun.sleep(200);
      expect(got.length).toBe(2);
    } finally {
      p.killAll();
      process.env.KEEL_CONFIG_DIR = CONFIG_BEFORE;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
}

// A plugin that refuses the host is stopped for good: one capture, no restart.
test("a plugin that refuses the host is captured once and not started again", async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? "/var/tmp", "keel-plugins-"));
  const conf = join(dir, "config");
  process.env.KEEL_CONFIG_DIR = conf;
  mkdirSync(conf);
  writeFileSync(join(conf, "plugins.toml"), `[plugins.stub]\ncommand = "${stub}"\nargs = ["refuse"]\n`);
  const got: { message: string; ctx: any }[] = [];
  const p = new Plugins(dir, (e, ctx) => got.push({ message: (e as Error).message, ctx }));
  try {
    p.load();
    await p.settled();
    await Bun.sleep(1500); // longer than the first restart delay
    expect(got.map((g) => [g.message, g.ctx.plugin, g.ctx.at])).toEqual([["plugin stub: this host is not supported", "stub", "start"]]);
    const proc = p.procs.get("stub")!;
    expect([proc.state, proc.reason]).toEqual(["stopped", "the plugin refused this host: plugin stub: this host is not supported"]);
  } finally {
    p.killAll();
    process.env.KEEL_CONFIG_DIR = CONFIG_BEFORE;
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

// A plugin's openai_responses route is a server that speaks the protocol, not
// known to be OpenAI's: its system prompt goes as `instructions`, unless its
// plugins.toml entry says `system_prompt = "developer"`.
test("a plugin's Responses route keeps instructions unless its entry puts the system prompt in the input", async () => {
  const { codecFor } = await import("./index.ts");
  const { readPlugins } = await import("./config.ts");
  const decl = { id: "p", label: "P", wire: "openai_responses", system_prefix: "Prefix." };
  const req = { model: "m", system: "sys", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], tools: [], signal: new AbortController().signal } as any;
  const ctx = { origin: "plug/p:m", sessionKey: "k", efforts: [] };
  const plain = codecFor(decl, true).body(req, ctx);
  expect(plain.instructions).toBe("Prefix.\n\nsys");
  expect(plain.input.map((it: any) => it.role)).toEqual(["user"]);
  const dev = codecFor(decl, true, "developer").body(req, ctx);
  expect("instructions" in dev).toBe(false);
  expect(dev.input[0]).toEqual({ type: "message", role: "developer", content: [{ type: "input_text", text: "Prefix.\n\nsys" }] });

  const dir = mkdtempSync(join(process.env.TMPDIR ?? "/var/tmp", "keel-plugins-"));
  process.env.KEEL_CONFIG_DIR = dir;
  try {
    const write = (v: string) => writeFileSync(join(dir, "plugins.toml"), `[plugins.stub]\ncommand = "${stub}"\n[plugins.stub.providers.p]\nsystem_prompt = "${v}"\n`);
    write("developer");
    const ok = readPlugins().entries[0]!;
    expect(ok.problem).toBeUndefined();
    expect(ok.providers.p!.system_prompt).toBe("developer");
    write("first");
    expect(readPlugins().entries[0]!.problem).toContain("system_prompt");
  } finally {
    process.env.KEEL_CONFIG_DIR = CONFIG_BEFORE;
    rmSync(dir, { recursive: true, force: true });
  }
});

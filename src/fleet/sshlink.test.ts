import { expect, spyOn, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { ownEnv, tempTree } from "../../test/env.ts";
import { Bus } from "../core/bus.ts";
import { Store } from "../core/store.ts";
import type { MachineRow } from "./db.ts";
import { Fleet } from "./fleet.ts";
import { handsBundle, parseProbe } from "./sshlink.ts";

const dir = tempTree("sshlink-");
ownEnv({ KEEL_SSH: "/bin/false", KEEL_REMOTE_DIR: "hands cache", XDG_RUNTIME_DIR: dir });

test("Hands install logs at info and prunes only unused bundles", async () => {
  const home = join(dir, "remote home");
  const base = join(home, "hands cache");
  const { hash } = await handsBundle();
  const run = join(base, `run-${hash}`);
  const helper = join(base, `hands-${hash}.js`);
  const runtime = join(base, `bun-${Bun.version}-linux-x64`, "bun");
  const active = join(base, "hands-111111111111.js");
  const activeRun = join(base, "run-111111111111");
  const stale = join(base, "hands-222222222222.js");
  const newer = join(base, "hands-666666666666.js");
  const kept = ["hands-custom.js", "hands-333333333333.js.part", "spill"];
  mkdirSync(run, { recursive: true });
  mkdirSync(activeRun);
  writeFileSync(join(activeRun, "hands.pid"), "2");
  mkdirSync(dirname(runtime), { recursive: true });
  writeFileSync(runtime, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  for (const f of [active, stale, ...kept.map((n) => join(base, n))]) {
    writeFileSync(f, "keep");
    utimesSync(f, 1, 1);
  }
  writeFileSync(newer, "keep");
  const tomorrow = new Date(Date.now() + 86_400_000);
  utimesSync(newer, tomorrow, tomorrow);
  symlinkSync(active, join(base, "hands-444444444444.js"));
  mkdirSync(join(base, "hands-555555555555.js"));
  writeFileSync(join(run, "hands.pid"), "1");
  // Leave a socket inode, not a running daemon. Relative binding works even
  // when the absolute scratch directory is too long for a Unix socket.
  const socket = Bun.spawnSync([process.execPath, "-e", `Bun.listen({ unix: "hands.sock", socket: { data() {} } }); process.exit(0)`], { cwd: run });
  expect(socket.exitCode).toBe(0);

  const store = new Store(join(dir, "state"));
  const fleet = new Fleet(store, new Bus(), { capture: (_: string, e: unknown) => { throw e; } } as any);
  const link = fleet.sshLink({ id: "stand-in", ssh_host: "stand-in" } as MachineRow);
  link.probe = parseProbe(`home=${home}\nos=Linux\narch=x86_64`);
  link.master = async () => "stand-in";
  // Run exactly what would go over SSH, with a stand-in process table.
  let canScan = "yes";
  link.run = async (script, opts) => {
    const ps = `ps() {
      if [ "$1" = -p ]; then printf '%s\\n' "$CURRENT"
      elif [ "$CAN_SCAN" = yes ] && [ "$1" = -Aww ]; then printf '%s\\n' "$ACTIVE"
      else return 1; fi
    }\n`;
    const p = Bun.spawnSync(["/bin/sh", "-c", ps + script], {
      env: { PATH: "/usr/bin:/bin", HOME: home, CAN_SCAN: canScan, ACTIVE: `bun ${active} --dir ${activeRun}`, CURRENT: `bun ${helper}` },
      stdin: opts?.stdin, stdout: "pipe", stderr: "pipe", timeout: 3000,
    });
    return { code: p.exitCode ?? 1, out: p.stdout.toString(), err: p.stderr.toString() };
  };
  const info = spyOn(console, "info").mockImplementation(() => {});
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    // The fake SSH program stops at forwarding, after the install command ran.
    await expect(link.fetch("/ping")).rejects.toThrow("the forward to the helper failed");
    expect({
      files: readdirSync(base).sort(),
      installedInfo: info.mock.calls.flat().filter((v) => String(v).startsWith("keel fleet: installed")),
      installedErrors: error.mock.calls.flat().filter((v) => String(v).startsWith("keel fleet: installed")),
    }).toEqual({
      files: [basename(dirname(runtime)), basename(helper), basename(active), basename(newer), basename(run), basename(activeRun),
        "hands-444444444444.js", "hands-555555555555.js", ...kept].sort(),
      installedInfo: [`keel fleet: installed on stand-in: ${helper}`],
      installedErrors: [],
    });
    expect(readdirSync(run).sort()).toEqual(["hands.pid", "hands.sock"]);
    expect(readFileSync(join(activeRun, "hands.pid"), "utf8")).toBe("2");

    writeFileSync(stale, "cannot tell whether this is active");
    utimesSync(stale, 1, 1);
    canScan = "no";
    await expect(link.fetch("/ping")).rejects.toThrow("the forward to the helper failed");
    expect(readFileSync(stale, "utf8")).toBe("cannot tell whether this is active");
  } finally {
    info.mockRestore();
    error.mockRestore();
    store.db.close();
  }
});

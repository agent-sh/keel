// keel devices beside a daemon: the store is the daemon's to open. A daemon holds the state folder when
// it holds the claim, or when the folder's lock file names one that is still there (a claim can be lost:
// the kernel drops it when its holder closes any handle of the file). Either way the command asks the
// daemon and opens nothing.
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pidBorn } from "../core/pid.ts";
import { mobileCommands } from "./mobile.ts";

test("with a daemon named in the lock file the mobile commands ask it, though the claim is free", async () => {
  const state = mkdtempSync(join(tmpdir(), "keel-mobile-"));
  const asked: string[] = [];
  const daemon = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => {
      const u = new URL(req.url);
      asked.push(`${req.method} ${u.pathname}`);
      if (u.pathname === "/api/mobile/devices") return Response.json({ devices: [{ id: "d1", name: "Phone", nolock: 0, revoked: 0, push: { registered: true } }] });
      if (req.method === "DELETE") return u.pathname.endsWith("/d1") ? Response.json({ ok: true }) : Response.json({ error: "unknown device" }, { status: 404 });
      return Response.json({ error: "no" }, { status: 404 });
    },
  });
  const out: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => void out.push(a.join(" "));
  try {
    // A daemon that is there (this test's parent stands in for it) and holds no claim.
    writeFileSync(join(state, "daemon.lock"), JSON.stringify({ pid: process.ppid, born: pidBorn(process.ppid), url: `http://127.0.0.1:${daemon.port}` }));
    expect(await mobileCommands.devices(["--state-dir", state])).toBe(0);
    expect(out.join("\n")).toContain('d1  "Phone"');
    expect(await mobileCommands.revoke(["d1", "--state-dir", state])).toBe(0);
    expect(await mobileCommands.revoke(["nope", "--state-dir", state])).toBe(0);
    expect(out.slice(-2)).toEqual(["revoked", "unknown device"]);
    expect(asked).toEqual(["GET /api/mobile/devices", "DELETE /api/mobile/devices/d1", "DELETE /api/mobile/devices/nope"]);
    // Nothing of the store was opened or made by the command.
    expect(existsSync(join(state, "keel.db"))).toBe(false);
  } finally {
    console.log = log;
    daemon.stop(true);
    rmSync(state, { recursive: true, force: true });
  }
});

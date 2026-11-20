import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireLock, recordUrl } from "../../src/admin/daemon.ts";
import * as activity from "../../src/automation/activity.ts";
import * as alerts from "../../src/automation/alerts.ts";
import { setDeps } from "../../src/automation/core.ts";
import * as snooze from "../../src/automation/snooze.ts";
import { Bus } from "../../src/core/bus.ts";
import { Store } from "../../src/core/store.ts";
import { pumpLines } from "../../src/core/proc.ts";

// This fixture is started only via dbus-run-session; every URL is sent to a
// local stand-in instead of starting a browser.
assert.equal(process.env.KEEL_PRIVATE_DESKTOP_FIXTURE, "1");
const state = mkdtempSync(join(tmpdir(), "keel-desktop-alert-"));
process.env.GIO_USE_VFS = "local";
const service = Bun.spawn(["gjs", join(import.meta.dir, "gnome-notifications.js")], { stdout: "pipe", stderr: "inherit" });
const lines: string[] = [];
void pumpLines(service.stdout, (line) => lines.push(line));
const waitFor = async (ready: () => boolean, desc: string) => {
  const end = Date.now() + 2000;
  while (!ready()) {
    if (Date.now() >= end) throw new Error(`timed out waiting for ${desc}`);
    await Bun.sleep(10);
  }
};
try {
  await waitFor(() => lines[0] === "ready", "private notification service");
  const opener = join(state, "opener.ts");
  const opened = join(state, "opened");
  writeFileSync(opener, `Bun.write(${JSON.stringify(opened)}, JSON.stringify([Bun.argv[2], process.env.XDG_ACTIVATION_TOKEN]));`);
  process.env.KEEL_BROWSER = `${process.execPath} ${opener}`;

  const store = new Store(state);
  acquireLock(state);
  recordUrl(state, "http://127.0.0.1:48371");
  const errors: unknown[] = [];
  setDeps({ store, bus: new Bus(), errors: { capture: (_source: string, err: unknown) => errors.push(err) } } as any);
  alerts.migrate();
  activity.migrate();
  snooze.migrate();
  alerts.saveSettings({ routes: Object.fromEntries(alerts.KINDS.map((kind) => [kind, ["desktop"]])) as any });
  const session = store.createSession({ title: "Example", model: "test", workspace: state });
  const old = alerts.raise("agent", session.id, "old", "irrelevant")!;
  await waitFor(() => alerts.get(old.id)?.delivery?.desktop?.state === "sent", "initial desktop handoff");
  const title = "--synthetic 'title'";
  const body = "first\nsecond \\\"line\\\"";
  const fresh = alerts.raise("agent", session.id, title, body, { event_id: "example-event" })!;
  await waitFor(() => alerts.get(fresh.id)?.delivery?.desktop?.state === "sent" && !!lines[2], "replacement handoff");
  const first = JSON.parse(lines[1]!);
  const replacement = JSON.parse(lines[2]!);
  assert.deepEqual(replacement, { id: first.id, replace: first.id, title, body });
  assert.equal(existsSync(opened), false, "handoff does not open a browser");

  const click = Bun.spawnSync(["gdbus", "call", "--session", "--dest", "org.freedesktop.Notifications", "--object-path", "/org/freedesktop/Notifications", "--method", "org.freedesktop.Notifications.Click", String(replacement.id)], { timeout: 2000 });
  assert.equal(click.exitCode, 0, click.stderr.toString());
  await waitFor(() => existsSync(opened), "browser stand-in");
  assert.deepEqual(await Bun.file(opened).json(), [`http://127.0.0.1:48371/s/${session.id}?e=example-event`, "synthetic-token"]);
  assert.deepEqual(errors, []);
} finally {
  service.kill();
  await service.exited;
  rmSync(state, { recursive: true, force: true });
}
process.exit(0);

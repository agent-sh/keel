// A command Keel runs for a session at a time nobody is there to answer (a loop's gate): wrapped as one of the
// session's own commands is, and refused when its folder is not the one it was made in.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../core/bus.ts";
import { Store } from "../core/store.ts";
import { Gate } from "./gate.ts";

function setup(sandboxed = true) {
  const store = new Store(mkdtempSync(join(tmpdir(), "keel-unatt-")));
  const g = new Gate(store, new Bus(), () => sandboxed);
  const workspace = mkdtempSync(join(tmpdir(), "keel-unatt-ws-"));
  const s = store.createSession({ model: "m", workspace, title: "t" });
  return { store, g, s, workspace };
}

test("commandOf: a session whose folder is not the one it was made in runs nothing", async () => {
  const { g, s, workspace } = setup();
  g.setPerm(s.id, { mode: "ask", sandbox: "workspace-write" });
  expect(await g.commandOf(s.id, "git status", join(workspace, "spill"))).toHaveProperty("wrap");
  renameSync(workspace, `${workspace}.old`);
  mkdirSync(workspace);
  expect(await g.commandOf(s.id, "git status", join(workspace, "spill"))).toMatchObject({ deny: expect.stringContaining("not the folder") });
});

test("commandOf wraps as the session's own commands are, and not at all when its sandbox is off", async () => {
  const on = setup(true);
  on.g.setPerm(on.s.id, { sandbox: "workspace-write" });
  const how = await on.g.commandOf(on.s.id, "true", join(on.workspace, "spill"));
  if ("deny" in how) throw new Error(how.deny);
  expect(how.wrap(["bash", "-c", "true"]).length).toBeGreaterThanOrEqual(3);
  on.g.setPerm(on.s.id, { sandbox: "off" });
  const bare = await on.g.commandOf(on.s.id, "true", join(on.workspace, "spill"));
  if ("deny" in bare) throw new Error(bare.deny);
  expect(bare.wrap(["bash", "-c", "true"])).toEqual(["bash", "-c", "true"]);
});

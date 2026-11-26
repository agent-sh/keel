// A group read waits for the current ssh configuration without blocking the loop on `ssh -G`.
import { expect, spyOn, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ownEnv, tempTree } from "../../test/env.ts";

const dir = tempTree("sshconfig-");
const config = join(dir, "config");
const ssh = join(dir, "ssh");
writeFileSync(ssh, `#!/bin/sh
printf 'user me\\n'
if [ "$2" = routed ]; then
  sed -n 's/^  HostName /hostname /p' "\${0%/*}/routes"
else
  printf 'hostname %s.example\\n' "$2"
fi
`, { mode: 0o755 });
ownEnv({ KEEL_SSH: ssh, KEEL_SSH_CONFIG: config });
const hosts = (names: string[]) => writeFileSync(config, names.map((n) => `Host ${n}\n  User me\n`).join(""));

test("a cold group read joins warmup without resolving any alias synchronously", async () => {
  const { hostGroups, warmHostGroups } = await import("./sshconfig.ts");
  hosts(["cold"]);
  const sync = spyOn(Bun, "spawnSync");
  const spawn = spyOn(Bun, "spawn");
  const warming = warmHostGroups(dir);
  try {
    const groups = await hostGroups(dir);
    expect(sync.mock.calls.filter(([cmd]) => Array.isArray(cmd) && cmd[0] === ssh)).toHaveLength(0);
    expect(spawn.mock.calls.filter(([cmd]) => Array.isArray(cmd) && cmd[0] === ssh)).toHaveLength(1);
    expect(groups).toMatchObject([{ alias: "cold", hostname: "cold.example" }]);
  } finally {
    await warming;
    spawn.mockRestore();
    sync.mockRestore();
  }
});

test("the first read after an edit sees the current aliases", async () => {
  const { hostGroups, warmHostGroups } = await import("./sshconfig.ts");
  hosts(["one", "removed"]);
  await warmHostGroups(dir);
  expect((await hostGroups(dir)).map((g) => g.alias)).toEqual(["one", "removed"]);

  hosts(["one", "added"]);
  const first = await hostGroups(dir);
  await warmHostGroups(dir); // Let any background refresh finish before changing the fixture again.
  expect(first).toMatchObject([{ alias: "one" }, { alias: "added", hostname: "added.example" }]);
});

test("editing an Include refreshes groups even when the aliases stay the same", async () => {
  const { hostGroups, warmHostGroups } = await import("./sshconfig.ts");
  const routes = join(dir, "routes");
  writeFileSync(config, `Include "${routes}"\n`);
  writeFileSync(routes, "Host routed\n  HostName before.example\n");
  await warmHostGroups(dir);
  expect(await hostGroups(dir)).toMatchObject([{ alias: "routed", hostname: "before.example" }]);

  writeFileSync(routes, "Host routed\n  HostName after.example\n");
  expect(await hostGroups(dir)).toMatchObject([{ alias: "routed", hostname: "after.example" }]);
});

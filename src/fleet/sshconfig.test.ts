// The machines of the ssh configuration are grouped from one `ssh -G` an alias. A change of the configuration
// is read again off the loop: the groups made before it answer meanwhile, and the new ones replace them.
import { expect, test } from "bun:test";
import { chmodSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ownEnv, tempTree } from "../../test/env.ts";

const dir = tempTree("sshconfig-");
const config = join(dir, "config");
const ssh = join(dir, "ssh");
// A stand-in for ssh that takes its time for each alias, as ssh does on a busy machine.
writeFileSync(ssh, `#!/bin/sh\nsleep 0.2\nprintf 'user me\\nhostname %s.example\\n' "$2"\n`);
chmodSync(ssh, 0o755);
ownEnv({ KEEL_SSH: ssh, KEEL_SSH_CONFIG: config });
const hosts = (names: string[]) => writeFileSync(config, names.map((n) => `Host ${n}\n  User me\n`).join(""));

test("a changed configuration is grouped again off the loop, the earlier groups answering meanwhile", async () => {
  const { hostGroups, warmHostGroups } = await import("./sshconfig.ts");
  hosts(["one", "two", "three", "four", "five"]);
  await warmHostGroups(dir);
  expect(hostGroups(dir).map((g) => g.alias)).toEqual(["one", "two", "three", "four", "five"]);

  hosts(["one", "two", "three", "four", "five", "six"]);
  utimesSync(config, new Date(), new Date(Date.now() + 5_000));
  const t0 = performance.now();
  const meanwhile = hostGroups(dir);
  // Five aliases at 0.2 s each would hold the loop for a second.
  expect(performance.now() - t0).toBeLessThan(150);
  expect(meanwhile.map((g) => g.alias)).toHaveLength(5);
  await warmHostGroups(dir);
  expect(hostGroups(dir).map((g) => g.alias)).toContain("six");
  expect(hostGroups(dir).find((g) => g.alias === "six")?.hostname).toBe("six.example");
});

// Pure pieces of the fleet an e2e cannot reach: the ssh configuration's hosts,
// the fence on what a peer's tool call names, and the link proof.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { outsideRoot } from "./hands.ts";
import { proof } from "./link.ts";
import { sshHosts } from "./sshconfig.ts";

test("ssh hosts: concrete aliases in file order, includes followed, patterns skipped", () => {
  const home = mkdtempSync(join(tmpdir(), "keel-ssh-"));
  mkdirSync(join(home, ".ssh/conf.d"), { recursive: true });
  writeFileSync(join(home, ".ssh/config"), "Include conf.d/*\nHost alpha beta\n  HostName 10.0.0.1\nHost *.corp !gamma\nHost=delta # comment\nMatch all\nHost -oProxyCommand=x\n");
  writeFileSync(join(home, ".ssh/conf.d/a"), "Host first\nHost alpha\n");
  expect(sshHosts(home)).toEqual(["first", "alpha", "beta", "delta"]);
});

test("the fence: every path spelling inside the granted root, links followed", () => {
  const root = mkdtempSync(join(tmpdir(), "keel-root-"));
  const out = mkdtempSync(join(tmpdir(), "keel-out-"));
  symlinkSync(out, join(root, "escape"));
  const spill = join(out, "spill");
  expect(outsideRoot({ file_path: "a.txt" }, root, root, spill)).toEqual([]);
  expect(outsideRoot({ file_path: "../x" }, root, root, spill)).toEqual(["../x"]);
  expect(outsideRoot({ path: "escape/f" }, root, root, spill)).toEqual(["escape/f"]);
  expect(outsideRoot({ absolute_path: "/etc/passwd" }, root, root, spill)).toEqual(["/etc/passwd"]);
  expect(outsideRoot({}, "/etc", root, spill)).toEqual(["/etc"]);
  expect(outsideRoot({ input: "*** Begin Patch\n*** Update File: ../../x\n*** End Patch" }, root, root, spill)).toEqual(["../../x"]);
  expect(outsideRoot({ file_path: join(spill, "out.txt") }, root, root, spill)).toEqual([]); // the connection's own output files
});

test("the proof binds the nonce and the answering daemon", () => {
  expect(proof("k", "n1", "d1")).not.toEqual(proof("k", "n2", "d1"));
  expect(proof("k", "n1", "d1")).not.toEqual(proof("k", "n1", "d2"));
  expect(proof("k", "n1", "d1")).toMatch(/^[0-9a-f]{64}$/);
});

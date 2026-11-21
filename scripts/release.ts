// A release, packaged and not published: the binary for one target with its
// UI bundle, what it was built from, and checksums.
//   bun scripts/release.ts [--out DIR] [--target bun-linux-x64]
// The target defaults to this machine's. DIR (default dist/release) gets:
//   keel-<target>.tar.gz   keel-<target>/{keel, keel-ui.tar.gz, LICENSE, release.json, SHA256SUMS}
//   release.json           { name, revision, target, api, ui, built_at, files: [{ name, bytes, sha256 }] }
//   SHA256SUMS             the archive's checksum, in sha256sum's format
// Check it with scripts/release-check.sh DIR: it verifies and unpacks the
// archive outside the source tree and runs the binary with no Bun on PATH.
// A target of another platform is packaged the same way and has to be
// checked on that platform.
import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const root = resolve(import.meta.dir, "..");
const { values } = parseArgs({ options: { out: { type: "string" }, target: { type: "string" } } });
const target = values.target ?? `bun-${process.platform}-${process.arch}`;
const name = target.replace(/^bun-/, "");
const out = resolve(values.out ?? join(root, "dist", "release"));
const stage = join(out, `keel-${name}`);
const run = (cmd: string[], cwd = root) => {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "inherit" });
  if (r.exitCode !== 0) process.exit(r.exitCode ?? 1);
  return r.stdout.toString();
};
const sha256 = (file: string) => new Bun.CryptoHasher("sha256").update(readFileSync(file)).digest("hex");

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
const built = run(["bun", join(root, "scripts/build.ts"), join(stage, "keel"), target]);
const line = /\(revision (\S+), api (\S+), UI (\d+)\)/.exec(built);
if (!line) throw new Error(`the build did not say what it built:\n${built}`);
const [, revision, api, ui] = line;
copyFileSync(join(root, "LICENSE"), join(stage, "LICENSE"));
const files = ["keel", "keel-ui.tar.gz", "LICENSE"].map((f) => ({ name: f, bytes: statSync(join(stage, f)).size, sha256: sha256(join(stage, f)) }));
const manifest = { name: "keel", revision, target: name, api, ui: Number(ui), built_at: new Date(Number(ui)).toISOString(), files };
const json = JSON.stringify(manifest, null, 2) + "\n";
writeFileSync(join(stage, "release.json"), json);
writeFileSync(join(stage, "SHA256SUMS"), files.map((f) => `${f.sha256}  ${f.name}\n`).join(""));
const archive = `keel-${name}.tar.gz`;
run(["tar", "-C", out, "-czf", join(out, archive), `keel-${name}`]);
rmSync(stage, { recursive: true, force: true });
writeFileSync(join(out, "release.json"), json);
writeFileSync(join(out, "SHA256SUMS"), `${sha256(join(out, archive))}  ${archive}\n`);
console.log(`packaged ${join(out, archive)} (revision ${revision}, target ${name}, api ${api})`);
console.log(`nothing was published. Check it: scripts/release-check.sh ${out}`);

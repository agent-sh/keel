#!/usr/bin/env bun
// Stands in for gh in the PR Steward spec. The spec writes $KEEL_GH_STANDIN_DIR/pr.json (the pull request as
// GitHub shows it: state, checks, comments, reviews, mergeable, plus `viewer`, `inline`, `perms`, `log`, `checksAt`); the
// head is read from the spec's own bare repository ($STEWARD_BARE), so a push by the session moves it.
// Every call is appended to calls.log, which a spec reads to see that nothing merged or approved.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const dir = process.env.KEEL_GH_STANDIN_DIR!;
const args = process.argv.slice(2);
appendFileSync(join(dir, "calls.log"), `${args.join(" ")}\n`);
const file = join(dir, "pr.json");
const pr = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
const fail = (m: string) => { process.stderr.write(`${m}\n`); process.exit(1); };
const [a, b] = args;

if (a === "pr" && b === "view") {
  if (!pr) fail("no pull requests found for branch");
  const head = spawnSync("git", ["--git-dir", process.env.STEWARD_BARE!, "rev-parse", `refs/heads/${pr.headRefName}`], { encoding: "utf8" }).stdout.trim();
  const { viewer: _v, inline: _i, perms: _p, log: _l, checksAt, ...view } = pr;
  // The checks are of one head (`checksAt`, or "*" for any): a head pushed since has checks that are still running.
  if (checksAt && checksAt !== "*" && checksAt !== head) view.statusCheckRollup = [{ name: "build", status: "IN_PROGRESS", conclusion: "" }];
  process.stdout.write(JSON.stringify({ ...view, headRefOid: head }));
} else if (a === "api" && b === "user") {
  process.stdout.write(`${pr?.viewer ?? "owner"}\n`);
} else if (a === "api" && /\/pulls\/\d+\/comments/.test(String(b))) {
  process.stdout.write(JSON.stringify(pr?.inline ?? []));
} else if (a === "api" && /\/collaborators\/[^/]+\/permission/.test(String(b))) {
  process.stdout.write(`${pr?.perms?.[String(b).split("/")[3]!] ?? "read"}\n`);
} else if (a === "run" && b === "view") {
  process.stdout.write(String(pr?.log ?? ""));
} else if (a === "auth") {
  process.stdout.write("standin-token\n");
} else {
  // A merge, an approval or anything else: the spec reads the log, and nothing happens.
  fail(`the stand-in does not do: ${args.join(" ")}`);
}

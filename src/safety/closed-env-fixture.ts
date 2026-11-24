// A program for closed-env.test.ts: starts the way the daemon does, then says what it holds.
import { readFileSync, readlinkSync } from "node:fs";
import { startClean } from "../core/relaunch.ts";

const pid = process.pid;
startClean();
const seen = (text: string) => text.split("\0").filter((l) => /^(TEST_|KEEL_SECRET_ENV|KEEL_ENV_CLEANED)/.test(l)).map((l) => l.split("=")[0]);
// What a child of this process reads of it (it is the same user, and a descendant).
const child = Bun.spawnSync(["sh", "-c", `cat /proc/${process.pid}/environ`]);
const own = Bun.spawnSync(["sh", "-c", 'printf "%s|%s|%s" "$TEST_API_KEY" "$KEEL_SECRET_ENV" "$KEEL_ENV_CLEANED"']);
console.log(JSON.stringify({
  samePid: pid === process.pid,
  childReadsNames: seen(child.stdout.toString()),
  childEnvText: child.stdout.toString().includes("sekrit"),
  startedWith: seen(readFileSync("/proc/self/environ", "utf8")),
  inProcess: process.env.TEST_API_KEY,
  tokenInProcess: process.env.TEST_TOKEN,
  plain: process.env.TEST_PLAIN,
  startedChild: own.stdout.toString(),
  stdin: readlinkSync("/proc/self/fd/0"),
  marker: process.env.KEEL_ENV_CLEANED ?? null,
}));

// Runs a program that speaks a protocol over its standard input and output and keeps every
// byte of both directions, so a test can read what was really on the two streams:
//   bun stdio-tap.ts <record prefix> <command> [args...]
// <prefix>.in holds what the program was sent, <prefix>.out what it answered.
import { appendFileSync } from "node:fs";

const [prefix, ...cmd] = process.argv.slice(2);
const child = Bun.spawn(cmd, { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
process.stdin.on("data", (d: Buffer) => {
  appendFileSync(`${prefix}.in`, d);
  child.stdin.write(d);
  child.stdin.flush();
});
process.stdin.on("end", () => child.stdin.end());
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(sig, () => child.kill(sig));
for await (const chunk of child.stdout) {
  appendFileSync(`${prefix}.out`, chunk);
  process.stdout.write(chunk);
}
process.exit((await child.exited) ?? 0);

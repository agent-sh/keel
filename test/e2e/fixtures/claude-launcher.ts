#!/usr/bin/env bun
// A stand-in for a claude that is a launcher (a wrapper script, an npm bin): its child is the program that
// runs the session (the claude stand-in beside this file, which keeps the session's record), with this
// process's stdio, and SIGINT, SIGTERM and SIGHUP passed on to it. Used by the in-place driver's tests
// (claude-code.test.ts).
import { spawn } from "node:child_process";
import { join } from "node:path";
const child = spawn(process.execPath, [join(import.meta.dir, "claude-code.ts"), ...process.argv.slice(2)], { stdio: "inherit" });
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => { try { child.kill(sig); } catch {} });
child.on("exit", (code, signal) => process.exit(signal ? 1 : code ?? 1));

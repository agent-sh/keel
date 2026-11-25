#!/usr/bin/env bun
// A stand-in for the npm package's codex (bin/codex.js): a launcher whose child is the native program, with
// this process's stdio, SIGINT, SIGTERM and SIGHUP passed on to it. The native is the app-server stand-in
// (codex-app-server.ts) beside this file. Used by the in-place driver's tests (codex-app.test.ts).
import { spawn } from "node:child_process";
import { join } from "node:path";
const child = spawn(process.execPath, [join(import.meta.dir, "codex-app-server.ts"), ...process.argv.slice(2)], { stdio: "inherit" });
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => { try { child.kill(sig); } catch {} });
child.on("exit", (code, signal) => process.exit(signal ? 1 : code ?? 1));

// The ChatGPT backend lists only the models a client of the version asked for
// knows. Codex's models cache names the version of whichever Codex wrote it
// last, which can be an older install than the one this daemon runs.
import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexProvider, newerVersion } from "./codex.ts";

test("newer of two versions compares numbers, not text", () => {
  expect(newerVersion("0.9.0", "0.10.0")).toBe("0.10.0");
  expect(newerVersion("1.2.3", undefined)).toBe("1.2.3");
  expect(newerVersion(undefined, undefined)).toBeUndefined();
});

test("the listing asks for the installed Codex's version over an older cache, and sees an upgrade without a restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "keel-codex-"));
  const home = join(dir, "home"), bin = join(dir, "bin");
  mkdirSync(home);
  mkdirSync(bin);
  writeFileSync(join(home, "auth.json"), JSON.stringify({ tokens: { access_token: "fixture-access", refresh_token: "fixture-refresh" }, last_refresh: new Date().toISOString() }));
  writeFileSync(join(home, "models_cache.json"), JSON.stringify({ client_version: "0.1.0", models: [] }));
  const codex = (v: string) => { writeFileSync(join(bin, "codex"), `#!/bin/sh\necho "codex-cli ${v}"\n`); chmodSync(join(bin, "codex"), 0o755); };
  codex("0.3.0");
  const asked: string[] = [];
  const server = Bun.serve({ port: 0, fetch: (req) => { asked.push(new URL(req.url).searchParams.get("client_version") ?? ""); return Response.json({ models: [] }); } });
  const env = { home: process.env.CODEX_HOME, base: process.env.KEEL_CODEX_BASE_URL, path: process.env.PATH };
  process.env.CODEX_HOME = home;
  process.env.KEEL_CODEX_BASE_URL = `http://127.0.0.1:${server.port}`;
  process.env.PATH = `${bin}:${env.path}`;
  try {
    const p = new CodexProvider();
    await p.list();
    expect(asked.at(-1)).toBe("0.3.0");
    // Codex upgraded while the daemon runs: the next listing asks for the new version.
    codex("0.4.10");
    await p.list();
    expect(asked.at(-1)).toBe("0.4.10");
    // A cache written by a newer Codex than the one on PATH wins.
    writeFileSync(join(home, "models_cache.json"), JSON.stringify({ client_version: "0.5.0", models: [] }));
    await p.list();
    expect(asked.at(-1)).toBe("0.5.0");
  } finally {
    server.stop(true);
    for (const [k, v] of [["CODEX_HOME", env.home], ["KEEL_CODEX_BASE_URL", env.base], ["PATH", env.path]] as const) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
});

import { existsSync } from "node:fs";
import { basename, resolve, relative } from "node:path";
import { defineConfig } from "@playwright/test";

// One e2e per feature, driving the real daemon and a real model (Haiku, the
// cheapest listed), with screenshots in both themes saved for review.
// The daemon under test is named every time (KEEL_URL): specs change daemon-wide
// settings while they run (a spend limit, the permission mode), so a default
// address would put them on whatever daemon a person is using there.
const url = process.env.KEEL_URL;
if (!url) throw new Error("Set KEEL_URL to the scratch dev daemon the specs drive (scripts/dev.sh <port>), e.g. KEEL_URL=http://127.0.0.1:<port>.");

// Playwright empties its output folder when a run starts, traces included. Each
// daemon gets its own folder (one run per daemon at a time, since specs change
// its settings), and no folder sits inside another run's: a run with a shared
// or parent folder deletes the traces of a run still writing them (ENOENT on
// a .trace or .network file at context close).
const shared = resolve(`${process.env.HOME}/.cache/keel-work/bun/e2e-out`);
const outputDir = `${shared}/${new URL(url).port || "80"}`;
// --output naming the shared folder (or one above it) would empty every
// other run's folder: refused, as the config default once did.
const argv = process.argv;
const i = argv.findIndex((a) => a === "--output" || a.startsWith("--output="));
const given = i < 0 ? null : argv[i]!.includes("=") ? argv[i]!.slice(9) : argv[i + 1];
if (given && !relative(resolve(given), shared).startsWith("..")) {
  throw new Error(`--output ${given} holds other runs' output folders, which Playwright empties when a run starts; use a folder of this run's own (the default is ${outputDir}).`);
}

// A daemon a spec starts takes the run's environment ({ ...process.env }). From a shell that names
// none of these, it would find the owner's own tools and setups: the real tacit (his memory store),
// parlar (his mic and speaker), his Hermes gateway (his phone) and the other harnesses' sessions and
// MCP servers in his home. Each gets a default here, so every daemon a spec starts inherits it: a
// TACIT_BIN and a KEEL_PARLAR that name no file (Keel then runs no memory tool and no voice, and
// looks nowhere else), a phone socket and the readers' homes under the e2e state. What the shell
// names is kept: scripts/dev.sh and a spec that wants a stand-in name their own.
// (test/e2e/spec-env.spec.ts checks what such a daemon would find.)
const envRoot = `${process.env.HOME}/.cache/keel-work/bun/e2e-state/run-env-${new URL(url).port || "80"}`;
const defaults: Record<string, string> = {
  TACIT_BIN: `${envRoot}/no-tacit`,
  KEEL_PARLAR: `${envRoot}/no-parlar`,
  KEEL_PHONE_SOCKET: `${envRoot}/phone/phone.sock`,
  KEEL_IMPORT_HOME: `${envRoot}/import/home`,
  KEEL_IMPORT_CLAUDE_DIR: `${envRoot}/import/claude`,
  KEEL_IMPORT_CODEX_DIR: `${envRoot}/import/codex`,
  KEEL_IMPORT_AGY_DIR: `${envRoot}/import/agy`,
  KEEL_IMPORT_HERMES_DIR: `${envRoot}/import/hermes`,
  KEEL_IMPORT_OPENCODE_DIR: `${envRoot}/import/opencode`,
  KEEL_IMPORT_KEEL_DB: `${envRoot}/import/keel.db`,
};
for (const [k, v] of Object.entries(defaults)) if (!process.env[k]?.trim()) process.env[k] = v;

// Spec files named on the command line run in the order they are named. Playwright by
// itself runs files by name whatever order they are given in, so a spec that passes only
// after another (it reads what the other left behind) is never seen failing. With the
// files named in another order than by name, each file is a project of its own and the
// projects run in the order named: `playwright test b.spec.ts a.spec.ts` runs b first
// (scripts/flake.ts names them shuffled). The workers read the order from the environment
// of the run, since their own command line names no file.
const ORDER = "KEEL_E2E_FILE_ORDER";
const namedFiles = (): string[] => {
  const files: string[] = [];
  for (const a of argv.slice(2)) {
    if (a.startsWith("-")) continue;
    const file = resolve(a.replace(/(:\d+)+$/, ""));
    if (/\.spec\.ts$/.test(file) && existsSync(file) && !files.includes(file)) files.push(file);
  }
  return files;
};
const ordered: string[] = process.env[ORDER] ? JSON.parse(process.env[ORDER]!) : (() => {
  const files = namedFiles();
  const byName = [...files].sort();
  return files.length > 1 && files.some((f, i) => f !== byName[i]) ? files : [];
})();
if (ordered.length) process.env[ORDER] = JSON.stringify(ordered);

export default defineConfig({
  testDir: "test/e2e",
  ...(ordered.length ? { projects: ordered.map((file, i) => ({ name: `${String(i + 1).padStart(3, "0")} ${basename(file, ".spec.ts")}`, testMatch: file })) } : {}),
  outputDir,
  timeout: 180_000,
  fullyParallel: false,
  workers: 1,
  // The list names each test as it ends; the summary after it counts what passed, failed and
  // was skipped, the skipped ones by the reason their probe gave (test/e2e/summary.ts).
  reporter: [["list"], ["./test/e2e/summary.ts"]],
  use: {
    baseURL: url,
    viewport: { width: 1920, height: 1040 },
    headless: true,
    trace: "retain-on-failure",
    // Specs drive one session at a time: the bridge shows only the helm
    // (focus mode). bridge.spec.ts clears this to drive several stations.
    storageState: { cookies: [], origins: [{ origin: new URL(url).origin, localStorage: [{ name: "keel.focus", value: "true" }] }] },
  },
});

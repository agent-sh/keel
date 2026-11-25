// Keel's own source folder: where an agent started on a bug of Keel works. A daemon run from a checkout is
// in one; a compiled binary was stamped with the folder it was built from (scripts/build.ts); the owner can
// name one in the settings (`helper.keel_repo`) for a binary built elsewhere or whose build folder is gone.
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { registerSettings, settings } from "../admin/settings.ts";
import { gitSync } from "./git.ts";

declare const __KEEL_SOURCE_DIR__: string | undefined;

// The setting is only checked for its form here: a folder that goes away later must not make every other
// settings save fail. The folder is looked at when it is used.
registerSettings("helper", { keel_repo: null }, (v) =>
  v.keel_repo === null || (typeof v.keel_repo === "string" && isAbsolute(v.keel_repo) && v.keel_repo.length < 1024) ? undefined : "keel_repo is the absolute path of a Keel source checkout, or null",
);

export type KeelRepo = { dir: string; from: "running" | "setting" | "build"; commit?: string };

// A git checkout of Keel's sources that is there now: its package, its engine and its own .git (a file in a worktree).
export function isKeelCheckout(dir: string): boolean {
  return existsSync(join(dir, ".git")) && existsSync(join(dir, "package.json")) && existsSync(join(dir, "src", "engine", "turn.ts"));
}

const commitOf = (dir: string) => {
  const r = gitSync(dir, ["rev-parse", "--short", "HEAD"], { read: true, timeout: 3000 });
  return r.code === 0 ? r.out.trim() : undefined;
};

// The folder this process runs from, when it runs from sources (not the one binary).
export function runningFrom(): string | undefined {
  const dir = resolve(dirname(import.meta.dir), "..");
  return existsSync(join(dir, "package.json")) && existsSync(join(dir, "src", "engine", "turn.ts")) ? dir : undefined;
}

export const stampedDir = (): string | undefined => (typeof __KEEL_SOURCE_DIR__ === "string" && __KEEL_SOURCE_DIR__ ? __KEEL_SOURCE_DIR__ : undefined);

// The folder to work in, and where it came from, or what is missing: the daemon's own checkout; else the owner's
// setting; else the checkout the binary was built from.
export function keelRepo(inputs: { running?: string; stamp?: string; setting?: string | null } = { running: runningFrom(), stamp: stampedDir(), setting: settings().helper?.keel_repo }): { repo: KeelRepo } | { problem: string } {
  const { running, stamp, setting } = inputs;
  if (running) return { repo: { dir: running, from: "running", commit: commitOf(running) } };
  const bad: string[] = [];
  if (setting) {
    if (isKeelCheckout(setting)) return { repo: { dir: setting, from: "setting", commit: commitOf(setting) } };
    bad.push(`the folder set as helper.keel_repo (${setting}) is not a Keel source checkout`);
  }
  if (stamp) {
    if (isKeelCheckout(stamp)) return { repo: { dir: stamp, from: "build", commit: commitOf(stamp) } };
    bad.push(`the folder this build was made from (${stamp}) is gone or is not a Keel source checkout`);
  } else bad.push("this build does not say which folder it was made from");
  return { problem: `${bad.join("; ")}. Set the folder of a Keel source checkout in Settings > Helper (helper.keel_repo).` };
}

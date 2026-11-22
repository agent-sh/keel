// Which daemon sources this process was built from: what a UI bundle is
// checked against (src/server/ui-bundle.ts) and what `keel --version` says.
// Kept apart from the bundle's code so the version line loads nothing else.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

declare const __KEEL_API__: string | undefined;

// The daemon side of the contract: every daemon source but the tests. A UI
// change that needs a daemon change cannot be installed without a restart.
export function sourceApi(root: string): string {
  const h = new Bun.CryptoHasher("sha256");
  const files = [...new Bun.Glob("src/**/*.ts").scanSync({ cwd: root })].filter((f) => !f.endsWith(".test.ts")).sort();
  for (const f of files) h.update(f + "\0").update(readFileSync(join(root, f))).update("\0");
  return h.digest("hex").slice(0, 16);
}

// What this daemon was built from: stamped in by scripts/build.ts, read from the sources when run from them.
export const daemonApi = () => (typeof __KEEL_API__ === "string" ? __KEEL_API__ : sourceApi(resolve(import.meta.dir, "../..")));

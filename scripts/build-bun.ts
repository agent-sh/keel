import manifest from "../package.json";

// bun.lock records a lockfile format, not the Bun release that wrote it.
// packageManager pins the release to use when regenerating the lockfile.
export function requireBuildBun() {
  const min = /^bun@(\d+\.\d+\.\d+)$/.exec(manifest.packageManager)?.[1];
  if (!min) throw new Error("package.json must pin a Bun release in packageManager.");
  if (!Bun.semver.satisfies(Bun.version, `>=${min}`)) {
    throw new Error(`Bun ${Bun.version} is older than Bun ${min}, the release pinned for bun.lock. Run the checks on Bun ${min} or newer.`);
  }
}

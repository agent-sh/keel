import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// A compiled binary reads the .env, bunfig.toml, tsconfig.json and package.json of the folder it starts in unless the
// build turns each off; a bunfig.toml preload there runs its code in the daemon.
test("the binary is built to read nothing from the folder it starts in", () => {
  const src = readFileSync(join(import.meta.dir, "build.ts"), "utf8");
  for (const flag of ["autoloadDotenv", "autoloadBunfig", "autoloadTsconfig", "autoloadPackageJson"]) {
    expect(src).toMatch(new RegExp(`${flag}:\\s*false`));
  }
});

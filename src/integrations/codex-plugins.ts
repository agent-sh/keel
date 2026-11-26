// Codex's plugins on disk: <codex home>/plugins/cache/<marketplace>/<plugin>/<version>, one folder a version.
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// A plugin's folder (its id is <plugin>@<marketplace>): the newest version folder, by its time. Null when none.
export function codexPluginDir(codexHome: string, id: string): string | null {
  const at = id.lastIndexOf("@");
  if (at <= 0) return null;
  const base = join(codexHome, "plugins", "cache", id.slice(at + 1), id.slice(0, at));
  try {
    const versions = readdirSync(base).map((v) => join(base, v)).filter((p) => statSync(p).isDirectory());
    versions.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    return versions[0] ?? null;
  } catch {
    return null;
  }
}

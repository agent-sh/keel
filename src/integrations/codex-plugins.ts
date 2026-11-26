// Codex's plugins on disk: <codex home>/plugins/cache/<marketplace>/<plugin>/<version>, one folder a version.
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// A plugin's folder (its id is <plugin>@<marketplace>): the newest version folder, by its time. Null when none,
// and for an id whose parts could name a folder outside the cache (a separator, a dot part).
const part = (x: string) => !!x && x !== "." && x !== ".." && !/[\\/]/.test(x);
export function codexPluginDir(codexHome: string, id: string): string | null {
  const at = id.lastIndexOf("@");
  if (at <= 0) return null;
  const [name, market] = [id.slice(0, at), id.slice(at + 1)];
  if (!part(name) || !part(market)) return null;
  const base = join(codexHome, "plugins", "cache", market, name);
  try {
    const versions = readdirSync(base).map((v) => join(base, v)).filter((p) => statSync(p).isDirectory());
    versions.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    return versions[0] ?? null;
  } catch {
    return null;
  }
}

// The folders of a PATH that commands are found in by name and that lie
// inside a session's folder: a whole path there, or a relative entry (bash
// reads it from the folder a command runs in, so any folder of the workspace
// that ends with it). An entry that is the running folder itself ("." or an
// empty one) names every folder and is not a folder to guard: left out.
import { isAbsolute, normalize } from "node:path";
import { contains, realOf } from "../core/paths.ts";

export function workspaceBins(path: string, workspace: string): string[] {
  const out = new Set<string>();
  for (const e of path.split(":")) {
    if (isAbsolute(e)) { const r = realOf(e); if (contains(workspace, r)) out.add(r); continue; }
    const rel = normalize(e).replace(/\/+$/, "");
    if (rel && rel !== "." && !rel.startsWith("..")) out.add(rel);
  }
  return [...out];
}

// The owner's configuration files that a variable can put anywhere: the
// hooks (KEEL_HOOKS), the MCP servers (KEEL_MCP_CONFIG), the ACP agents and
// their folders (KEEL_ACP_AGENTS, KEEL_ACP_FOLDERS). Keel runs what they
// name, outside any sandbox. So such a file is never read from a folder a
// session works in: a command of that session, sandboxed or not, can write
// there, and what it wrote would run as the owner's own configuration the
// next time the file is read, before anything could take it away. A file
// that lies there is not loaded, and that is said once in Errors and shown
// in Settings. (Keel's config folder itself is hidden from every sandbox and
// closed to every session's tools: only these variables can point elsewhere.)
import { contains, realOf } from "./paths.ts";
import type { Store } from "./store.ts";

export type NamedConfig = "KEEL_HOOKS" | "KEEL_MCP_CONFIG" | "KEEL_ACP_AGENTS" | "KEEL_ACP_FOLDERS";
export type Refused = { name: NamedConfig; path: string; folder: string };

// The folders sessions work in, where they are (set by the daemon; a caller with a store of its own adds its own).
let folders: () => string[] = () => [];
export const setSessionFolders = (f: () => string[]) => void (folders = f);
let said: ((r: Refused) => void) | undefined;
export const onConfigRefused = (f: typeof said) => void (said = f);
const told = new Set<string>();
const refused = new Map<NamedConfig, Refused>();

// The session's folder a variable's file lies in, when it does: the file is then not loaded. `more`: other
// sessions' folders the caller knows of.
export function configRefused(name: NamedConfig, path: string, more: string[] = []): string | undefined {
  if (process.env[name] === undefined || process.env[name] !== path) return undefined;
  const real = realOf(path);
  let folder: string | undefined;
  try { folder = [...folders(), ...more].find((ws) => contains(ws, real)); } catch {} // no list: nothing to hold it to
  if (!folder) { refused.delete(name); return undefined; }
  const r = { name, path, folder };
  refused.set(name, r);
  const key = `${name}\0${real}\0${folder}`;
  if (!told.has(key)) { told.add(key); try { said?.(r); } catch {} }
  return folder;
}
// What is not loaded now, for Settings.
export const refusedConfigs = (): Refused[] => [...refused.values()];
export const refusedSentence = (r: Refused) => `${r.name} points inside a session's folder (${r.path} is in ${r.folder}): it is not loaded. Keep it outside the folders sessions work in.`;

// The folders of a store's sessions, where they are: read at most every two seconds. (An archived session runs
// nothing; when it is taken out of the archive its folder counts again.)
const kept = new WeakMap<object, { at: number; list: string[] }>();
export function sessionFoldersOf(store: Store): string[] {
  const have = kept.get(store);
  if (have && Date.now() - have.at < 2_000) return have.list;
  let list: string[] = [];
  try { list = [...new Set(store.db.query<{ workspace: string }, []>("SELECT DISTINCT workspace FROM sessions WHERE archived = 0 AND outside IS NULL").all().map((r) => realOf(r.workspace)))]; } catch {} // no table yet
  kept.set(store, { at: Date.now(), list });
  return list;
}

// The commands the owner's store can stop. Its pre-tool hook answers a shell command with a deny when a
// fact the owner wrote forbids it (once a session); tacit keeps the keys of those facts in a small file of
// its state folder, built from its index. A call whose command starts with one of the keys' words is the
// only kind that waits for the hook (tacit.ts); any other call is asked beside its tool as before.
import { statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ownerHome } from "../core/paths.ts";

// Where the store keeps it: its state folder. TACIT_STATE_DIR is a stand-in variable like TACIT_BIN, always
// honoured; else the owner's own (~/.local/state/tacit), which a scratch daemon that may not read the home
// finds empty, so it reads no keys.
export const denyKeysFile = () => join(process.env.TACIT_STATE_DIR || join(ownerHome(), ".local", "state", "tacit"), "deny-keys.json");

// A key's leading words, up to its first option: `gh pr merge`, `git fetch --all` -> `git fetch`, `rm -rf` -> `rm`.
// (The store's own match reads the key's options anywhere in the command; waiting for every command that
// starts with the words is the superset, and cheap for a command the hook answers in about 20 ms.)
export function denyPrefixes(file: unknown): string[] {
  const out = new Set<string>();
  const facts = (file as { facts?: unknown })?.facts;
  if (!Array.isArray(facts)) return [];
  for (const f of facts) {
    const key = (f as { key?: unknown })?.key;
    if (!Array.isArray(key)) continue;
    const words: string[] = [];
    for (const w of key) { if (typeof w !== "string" || w.startsWith("-")) break; words.push(w.toLowerCase()); }
    if (words.length) out.add(words.join(" "));
  }
  return [...out];
}

// The command each fact forbids, as the file keys it: the fact's name to its keys' words, options too
// (`git fetch --all`). A rule is broken by a command that starts with the key's leading words and holds its options.
export function denyBans(file: unknown): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const facts = (file as { facts?: unknown })?.facts;
  if (!Array.isArray(facts)) return out;
  for (const f of facts) {
    const { key, name } = (f ?? {}) as { key?: unknown; name?: unknown };
    if (typeof name !== "string" || !Array.isArray(key) || !key.length || key.some((w) => typeof w !== "string")) continue;
    out.set(name, [...(out.get(name) ?? []), (key as string[]).map((w) => w.toLowerCase()).join(" ")]);
  }
  return out;
}

// Whether a command line's topics (callTopics) start with a key's words, word for word.
export const stoppable = (topics: string[], prefixes: readonly string[]): boolean =>
  topics.some((t) => prefixes.some((p) => t === p || t.startsWith(`${p} `)));

// The keys, read again when the file changed, looked at most every `every` ms.
export class DenyKeys {
  private prefixes: string[] = [];
  private bans = new Map<string, string[]>();
  private stamp = "";
  private looked = 0;
  constructor(private every = 10_000, private file = denyKeysFile) {}
  get(): readonly string[] {
    const now = Date.now();
    if (now - this.looked < this.every) return this.prefixes;
    this.looked = now;
    try {
      const path = this.file();
      const st = statSync(path);
      const stamp = `${st.mtimeMs}:${st.size}`;
      if (stamp !== this.stamp) { const file = JSON.parse(readFileSync(path, "utf8")); this.prefixes = denyPrefixes(file); this.bans = denyBans(file); this.stamp = stamp; }
    } catch {
      this.prefixes = []; this.bans = new Map(); this.stamp = ""; // no file, or one that is not read: no call waits
    }
    return this.prefixes;
  }
  // What the store forbids by a fact's name: the commands of its keys, none for a fact that is not keyed.
  bansOf(name: string): string[] {
    this.get();
    return this.bans.get(name) ?? [];
  }
}

// The owner's own private words: host names and project names that never go to a public place (private-words.ts).
// Keel learns the rest (his machines, ssh hosts, folders, home, the vault's values); these are what it cannot.
import { registerSettings } from "../admin/settings.ts";

export function registerPrivateSettings() {
  registerSettings("private", { terms: [] as string[] }, (v) => {
    const list = v.terms;
    if (!Array.isArray(list) || list.length > 500) return "terms is a list of at most 500 words";
    for (const t of list) if (typeof t !== "string" || !t.trim() || /\s/.test(t.trim()) || t.length > 200) return `${JSON.stringify(t)} is not one word: write each host name or project name alone`;
    return undefined;
  });
}

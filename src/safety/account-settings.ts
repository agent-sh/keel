// The owner's namespaces: the accounts a write may go to without asking him (accounts.ts). Seeded empty. They are learned
// from his own config (account-learn.ts), shown for him to confirm, and kept here.
import { settings, registerSettings, patchSettings } from "../admin/settings.ts";
import { parseNamespace, parseNamespaces, type Namespace } from "./accounts.ts";

registerSettings("accounts", { namespaces: [] as string[] }, (v) => {
  const list = v.namespaces;
  if (!Array.isArray(list) || list.length > 500) return "namespaces is a list of at most 500 entries";
  for (const e of list) if (typeof e !== "string" || !parseNamespace(e)) return `${JSON.stringify(e)} names no namespace: write HOST/OWNER (a bare OWNER is on github.com), or npm:@scope, pypi:name, crates:name`;
  return undefined;
});

// The parsed list, read where it is used (the owner changes it while sessions run).
export const accountNames = (): Namespace[] => parseNamespaces((settings().accounts?.namespaces as string[] | undefined) ?? []);

// One namespace more (what "Mine" on a card adds), the others as they are. False when the entry names nothing.
export function addNamespace(entry: string): { ok: true; added: boolean } | { ok: false; error: string } {
  const n = parseNamespace(entry);
  if (!n) return { ok: false, error: `${JSON.stringify(entry)} names no namespace` };
  const have = (settings().accounts?.namespaces as string[] | undefined) ?? [];
  if (parseNamespaces(have).some((x) => JSON.stringify(x) === JSON.stringify(n))) return { ok: true, added: false };
  const r = patchSettings({ accounts: { namespaces: [...have, entry.trim()] } });
  return r.ok ? { ok: true, added: true } : { ok: false, error: r.error };
}

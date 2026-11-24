// The owner's namespaces: the accounts a write may go to without asking him (accounts.ts). Seeded empty. They are learned
// from his own config (account-learn.ts), shown for him to confirm, and kept here.
import { settings, registerSettings } from "../admin/settings.ts";
import { parseNamespace, parseNamespaces, type Namespace } from "./accounts.ts";

registerSettings("accounts", { namespaces: [] as string[] }, (v) => {
  const list = v.namespaces;
  if (!Array.isArray(list) || list.length > 500) return "namespaces is a list of at most 500 entries";
  for (const e of list) if (typeof e !== "string" || !parseNamespace(e)) return `${JSON.stringify(e)} names no namespace: write HOST/OWNER (a bare OWNER is on github.com), or npm:@scope, pypi:name, crates:name`;
  return undefined;
});

// The parsed list, read where it is used (the owner changes it while sessions run).
export const accountNames = (): Namespace[] => parseNamespaces((settings().accounts?.namespaces as string[] | undefined) ?? []);

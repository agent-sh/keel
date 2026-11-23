// The values the owner gave a plugin's settings (src/plugins/options.ts).
// A plain value is kept in the plugin's record (plugins.json, written whole
// through core/ownfile.ts). A sensitive one goes to the system keyring under
// Keel's service, as a provider key does, and is never written anywhere else
// or shown back; it is held in this process once read, and the secrets vault
// knows it, so a value a server or a hook prints back is kept out of what
// Keel stores and sends.
import { deleteKey, keyringService, saveKey } from "../providers/creds.ts";
import { vault } from "../safety/secrets.ts";
import { optionEnv, resolve, type OptionValue, type Specs } from "./options.ts";
import { unitOf, type Unit } from "./registry.ts";

const held = new Map<string, Map<string, string>>();
// The sensitive keys whose keyring entry did not answer when read.
const lost = new Map<string, Set<string>>();

export const secretName = (id: string, key: string) => `plugin-${id}-${key}`;

const know = (id: string, key: string, value: string) => {
  let m = held.get(id);
  if (!m) held.set(id, (m = new Map()));
  m.set(key, value);
  lost.get(id)?.delete(key);
  vault.add(value, `a setting of the plugin ${id}`, "card", null);
};

// Reads the sensitive values the record says were given and are not held yet.
export async function loadSecrets(u: Unit): Promise<void> {
  for (const k of u.secrets ?? []) {
    if (held.get(u.id)?.has(k) || !u.options?.[k]?.sensitive) continue;
    let v: string | null = null;
    try { v = (await Bun.secrets.get({ service: keyringService(), name: secretName(u.id, k) })) || null; } catch { v = null; }
    if (v) know(u.id, k, v);
    else { let s = lost.get(u.id); if (!s) lost.set(u.id, (s = new Set())); s.add(k); }
  }
}

export async function putSecret(id: string, key: string, value: string): Promise<void> {
  await saveKey(secretName(id, key), value);
  know(id, key, value);
}

export async function dropSecret(id: string, key: string): Promise<void> {
  held.get(id)?.delete(key);
  lost.get(id)?.delete(key);
  await deleteKey(secretName(id, key));
}

export function forgetPlugin(id: string) {
  held.delete(id);
  lost.delete(id);
}

// The values in force for a plugin: the owner's (plain from its record,
// sensitive as read from the keyring), else the defaults. `missing`: the
// required ones it has no value for, each with why.
export function valuesOf(u: Pick<Unit, "id" | "options" | "values" | "secrets">): { specs: Specs; text: Record<string, string>; missing: { key: string; title: string; why: string }[] } {
  const specs = u.options ?? {};
  const given: Record<string, OptionValue | undefined> = {};
  for (const [k, s] of Object.entries(specs)) given[k] = s.sensitive ? held.get(u.id)?.get(k) : u.values?.[k];
  const r = resolve(specs, given);
  return {
    specs, text: r.text,
    missing: r.missing.map((k) => ({ key: k, title: specs[k]!.title, why: lost.get(u.id)?.has(k) ? "the keyring did not give its value" : "no value yet" })),
  };
}

// What a plugin's hooks are given now: the values as text for their args, and the environment.
export function hookOptions(id: string): { text: Record<string, string>; env: Record<string, string> } {
  const u = unitOf(id);
  if (!u?.options) return { text: {}, env: {} };
  const { text } = valuesOf(u);
  return { text, env: optionEnv(text) };
}

// Whether a plugin still waits for a required value (its hooks do not run, its servers do not start).
export const waiting = (u: Unit) => !!u.options && valuesOf(u).missing.length > 0;

// The owner's daemon settings, one JSON file in the state folder, changed by a
// JSON merge patch (RFC 7396: keys merge, null removes one). Each section is
// registered by the module that reads it, with its defaults and a check; a
// patch that leaves any section invalid is refused and nothing is stored.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Section = { defaults: Record<string, unknown>; check: (v: any) => string | undefined };
const sections = new Map<string, Section>();
const listeners = new Set<(s: Record<string, any>) => void>();
let file = "";
let current: Record<string, any> = {};

export function registerSettings(name: string, defaults: Record<string, unknown>, check: (v: any) => string | undefined) {
  sections.set(name, { defaults, check });
}

export function loadSettings(stateDir: string, onError: (e: unknown) => void) {
  file = join(stateDir, "settings.json");
  try {
    current = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  } catch (e) {
    onError(Object.assign(new Error(`settings.json cannot be read: ${(e as Error).message}; the defaults are used`), { cause: e }));
    current = {};
  }
}

// Every section with its defaults filled in.
export function settings(): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [name, s] of sections) out[name] = { ...s.defaults, ...(current[name] ?? {}) };
  return out;
}

export const onSettings = (f: (s: Record<string, any>) => void) => (listeners.add(f), () => void listeners.delete(f));

function merge(target: any, patch: any): any {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const out = target && typeof target === "object" && !Array.isArray(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = merge(out[k], v);
  }
  return out;
}

export function patchSettings(patch: unknown): { ok: true; settings: Record<string, any> } | { ok: false; error: string } {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return { ok: false, error: "the body must be a JSON object" };
  for (const k of Object.keys(patch)) if (!sections.has(k)) return { ok: false, error: `unknown settings section ${k}` };
  const next = merge(current, patch);
  for (const [name, s] of sections) {
    const v = { ...s.defaults, ...(next[name] ?? {}) };
    for (const k of Object.keys(next[name] ?? {})) if (!(k in s.defaults)) return { ok: false, error: `unknown setting ${name}.${k}` };
    const why = s.check(v);
    if (why) return { ok: false, error: `${name}: ${why}` };
  }
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file); // atomic: a crash leaves the old file or the new one
  current = next;
  const all = settings();
  for (const f of listeners) f(all);
  return { ok: true, settings: all };
}

// A whole number of days, or null for never.
export const daysOrNull = (v: unknown) => v === null || (Number.isInteger(v) && (v as number) >= 1);

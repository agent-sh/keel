// What each Settings section holds, read from the source when the page is bundled
// (a Bun macro: `import { settingsFind } from "./settings-find.macro.ts" with { type: "macro" }`).
// For every section registered with `settingsSections.add`, the module it shows
// is found (a lazy import's path, or the function of that name in the file that
// registers it), and from that module come the names of its rows and headings:
// a `SettingRow`'s label and the plain words of a heading or a label (.k-label). Find a setting
// matches them, so a word inside a section finds the section and the row.
import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const root = join(import.meta.dir, "..");

function sources(): string[] {
  const out: string[] = [];
  for (const f of new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: root })) if (!/\.(test|macro)\.tsx?$/.test(f)) out.push(f);
  return out.sort();
}

// The names a module shows: row labels and headings, each once, in their order.
export function namesIn(text: string): string[] {
  const out: string[] = [];
  const add = (s: string) => { const t = s.replace(/\s+/g, " ").trim(); if (t.length > 1 && !out.includes(t)) out.push(t); };
  for (const m of text.matchAll(/<SettingRow\b[^>]*?\blabel=(?:"([^"]+)"|\{"([^"]+)"\})/g)) add(m[1] ?? m[2]!);
  for (const m of text.matchAll(/<h[234]\b[^>]*>([^<{}]+)<\/h[234]>/g)) add(m[1]!);
  for (const m of text.matchAll(/className="[^"]*\bk-label\b[^"]*"[^>]*>([^<{}]+)</g)) add(m[1]!);
  return out;
}

// The sections a module registers, each with the module its component comes from.
export function sectionsIn(text: string): { id: string; from: string | null; name: string | null }[] {
  const out: { id: string; from: string | null; name: string | null }[] = [];
  for (const call of text.split("settingsSections.add(").slice(1)) {
    const body = call.split(/\n\);|\n}\);/)[0]!;
    const parts = body.split(/(?=\bid: ")/).slice(1);
    for (const p of parts) {
      const id = p.match(/^id: "([^"]+)"/)![1]!;
      const lazy = p.match(/component:\s*lazy\(\(\) => import\("([^"]+)"\)/);
      const named = p.match(/component:\s*([A-Z]\w*)/);
      out.push({ id, from: lazy?.[1] ?? null, name: lazy ? null : named?.[1] ?? null });
    }
  }
  return out;
}

export function settingsFind(): Record<string, string[]> {
  const read = (f: string) => readFileSync(join(root, f), "utf8");
  const out: Record<string, string[]> = {};
  for (const f of sources()) {
    const text = read(f);
    if (!text.includes("settingsSections.add(")) continue;
    for (const s of sectionsIn(text)) {
      let target = f;
      if (s.from) target = relative(root, join(dirname(join(root, f)), s.from));
      else if (s.name && !new RegExp(`function ${s.name}\\b`).test(text)) {
        const imp = text.match(new RegExp(`import \\{[^}]*\\b${s.name}\\b[^}]*\\} from "([^"]+)"`));
        if (imp) target = relative(root, join(dirname(join(root, f)), imp[1]!));
      }
      let names: string[] = [];
      try { names = namesIn(read(target)); } catch { names = []; }
      // A function named in the registering file: only its own part of the file.
      if (!s.from && s.name && target === f) {
        const at = text.search(new RegExp(`function ${s.name}\\b`));
        const next = text.slice(at + 1).search(/\n(export )?function /);
        names = namesIn(text.slice(at, next < 0 ? undefined : at + 1 + next));
      }
      out[s.id] = names;
    }
  }
  return out;
}

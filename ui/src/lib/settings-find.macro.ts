// What each Settings section holds, read from the source when the page is bundled
// (a Bun macro: `import { settingsFind } from "./settings-find.macro.ts" with { type: "macro" }`).
// For every section registered with `settingsSections.add`, the module it shows
// is found (a lazy import's path, or the function of that name in the file that
// registers it), and from that module come the names of its rows and headings:
// a row's, a panel's or a section's label or title, and the plain words of a heading or a
// label (.k-label), in the module and in the components it draws. Find a setting
// matches them, so a word inside a section finds the section and the row.
import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const root = join(import.meta.dir, "..");

function sources(): string[] {
  const out: string[] = [];
  for (const f of new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: root })) if (!/\.(test|macro)\.tsx?$/.test(f)) out.push(f);
  return out.sort();
}

// Components whose label or title is a row's or a block's name on the page.
const NAMED = new Set(["SettingRow", "Group", "Panel", "Section", "Line", "Row", "Block", "Stat", "ReaderHead"]);

// The plain words of an attribute's value: a string, or the strings and the fixed
// parts of a template inside braces (label={on ? "Pause" : "Resume"}, label={`Advisor of "${t}"`}).
function literals(value: string): string[] {
  if (value.startsWith('"')) return [value.slice(1, -1)];
  const out: string[] = [];
  for (const m of value.matchAll(/"([^"{}]{2,})"|`([^`]*)`/g)) {
    if (m[1]) out.push(m[1]);
    else for (const part of m[2]!.split(/\$\{[^}]*\}/)) if (part.replace(/["\s]/g, "").length > 2) out.push(part.replace(/^[\s"]+|[\s"]+$/g, ""));
  }
  return out;
}

// The names a module shows: the label or title of a row, a panel or a section (and of a
// component the module defines, which passes it on), and the plain words of a heading or a
// label (.k-label), each once, in their order.
export function namesIn(text: string): string[] {
  const out: string[] = [];
  const add = (s: string) => { const t = s.replace(/\s+/g, " ").trim().replace(/^[:,.;\s]+|[:,.;\s]+$/g, ""); if (t.length > 1 && !out.includes(t)) out.push(t); };
  const local = new Set([...text.matchAll(/\bfunction ([A-Z]\w*)\s*\(/g)].map((m) => m[1]!));
  for (const m of text.matchAll(/<([A-Z]\w*)\b((?:[^<>]|=>)*?)\/?>/g)) {
    if (!NAMED.has(m[1]!) && !local.has(m[1]!)) continue;
    for (const a of m[2]!.matchAll(/(?<![-\w])(label|title)=("[^"]*"|\{(?:[^{}]|\{[^{}]*\})*\})/g)) for (const l of literals(a[2]!.startsWith("{") ? a[2]!.slice(1, -1) : a[2]!)) add(l);
  }
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

// A module and the components it draws from (its own imports of the page's components, two
// steps deep), without Settings itself, another section's module, or a module that registers sections.
function drawn(file: string, read: (f: string) => string, others: Set<string>): string[] {
  const seen = new Set<string>();
  const walk = (f: string, depth: number) => {
    if (seen.has(f)) return;
    let text: string;
    try { text = read(f); } catch { return; }
    if (seen.size && (f.endsWith("components/Settings.tsx") || others.has(f) || text.includes("settingsSections.add("))) return;
    seen.add(f);
    if (!depth) return;
    for (const m of text.matchAll(/import\s+(?!type\b)[^;]*?\sfrom\s+"(\.{1,2}\/[^"]+\.tsx)"/g)) walk(relative(root, join(dirname(join(root, f)), m[1]!)), depth - 1);
  };
  walk(file, 2);
  return [...seen];
}

export function settingsFind(): Record<string, string[]> {
  const read = (f: string) => readFileSync(join(root, f), "utf8");
  const out: Record<string, string[]> = {};
  const registering = sources().filter((f) => read(f).includes("settingsSections.add("));
  const targets = new Set(registering.flatMap((f) => sectionsIn(read(f)).filter((s) => s.from).map((s) => relative(root, join(dirname(join(root, f)), s.from!)))));
  for (const f of registering) {
    const text = read(f);
    for (const s of sectionsIn(text)) {
      let target = f;
      if (s.from) target = relative(root, join(dirname(join(root, f)), s.from));
      else if (s.name && !new RegExp(`function ${s.name}\\b`).test(text)) {
        const imp = text.match(new RegExp(`import \\{[^}]*\\b${s.name}\\b[^}]*\\} from "([^"]+)"`));
        if (imp) target = relative(root, join(dirname(join(root, f)), imp[1]!));
      }
      let names: string[] = [];
      if (!s.from && s.name && target === f) {
        // A function named in the registering file: only its own part of the file.
        const at = text.search(new RegExp(`function ${s.name}\\b`));
        const next = text.slice(at + 1).search(/\n(export )?function /);
        names = namesIn(text.slice(at, next < 0 ? undefined : at + 1 + next));
      } else for (const m of drawn(target, read, targets)) for (const n of namesIn(read(m))) if (!names.includes(n)) names.push(n);
      out[s.id] = names;
    }
  }
  // A name many sections draw is the chrome they share (where a file is seen from, Close), not a row of one.
  const count = new Map<string, number>();
  for (const names of Object.values(out)) for (const n of names) count.set(n, (count.get(n) ?? 0) + 1);
  // A field's own label that only lengthens its row's ("Keep usage records for days") is that row, and
  // a fragment of a sentence that begins another name ("spend limit") is that name.
  for (const id of Object.keys(out)) out[id] = out[id]!.filter((n, _, all) => count.get(n)! < 4 && !all.some((m) => m !== n && (n.startsWith(`${m} `) || (/^[a-z]/.test(n) && m.toLowerCase().startsWith(n.toLowerCase())))));
  return out;
}

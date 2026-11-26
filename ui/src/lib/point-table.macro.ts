// Where each test id and each class of the page comes from, read from the source when the page is
// bundled (a Bun macro: `import { pointTableText } from "./point-table.macro.ts" with { type: "macro" }`).
// Point (lib/point.ts) names an element by the test id the page already carries, and looks its file,
// line and component up here: the page gets no attribute of its own for it, and a release, whose
// bundle has no names and no source map, answers as the dev page does. The table is in Point's own
// chunk, fetched at the first use.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

// A file's lines: the components it defines (a name at the start of a line) and the test ids it
// writes, each with its line. A test id made of parts (`row-${id}`) is kept with a * for each part.
export type PointFile = { c: [number, string][]; t: [string, number][] };
// The files by their path under ui/src, and the classes of the stylesheets: the file and line of a
// class's first rule.
export type PointTable = { files: Record<string, PointFile>; css: Record<string, [string, number]> };

const COMPONENT = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s+([A-Z]\w*)|const\s+([A-Z]\w*)\s*(?::[^=]+)?=)/;
// An id is written as an attribute (data-testid, or a component's own testid prop) or as a field of an
// object that is spread into one.
const ID = /(?<![\[\w-])(?:data-testid|testid|testId)\s*[=:]\s*("[^"\n]+"|\{[^\n]*?\}(?=[\s/>,)])|`[^`\n]+`)/g;

export function idsIn(value: string): string[] {
  if (value.startsWith('"')) return [value.slice(1, -1)];
  const out: string[] = [];
  for (const m of value.matchAll(/"([\w:.-]+)"|`([^`]+)`/g)) out.push(m[1] ?? m[2]!.replace(/\$\{[^}]*\}/g, "*"));
  return out.filter((s) => /[a-z]/i.test(s));
}

export function fileOf(text: string): PointFile {
  const c: [number, string][] = [], t: [string, number][] = [];
  text.split("\n").forEach((line, i) => {
    const m = COMPONENT.exec(line);
    // (A name in capitals alone is a constant, not a component.)
    if (m && /[a-z]/.test((m[1] ?? m[2])!)) c.push([i + 1, (m[1] ?? m[2])!]);
    if (!line.includes("estid") && !line.includes("estId")) return;
    for (const hit of line.matchAll(ID)) for (const id of idsIn(hit[1]!)) if (!t.some((x) => x[0] === id && x[1] === i + 1)) t.push([id, i + 1]);
  });
  return { c, t };
}

export function classesOf(text: string, file: string, into: Record<string, [string, number]>) {
  text.split("\n").forEach((line, i) => {
    // (A rule's selector, not a value: the part before the first brace.)
    const head = line.split("{")[0]!;
    for (const m of head.matchAll(/\.(k-[\w-]+)/g)) into[m[1]!] ??= [file, i + 1];
  });
}

// The table as text: the page reads it once. (A value the bundler puts in the bundle is written again at each
// place that uses it; a text is written once.)
export function pointTableText(): string {
  return JSON.stringify(pointTable());
}

export function pointTable(): PointTable {
  const files: Record<string, PointFile> = {}, css: Record<string, [string, number]> = {};
  const names = [...new Bun.Glob("**/*.{ts,tsx,css}").scanSync({ cwd: root })].filter((f) => !/\.(test|macro)\.tsx?$/.test(f)).sort();
  for (const f of names) {
    const text = readFileSync(join(root, f), "utf8");
    if (f.endsWith(".css")) { classesOf(text, f, css); continue; }
    const got = fileOf(text);
    if (got.t.length) files[f] = got;
  }
  return { files, css };
}

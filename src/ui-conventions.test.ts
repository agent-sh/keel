// The look is one system: what the stylesheets and components may write is
// checked over the UI source, so a second scale or a fifth face cannot come back.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const UI = join(import.meta.dir, "../ui/src");
function files(dir: string, ext: RegExp): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p, ext) : ext.test(n) && !/\.test\.tsx?$/.test(n) ? [p] : [];
  });
}
const sheets = files(UI, /\.css$/);
const components = files(UI, /\.tsx?$/);
// Every match of `bad` in the files, as "file:line: text".
function found(list: string[], bad: RegExp, ok: (hit: string, file: string) => boolean = () => false): string[] {
  const out: string[] = [];
  for (const f of list) {
    readFileSync(f, "utf8").split("\n").forEach((line, i) => {
      for (const m of line.matchAll(new RegExp(bad.source, "g"))) if (!ok(m[0], relative(UI, f))) out.push(`${relative(UI, f)}:${i + 1}: ${m[0]}`);
    });
  }
  return out;
}

test("the type scale has eight sizes, written once", () => {
  const css = readFileSync(join(UI, "styles.css"), "utf8");
  const sizes = [...css.matchAll(/^\s*--text-([a-z]+): ([\d.]+rem);/gm)].map((m) => m[1]);
  expect(sizes).toEqual(["micro", "caption", "ui", "base", "read", "head", "title", "display"]);
});

test("no stylesheet writes a text size of its own", () => {
  // A size is a token, the parent's, or nothing. Three are set for a reason of
  // their own: the root (the owner's text size), inputs on a phone (iOS zooms
  // under 16 px) and the math faces (set by eye beside the text face).
  const allowed = /^font-size: (var\(--text-[a-z]+\)|inherit|0|calc\(17px \* var\(--ui-scale, 1\)\)|max\(16px, 1rem\) !important|1\.08em);$/;
  expect(found(sheets, /font-size: [^;]+;/, (hit) => allowed.test(hit))).toEqual([]);
  // The shorthand names its size too.
  expect(found(sheets, /\bfont: [^;]+;/, (hit) => /^font: (normal )?([1-9]00 )?var\(--text-[a-z]+\)(\/[\d.a-z]+)? var\(--font-(sans|mono)\);$/.test(hit))).toEqual([]);
});

test("no component writes a text size of its own", () => {
  // Tailwind's own sizes (text-sm, text-lg) and arbitrary ones (text-[0.9rem]) are not the scale.
  expect(found(components, /\btext-\[[\d.]+(rem|px|em)\]|\btext-(xs|sm|lg|xl|[2-9]xl)\b/)).toEqual([]);
  // An inline size: only the text-size setting's samples, which show each size.
  expect(found(components, /fontSize: /, (_, file) => file === "components/Settings.tsx")).toEqual([]);
});

test("the instrument face is named by its five roles and nowhere else", () => {
  const css = readFileSync(join(UI, "styles.css"), "utf8");
  const start = css.indexOf("/* The instrument face (Martian Mono, narrow) has five jobs");
  const end = css.indexOf("html, body, #root");
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const roles = css.slice(start, end);
  expect(roles.match(/font-family: var\(--font-inst\)/g)).toHaveLength(5);
  // Outside the roles the face is only defined (the theme token).
  const rest = css.slice(0, start) + css.slice(end);
  expect(rest.match(/var\(--font-inst\)/g) ?? []).toEqual([]);
  expect(found(sheets.filter((f) => !f.endsWith("/styles.css")), /font-inst|Martian/)).toEqual([]);
  // A component joins a role by its class (k-face-state, k-face-figure, k-face-title), never by the face.
  // (lib/fonts.ts loads the face.)
  expect(found(components.filter((f) => !f.endsWith("lib/fonts.ts")), /\bfont-inst\b|--font-inst|Martian/)).toEqual([]);
});

test("a choice of a few is the one segmented control", () => {
  // Tabs, a segmented choice and a filter share one track (k-seg in styles.css); no surface draws its own.
  expect(found(components, /^.*(role="tablist"|<Tabs\.List|<Choices ).*$/, (line) => /\bk-seg\b/.test(line))).toEqual([]);
  expect(found(sheets, /^\.k-seg \{|^\.k-tabs\b[^{]*\{/m)).toEqual(["styles.css:" + (readFileSync(join(UI, "styles.css"), "utf8").split("\n").findIndex((l) => l.startsWith(".k-seg {")) + 1) + ": .k-seg {"]);
  // An option's look comes from the track: no component raises the chosen one by hand.
  expect(found(components, /\? "bg-raised text-fg shadow-[12]"|data-\[active\]:bg-raised|data-checked:bg-raised/)).toEqual([]);
});

test("steel is the frame and nothing else", () => {
  // The panel color is the rail and the phone dock. A chip or an inner pane is a
  // well (bg-sunken); a list inside a page stands on the page.
  expect(found(components, /\bbg-panel\b/)).toEqual([]);
  expect(found(sheets, /^.*var\(--panel\).*$/, (line) => /^\s*(\.k-rail |\.k-where-pip|--color-panel:|background: var\(--panel\); border-top)/.test(line))).toEqual([]);
});

test("nothing to show is said one way", () => {
  // The empty line is k-empty (styles.css): no surface centers quiet text of its own in a box,
  // and no other stylesheet rule draws an empty state.
  expect(found(components, /className="[^"]*\btext-center text-(ui|caption) text-(faint|muted)\b[^"]*"/, (_, file) => file === "components/Transcript.tsx")).toEqual([]);
  // (A chart says it inside its plot.)
  expect(found(components, /<(p|div|li) className="(?![^"]*\bk-empty\b)[^"]*"[^>]*>(No|Nothing) [a-z]/, (_, file) => file === "components/Chart.tsx")).toEqual([]);
  expect(found(sheets, /^\.k-(blank|picker-empty|ledger-empty)\b/)).toEqual([]);
});

test("every time is on the 24-hour clock", () => {
  // The page formats a time through when() and clock() in lib/utils.ts and nowhere else.
  const page = components.filter((f) => !f.endsWith("lib/utils.ts"));
  expect(found(page, /toLocaleTimeString\(|toLocaleString\([^)]*\bhour\b|Date\([^()]*\)\.toLocaleString\(\)/)).toEqual([]);
  // The daemon's own words (a waiting tool, a snooze, a retry) name the clock when they format one.
  const daemon = files(join(import.meta.dir), /\.ts$/);
  const lines = daemon.flatMap((f) => readFileSync(f, "utf8").split("\n").map((l, i) => ({ l, at: `${relative(import.meta.dir, f)}:${i + 1}` })));
  expect(lines.filter(({ l }) => /toLocaleTimeString\(|toLocaleString\([^)]*\bhour\b/.test(l) && !/hourCycle: "h23"/.test(l)).map((x) => x.at)).toEqual([]);
});

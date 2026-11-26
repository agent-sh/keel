// What a repository names for pictures of its page (`.keel/pictures.json` in the tree being pictured):
// the folders the page is made of, its specs, the command that takes pictures with some of them, the
// sizes and themes to take them at. Pure: read from the file's text, with the problems it has.
//
//   {
//     "run": "scripts/pictures.sh",          the command; Keel adds the spec files as arguments
//     "pages": ["ui/"],                       folders whose files make the page
//     "specs": ["test/e2e/*.spec.ts"],        the specs that drive it (globs)
//     "sizes": ["1920x1040", "390x844", "owner"],  each picture at each size; "owner": also as the owner's
//                                             page is drawn now (src/core/look.ts): its size, view, text scale and theme
//     "themes": ["light", "dark"],            and in each theme
//     "global": ["test/e2e/chat.spec.ts"],    run when a change reaches every page (a stylesheet, the entry)
//     "harness": ["test/e2e/*.ts"],           files taken from the head on both sides (the specs, their helpers)
//     "max_specs": 4,                         the most specs one run takes (the rest are named, not run)
//     "timeout_s": 900                        one side's run at most
//   }
//
// Both sides run with the head's harness: the chosen specs, the command's own script and the files `harness`
// names are the head's on the base's checkout too, so the same steps drive the page before and after.
// The command runs in a checkout of the commit, with KEEL_PICTURES_OUT (a folder: it writes PNG files
// there, any names, the same name on both sides for the same picture), KEEL_SHOT_SIZES ("1920x1040,390x844")
// and KEEL_SHOT_THEMES ("light,dark") set, and with "owner" in the sizes KEEL_LOOK (the owner's look as JSON,
// the same on both sides: test/e2e/shots.ts takes each picture once more at it).
export const FILE = ".keel/pictures.json";

export type Size = { w: number; h: number };
export type PicturesConfig = {
  run: string;
  pages: string[];
  specs: string[];
  sizes: Size[];
  owner: boolean;           // "owner" is one of the sizes
  themes: string[];
  global: string[];
  harness: string[];
  max_specs: number | null;
  timeout_s: number;
};

// One side's run at most when the file names none: a cold run of a few browser specs, with the daemon's start.
export const TIMEOUT_S = 900;

const SIZE = /^(\d{2,5})x(\d{2,5})$/;
const words = (v: unknown, name: string, problems: string[]): string[] | undefined => {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string" && x.trim())) { problems.push(`${name} is a list of words`); return undefined; }
  return v.map((x: string) => x.trim());
};

export function readPictures(text: string): { config?: PicturesConfig; problems: string[] } {
  const problems: string[] = [];
  let v: any;
  try { v = JSON.parse(text); } catch (e) { return { problems: [`it is not JSON: ${(e as Error).message}`] }; }
  if (!v || typeof v !== "object" || Array.isArray(v)) return { problems: ["it is not an object"] };
  if (typeof v.run !== "string" || !v.run.trim()) problems.push("run names the command that takes the pictures");
  const pages = words(v.pages, "pages", problems) ?? [];
  if (!pages.length) problems.push("pages names the folders the page is made of");
  const specs = words(v.specs, "specs", problems) ?? [];
  if (!specs.length) problems.push("specs names the spec files (globs)");
  const sizes: Size[] = [];
  let owner = false;
  for (const s of words(v.sizes, "sizes", problems) ?? []) {
    if (s === "owner") { owner = true; continue; }
    const m = SIZE.exec(s);
    if (!m) { problems.push(`sizes: ${s} is not WIDTHxHEIGHT or owner`); continue; }
    sizes.push({ w: Number(m[1]), h: Number(m[2]) });
  }
  const themes = words(v.themes, "themes", problems) ?? [];
  const global = words(v.global, "global", problems) ?? [];
  const harness = words(v.harness, "harness", problems) ?? [];
  const max = v.max_specs;
  if (max !== undefined && !(Number.isInteger(max) && max >= 1)) problems.push("max_specs is a whole number, at least 1");
  const t = v.timeout_s;
  if (t !== undefined && !(Number.isInteger(t) && t >= 10)) problems.push("timeout_s is a whole number of seconds, at least 10");
  if (problems.length) return { problems };
  return {
    problems,
    config: {
      run: v.run.trim(),
      pages: pages.map((p) => p.replace(/^\.\//, "").replace(/\/?$/, "/")),
      specs, sizes, owner, themes, global, harness,
      max_specs: max ?? null,
      timeout_s: t ?? TIMEOUT_S,
    },
  };
}

export const sizeWord = (s: Size) => `${s.w}x${s.h}`;

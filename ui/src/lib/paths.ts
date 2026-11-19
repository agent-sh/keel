// A file a reply names in inline code (`src/core/store.ts:42`), with its line.
// Only a candidate: the page asks the daemon which ones exist before it links.
// Line forms: :N, :N:C, :N-M and #LN, #LN-LM (as editors and GitHub write them).
const NAMES = new Set(["Makefile", "Dockerfile", "Justfile", "Rakefile", "Gemfile", "Procfile", "LICENSE", "README", "CHANGELOG", "AGENTS.md"]);

export function pathRef(code: string): { path: string; line?: number; end?: number } | null {
  let s = code.trim();
  if (!s || s.length > 300 || /\s/.test(s)) return null;
  s = s.replace(/^file:\/\//, "");
  let line: number | undefined;
  let end: number | undefined;
  const m = /(?::(\d+)(?::\d+)?(?:-(\d+))?|#L(\d+)(?:C\d+)?(?:-L(\d+))?)$/.exec(s);
  if (m) {
    line = Number(m[1] ?? m[3]);
    const e = m[2] ?? m[4];
    if (e) end = Number(e);
    s = s.slice(0, m.index);
  }
  if (!s || /[*?{}[\]<>|"'`$()=,;!]/.test(s) || /^[-+@]/.test(s) || s.includes("://")) return null;
  const name = s.split("/").pop()!;
  if (!name) return null;
  const ext = /\.([A-Za-z][A-Za-z0-9]{0,9})$/.test(name);
  if (!ext && !NAMES.has(name) && !(s.includes("/") && /^[\w.-]+$/.test(name) && /[A-Za-z]/.test(name) && line !== undefined)) return null;
  // `a.b` alone reads as code (a property, a method) more often than a file: a
  // bare name needs a folder, a line, or a known extension.
  if (!s.includes("/") && line === undefined && !NAMES.has(name) && !/\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|rb|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|md|mdx|json|jsonc|yaml|yml|toml|ini|cfg|conf|sql|html|css|scss|vue|svelte|lua|zig|txt|lock|env|xml|proto|gradle|tf|nix|ex|exs|erl|hs|ml|scala|dart|r|jl)$/i.test(name)) return null;
  return { path: s, ...(line ? { line } : {}), ...(end ? { end } : {}) };
}

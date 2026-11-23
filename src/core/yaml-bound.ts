// YAML read within a bound on what it stands for, not only on its text: an
// alias names a node again without repeating it, so a few kilobytes of anchors
// can stand for millions of values once the result is walked or written out
// as JSON. The text is refused above `maxChars` before it is parsed, and the
// value after: every value takes at least two characters of JSON (`1,`), so one
// with more than maxChars / 2 values, each alias counted where it is used,
// writes out longer than maxChars; a string adds its length at every use (one
// long anchored string named by many aliases is the same bomb in fewer
// values). Counting stops at the bound.
export function yamlWithin(text: string, maxChars: number): { value: unknown } | { problem: string } {
  if (text.length > maxChars) return { problem: `it is longer than ${maxChars} characters` };
  // The parser copies an anchored node at each of its aliases, so its time is the aliases times what
  // they name: 40,000 aliases of one 150,000-character string took 5 s in the parse alone. What an alias
  // names is never longer than the text, so the aliases times the text bound it before parsing.
  const aliases = text.match(/(?<=^|[\s,[{:?-])\*[^\s,\]}]+/gm)?.length ?? 0;
  if (aliases * text.length > maxChars * PARSE_FACTOR) return { problem: `its ${aliases} aliases could stand for more than the parser should copy` };
  let value: unknown;
  try { value = Bun.YAML.parse(text); } catch (e) { return { problem: `it cannot be read as YAML: ${(e as Error).message}` }; }
  if (!within(value, Math.floor(maxChars / 2))) return { problem: `its aliases stand for more than ${maxChars} characters` };
  return { value };
}

// The most the parser is let copy for aliases, in multiples of the text's bound: 20 million characters
// at a 400,000-character bound, about 20 ms of parsing; an ordinary frontmatter has few aliases or none.
const PARSE_FACTOR = 50;

// Whether a parsed value weighs at most `max`: each value one, a string half its length more (a
// character is at least one of JSON's, a value at least two), each shared one counted at every use.
export function within(value: unknown, max: number): boolean {
  const stack: unknown[] = [value];
  let n = 0;
  while (stack.length) {
    const v = stack.pop();
    n += typeof v === "string" ? 1 + Math.ceil(v.length / 2) : 1;
    if (n > max) return false;
    if (v && typeof v === "object") {
      const kids = Array.isArray(v) ? v : Object.values(v);
      // (Each value on the stack is counted when it is taken: past the bound already, stop.)
      if (n + stack.length + kids.length > max) return false;
      for (const k of kids) stack.push(k);
    }
  }
  return n <= max;
}

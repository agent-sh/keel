// YAML read within a bound on what it stands for, not only on its text: an
// alias names a node again without repeating it, so a few kilobytes of anchors
// can stand for millions of values once the result is walked or written out
// as JSON. The text is refused above `maxChars` before it is parsed, and the
// value after: every value takes at least two characters of JSON (`1,`), so one
// with more than maxChars / 2 values, each alias counted where it is used,
// writes out longer than maxChars. Counting stops at the bound.
export function yamlWithin(text: string, maxChars: number): { value: unknown } | { problem: string } {
  if (text.length > maxChars) return { problem: `it is longer than ${maxChars} characters` };
  let value: unknown;
  try { value = Bun.YAML.parse(text); } catch (e) { return { problem: `it cannot be read as YAML: ${(e as Error).message}` }; }
  if (!within(value, Math.floor(maxChars / 2))) return { problem: `its aliases stand for more than ${maxChars} characters` };
  return { value };
}

// Whether a parsed value has at most `max` values, each shared one counted at every use.
export function within(value: unknown, max: number): boolean {
  const stack: unknown[] = [value];
  let n = 0;
  while (stack.length) {
    const v = stack.pop();
    n++;
    if (v && typeof v === "object") {
      const kids = Array.isArray(v) ? v : Object.values(v);
      // (Each value on the stack is counted when it is taken: past the bound already, stop.)
      if (n + stack.length + kids.length > max) return false;
      for (const k of kids) stack.push(k);
    }
  }
  return n <= max;
}

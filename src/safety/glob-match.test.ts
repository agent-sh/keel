import { expect, test } from "bun:test";
import { globMatch } from "./shell.ts";
import { ifHolds } from "../integrations/hooks.ts";

// The regular expression a hook's `if` was once matched with: the meaning globMatch keeps.
const regexOf = (p: string) => new RegExp(`^${p.split("*").map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "s");

test("a glob gives the answers of the old regular expression on short inputs", () => {
  const patterns = ["", "*", "a", "a*", "*a", "a*b", "a*b*c", "*a*b*", "ab*ab", "**", "a**b", "a.b*", "x*y*z*w", "(a)*[b]"];
  const alphabet = ["a", "b", "c", "\n", ".", "x", "y", "z", "w", "(a)", "[b]"];
  const inputs = new Set<string>([""]);
  for (let n = 0; n < 4; n++) for (const s of [...inputs]) for (const c of alphabet) if (s.length < 7) inputs.add(s + c);
  let checked = 0;
  for (const p of patterns) {
    const re = regexOf(p);
    for (const s of inputs) {
      if (checked++ % 7 !== 0 && s.length > 4) continue;
      expect(globMatch(p, s)).toBe(re.test(s));
    }
  }
});

test("a rule with many stars is one pass on a long command that does not match", () => {
  const long = "a ".repeat(100_000) + "x";
  for (const rule of ["a*b*c*d", "a*b*c*d*e*f*g", "Bash(a *b*c*d*e*f*g)"]) {
    const pattern = rule.replace(/^Bash\(|\)$/g, "");
    const t0 = performance.now();
    expect(globMatch(pattern, long)).toBe(false);
    expect(performance.now() - t0).toBeLessThan(50);
  }
  // Through the hook's own entry, with the shell split: still bounded.
  const t0 = performance.now();
  expect(ifHolds("Bash(a *b*c*d*e*f*g)", ["Bash"], { command: long }, "/")).toBe(false);
  expect(performance.now() - t0).toBeLessThan(50);
});

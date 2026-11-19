import { expect, test } from "bun:test";
import { DESCRIPTION_CAP, fitListing } from "./skills.ts";

// Past the budget every name stays; the descriptions kept are those of the skills loaded most.
test("the skill listing keeps every name and the used skills' descriptions", () => {
  const entries = Array.from({ length: 40 }, (_, i) => ({ name: `skill-${i}`, description: `does thing ${i} `.repeat(20), uses: i === 39 ? 9 : i === 38 ? 3 : 0 }));
  const { lines, nameOnly } = fitListing(entries, 2_000);
  expect(lines.map((l) => l.split(":")[0]!.slice(2))).toEqual(entries.map((e) => e.name));
  expect(lines[39]).toContain("does thing 39");
  expect(lines[38]).toContain("does thing 38");
  expect(lines.join("\n").length).toBeLessThanOrEqual(2_000);
  expect(nameOnly.length).toBeGreaterThan(0);
  expect(nameOnly).not.toContain("skill-39");
  // One description is cut at the cap, as Claude Code cuts it.
  const one = fitListing([{ name: "long", description: "x".repeat(5_000), uses: 0 }], 100_000).lines[0]!;
  expect(one.length).toBe("- long: ".length + DESCRIPTION_CAP);
  expect(fitListing([{ name: "a", description: "fits", uses: 0 }]).nameOnly).toEqual([]);
});

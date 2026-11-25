import { expect, test } from "bun:test";
import { firstLine, pointerText } from "./pointer.ts";

test("a pointer to another session holds its title, id, state and the first line of its last reply, nothing more", () => {
  expect(firstLine("\n## \n  The budget is   approved.\nSecond line.")).toBe("The budget is approved.");
  expect(firstLine("x".repeat(400)).length).toBe(160);
  const p = pointerText({ id: "01abc", title: 'Orchard "budget"]', watch: "work", last_reply: "The budget is approved." });
  expect(p).toContain(`"Orchard 'budget''" (id 01abc, working)`);
  expect(p).toContain('Its last reply began: "The budget is approved."');
  expect(p).not.toContain("Second line");
  expect(pointerText({ id: "01abc", title: "" })).toContain('"Untitled" (id 01abc)');
});

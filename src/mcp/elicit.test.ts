import { expect, test } from "bun:test";
import { formOf, plain } from "./elicit.ts";

test("a server's words become plain bounded text", () => {
  expect(plain("a\u202eb\u0000c\u200bd\r\n\n\n\ne", 100)).toBe("abcd\n\ne");
  expect(plain("x".repeat(50), 10)).toBe("xxxxxxxxx…");
  expect(plain({ toString: () => "obj" }, 10)).toBe("obj");
  expect(plain(undefined, 10)).toBe("");
});

test("each kind of field is a question, and the answers become the schema's content", () => {
  const form = formOf({
    message: "Pick",
    requestedSchema: {
      type: "object",
      required: ["mail", "sure", "tags"],
      properties: {
        mail: { type: "string", format: "email" },
        sure: { type: "boolean", title: "Sure?" },
        tags: { type: "array", minItems: 1, maxItems: 2, items: { anyOf: [{ const: "a", title: "Alpha" }, { const: "b", title: "Beta" }, { const: "c", title: "Alpha" }] } },
        level: { type: "string", enum: ["low", "high"], enumNames: ["Low", "High"] },
        ratio: { type: "number", minimum: 0, default: 0.5 },
        nested: { type: "object", properties: { deep: { type: "string" } } },
      },
    },
  });
  expect(form.questions.map((q) => [q.id, q.options.map((o) => o.label), !!q.multiSelect, !!q.optional])).toEqual([
    ["mail", [], false, false],
    ["sure", ["Yes", "No"], false, false],
    ["tags", ["Alpha", "Beta", "Alpha (c)"], true, false],
    ["level", ["Low", "High"], false, true],
    ["ratio", [], false, true],
    ["nested", [], false, true],
  ]);
  expect(form.questions[4]!.question).toBe("ratio (left empty: 0.5)");
  expect(form.questions[3]!.question).toBe("level (optional)");

  // Picked labels and typed text, a default for what was left empty, nothing for an optional field left empty.
  expect(form.content({ mail: { picked: [], other: " a@b.co " }, sure: { picked: ["No"] }, tags: { picked: ["Alpha (c)"], other: "beta" } }))
    .toEqual({ content: { mail: "a@b.co", sure: false, tags: ["c", "b"], ratio: 0.5 } });
  // A typed answer to a choice names an option by label or value; yes and no are booleans.
  expect(form.content({ mail: { picked: [], other: "a@b.co" }, sure: { picked: [], other: "yes" }, tags: { picked: ["Beta"] }, level: { picked: [], other: "HIGH" }, ratio: { picked: [], other: "2.5" } }))
    .toEqual({ content: { mail: "a@b.co", sure: true, tags: ["b"], level: "high", ratio: 2.5 } });
  expect(form.content({ mail: { picked: [], other: "nope" }, tags: { picked: ["Alpha", "Beta", "Alpha (c)"] }, level: { picked: [], other: "mid" }, ratio: { picked: [], other: "-1" } }))
    .toEqual({ problems: ["mail must be an email address.", "Sure? needs an answer.", "tags takes at most 2.", "level must be one of: Low, High.", "ratio must be at least 0."] });
});

test("a request with no schema is a message to confirm", () => {
  const form = formOf({ message: "Go on?" });
  expect(form.questions).toEqual([]);
  expect(form.content({})).toEqual({ content: {} });
  expect(formOf(undefined).message).toBe("");
});

import { expect, test } from "bun:test";
import { formOf, looksSecret, MUST_NOT, plain } from "./elicit.ts";
import { withoutHidden } from "../core/hidden-chars.ts";

test("a server's words become plain bounded text", () => {
  expect(plain("a\u202eb\u0000c\u200bd\r\n\n\n\ne", 100)).toBe("abcd\n\ne");
  expect(plain("x".repeat(50), 10)).toBe("xxxxxxxxx…");
  expect(plain({ toString: () => "obj" }, 10)).toBe("obj");
  expect(plain(undefined, 10)).toBe("");
  // What draws nothing is gone, also past the first plane; a space that is not the plain one becomes one.
  expect(withoutHidden("a\u{E0041}\u{E0042}b\uFE0Fc\u3164d\u2800e\u00a0f\u3000g\u2028h\ti")).toBe("abcde f g\nh i");
  // A bound counts characters, not halves of one.
  expect(plain("😀".repeat(5), 3)).toBe("😀😀…");
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
  expect([form.sensitive, form.notes, form.unanswerable]).toEqual([false, [], undefined]);

  // Picked labels and typed text, a default for what was left empty, nothing for an optional field left empty.
  expect(form.content({ mail: { picked: [], other: " a@b.co " }, sure: { picked: ["No"] }, tags: { picked: ["Alpha (c)"], other: "beta" } }))
    .toEqual({ content: { mail: "a@b.co", sure: false, tags: ["c", "b"], ratio: 0.5 } });
  // A typed answer to a choice names an option by label or value; yes and no are booleans.
  expect(form.content({ mail: { picked: [], other: "a@b.co" }, sure: { picked: [], other: "yes" }, tags: { picked: ["Beta"] }, level: { picked: [], other: "HIGH" }, ratio: { picked: [], other: "2.5" } }))
    .toEqual({ content: { mail: "a@b.co", sure: true, tags: ["b"], level: "high", ratio: 2.5 } });
  expect(form.content({ mail: { picked: [], other: "nope" }, tags: { picked: ["Alpha", "Beta", "Alpha (c)"] }, level: { picked: [], other: "mid" }, ratio: { picked: [], other: "-1" } }))
    .toEqual({ problems: ["mail must be an email address.", "Sure? needs an answer.", "tags takes at most 2.", "level must be one of: Low, High.", "ratio must be at least 0."] });
  // An answer that is not the shape a card sends is no answer, not a crash.
  expect(form.content({ mail: { picked: "x", other: {} }, sure: 7, tags: null } as any)).toEqual({ problems: ["mail needs an answer.", "Sure? needs an answer.", "tags needs an answer."] });
});

test("a request with no schema is a message to confirm", () => {
  const form = formOf({ message: "Go on?" });
  expect(form.questions).toEqual([]);
  expect(form.content({})).toEqual({ content: {} });
  expect(formOf(undefined).message).toBe("");
});

test("fields named like an object's own parts are fields like any other", () => {
  const form = formOf({ message: "m", requestedSchema: JSON.parse('{"type":"object","required":["__proto__"],"properties":{"__proto__":{"type":"string"},"constructor":{"type":"string"},"toString":{"type":"string"}}}') });
  expect(form.questions.map((q) => q.id)).toEqual(["__proto__", "constructor", "toString"]);
  // Nothing answered: the names an empty object answers to by itself are not answers.
  expect(form.content({})).toEqual({ problems: ["__proto__ needs an answer."] });
  const got = form.content(JSON.parse('{"__proto__":{"picked":[],"other":"x"},"toString":{"picked":[],"other":"y"}}')) as { content: Record<string, unknown> };
  expect(JSON.stringify(got.content)).toBe('{"__proto__":"x","toString":"y"}');
  expect(Object.getPrototypeOf(got.content)).toBe(Object.prototype);
});

test("a field that looks like a secret is marked, by the words of its name", () => {
  for (const name of ["password", "Password", "db_password", "apiKey", "api_key", "API key", "access_token", "token", "client_secret", "privateKey", "key", "card_number", "creditCard", "cvv", "PIN", "otp", "Security code"]) expect([name, looksSecret(name)]).toEqual([name, true]);
  for (const name of ["user", "keyboard", "issue_key", "sort key", "monkey", "passenger", "tokenizer", "spin", "card", "secretary", "pinned", "author"]) expect([name, looksSecret(name)]).toEqual([name, false]);
  const form = formOf({ message: "Sign in", requestedSchema: { type: "object", properties: { user: { type: "string" }, pw: { type: "string", title: "Password" } } } });
  expect(form.questions.map((q) => !!q.secret)).toEqual([false, true]);
  expect([form.sensitive, form.notes]).toEqual([true, [MUST_NOT]]);
});

test("more fields than a card shows: optional ones are left to their defaults, a required one makes the form unanswerable", () => {
  const props = (n: number, extra: Record<string, unknown> = {}) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${i + 1}`, { type: "string", ...(i === 21 ? extra : {}) }]));
  const optional = formOf({ message: "m", requestedSchema: { type: "object", required: ["f1"], properties: props(23, { default: "kept" }) } });
  expect(optional.questions).toHaveLength(20);
  expect(optional.notes).toEqual(["3 more fields are not shown: a card asks 20 at most. They are optional and are left as the server defaults them."]);
  expect(optional.unanswerable).toBeUndefined();
  expect(optional.content({ f1: { picked: [], other: "a" } })).toEqual({ content: { f1: "a", f22: "kept" } });
  const stuck = formOf({ message: "m", requestedSchema: { type: "object", required: ["f1", "f22", "f23"], properties: props(23) } });
  expect(stuck.unanswerable).toBe("it needs 2 fields beyond the 20 a card shows (f22 and more)");
  // More options than a field shows: the rest can still be typed.
  const many = formOf({ message: "m", requestedSchema: { type: "object", properties: { n: { type: "string", enum: Array.from({ length: 60 }, (_, i) => `v${i}`) } } } });
  expect(many.questions[0]!.options).toHaveLength(50);
  expect(many.questions[0]!.question).toBe("n (optional, 10 more options not shown: type one)");
  expect(many.content({ n: { picked: [], other: "v59" } })).toEqual({ content: { n: "v59" } });
});

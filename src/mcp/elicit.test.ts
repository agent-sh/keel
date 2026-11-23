import { expect, test } from "bun:test";
import { formOf, linkOf, linksRequired, looksSecret, MUST_NOT, plain } from "./elicit.ts";
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
      },
    },
  });
  expect(form.questions.map((q) => [q.id, q.options.map((o) => o.label), !!q.multiSelect, !!q.optional])).toEqual([
    ["mail", [], false, false],
    ["sure", ["Yes", "No"], false, false],
    ["tags", ["Alpha", "Beta", "Alpha (c)"], true, false],
    ["level", ["Low", "High"], false, true],
    ["ratio", [], false, true],
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
  // Written as one word or split another way, in the plural, with a number; a code that proves who you are; what pays.
  for (const name of ["passWord1", "pass_word", "tokens", "secrets", "passwords", "apiKeys", "mfa_code", "MFA", "totp", "2fa", "verification code", "recovery_code", "ssn", "social security number", "iban", "account_number", "routing no", "bearer"]) expect([name, looksSecret(name)]).toEqual([name, true]);
  for (const name of ["passes", "status", "address", "code", "zip code", "country_code", "number", "phone number", "page_number", "class", "words", "bypass", "compass"]) expect([name, looksSecret(name)]).toEqual([name, false]);
  // The ask can be in the description alone.
  const form = formOf({ message: "Sign in", requestedSchema: { type: "object", properties: { user: { type: "string" }, pw: { type: "string", title: "Password" }, field1: { type: "string", title: "Value", description: "Enter your account password" } } } });
  expect(form.questions.map((q) => !!q.secret)).toEqual([false, true, true]);
  // The object replacement character draws nothing a reader can act on: gone with the rest.
  expect(plain("a\uFFFCb", 10)).toBe("ab");
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

test("a secret is found in other languages, in look-alike letters and digits, and in the form's own words", () => {
  for (const name of ["Passwort", "Kennwort", "contraseña", "mot de passe", "senha", "пароль", "סיסמה", "密码", "pаssword" /* a Cyrillic а */, "passw0rd", "p@ssword", "s3cret", "github_pat", "session cookie", "jwt", "personal access token", "seed phrase", "mnemonic", "creds"]) {
    expect([name, looksSecret(name)]).toEqual([name, true]);
  }
  for (const name of ["Pass", "path", "pattern", "c0de", "field1", "user@example.com", "clavier", "título", "名前"]) expect([name, looksSecret(name)]).toEqual([name, false]);
  // The fields are plain, the message asks for a password: sent only on the owner's explicit word.
  const form = formOf({ message: "Please enter your account password to continue", requestedSchema: { type: "object", properties: { value: { type: "string", title: "Value" } } } });
  expect([form.sensitive, form.notes]).toEqual([true, [MUST_NOT]]);
});

test("a field of a kind a form does not have makes the form unanswerable, not a string", () => {
  const object = formOf({ message: "m", requestedSchema: { type: "object", properties: { where: { type: "object", properties: { x: { type: "string" } } } } } });
  expect(object.unanswerable).toBe("its field where is an object, which a form does not have");
  const list = formOf({ message: "m", requestedSchema: { type: "object", properties: { tags: { type: "array", items: { type: "string" } } } } });
  expect(list.unanswerable).toBe("its field tags is a list of free text, which a form does not have");
  // A list of choices is a field a form has.
  expect(formOf({ message: "m", requestedSchema: { type: "object", properties: { tags: { type: "array", items: { type: "string", enum: ["a", "b"] } } } } }).unanswerable).toBeUndefined();
});

// The parser runs on the daemon's loop with what a server sent: its time is
// bounded by the size it accepts, and grows no faster than that size.
test("a form is parsed in time linear in its size, and one over the size it takes is not parsed", () => {
  const equal = (n: number) => ({ message: "m", requestedSchema: { type: "object", properties: { pick: { type: "string", enum: Array.from({ length: n }, () => "same") } } } });
  const timed = (params: unknown) => { const t = performance.now(); const f = formOf(params); return { ms: performance.now() - t, f }; };
  timed(equal(50)); // (warm)
  const small = timed(equal(500)), large = timed(equal(4000));
  // A thousand options are kept, each with a label of its own that stays short.
  expect(large.f.questions[0]!.options).toHaveLength(50);
  expect(large.ms).toBeLessThan(100);
  expect(large.ms).toBeLessThan(Math.max(20, small.ms * 30));
  const labels = new Set<string>();
  const one = formOf(equal(1000));
  expect(one.content({ pick: { picked: [], other: "same (same) 500" } })).toEqual({ content: { pick: "same" } });
  for (const o of one.questions[0]!.options) labels.add(o.label);
  expect([...labels].slice(0, 4)).toEqual(["same", "same (same)", "same (same) 2", "same (same) 3"]);
  // 14 KB of one long enum value repeated, and a request past the bound.
  const wide = timed({ message: "m", requestedSchema: { type: "object", properties: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`f${i}`, { type: "string", enum: Array.from({ length: 20 }, () => "v") }])) } });
  expect(wide.ms).toBeLessThan(100);
  const huge = timed({ message: "m", requestedSchema: { type: "object", properties: { pick: { type: "string", enum: Array.from({ length: 20_000 }, (_, i) => `value ${i}`) } } } });
  expect(huge.f.unanswerable).toBe("it is larger than 64 KB, the most a form is");
  expect(huge.f.questions).toEqual([]);
  expect(huge.ms).toBeLessThan(100);
  // A request far over the bound is refused at the cost of the bound, not of its size.
  const vast = { message: "m", requestedSchema: { type: "object", properties: Object.fromEntries(Array.from({ length: 50_000 }, (_, i) => [`f${i}`, { type: "string", enum: Array.from({ length: 50 }, (_, j) => `o${j}`) }])) } };
  const refused = timed(vast);
  expect([refused.f.unanswerable, refused.ms < 50]).toEqual(["it is larger than 64 KB, the most a form is", true]);
});

test("a page a server sends the owner to is shown whole, its site apart, with what to know first", () => {
  expect(linkOf({ mode: "url", elicitationId: "e-1", url: "https://mcp.example.com/ui/set_api_key", message: "Please provide your API key.\u202e" }))
    .toEqual({ message: "Please provide your API key.", url: "https://mcp.example.com/ui/set_api_key", host: "mcp.example.com", id: "e-1", notes: [] });
  // What is shown is what the browser opens: the address as the parser writes it.
  expect((linkOf({ url: " HTTPS://Mcp.Example.COM/a b" }) as any).url).toBe("https://mcp.example.com/a%20b");
  // A name of other letters, a name before an @ sign, a page not on HTTPS: each is said.
  const spoof = linkOf({ url: "http://paypal.com@xn--pypal-4ve.com/login" }) as any;
  expect(spoof.host).toBe("xn--pypal-4ve.com");
  expect(spoof.notes).toEqual([
    "The site's name is written in Punycode, and reads as pаypal.com: letters of another alphabet can imitate a known site's name.",
    "The address has a name before an @ sign: the site is xn--pypal-4ve.com, whatever comes before the @.",
    "The page is not on HTTPS: what is typed there travels unencrypted.",
  ]);
  expect((linkOf({ url: "http://localhost:3000/cb" }) as any).notes).toEqual([]);
  // Only a web page is a place to send the owner; anything else is refused.
  expect(linkOf({ url: "javascript:alert(1)" })).toEqual({ refuse: "keel sends the owner only to http and https pages, not javascript: addresses" });
  expect(linkOf({ url: "file:///etc/passwd" })).toMatchObject({ refuse: expect.stringContaining("not file:") });
  expect(linkOf({ url: "not a url" })).toEqual({ refuse: "its url is not a valid URL" });
  expect(linkOf({})).toEqual({ refuse: "its url is not a valid URL" });
  expect(linkOf({ url: "https://a.test/" + "x".repeat(70_000) })).toMatchObject({ refuse: expect.stringContaining("larger than") });
});

test("the pages a URLElicitationRequiredError names are its URL elicitations with an id", () => {
  const page = { mode: "url", elicitationId: "e-1", url: "https://a.test/", message: "Sign in" };
  expect(linksRequired({ elicitations: [page, { mode: "form", elicitationId: "e-2" }, { mode: "url", url: "https://b.test/" }, null, "x"] })).toEqual([page]);
  expect(linksRequired({})).toEqual([]);
  expect(linksRequired(undefined)).toEqual([]);
});

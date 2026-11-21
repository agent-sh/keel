// MCP elicitation, form mode: a server asks the owner for a few flat fields
// while it works on a call, and the owner answers on a question card.
//
// The specification (modelcontextprotocol.io/specification/2025-11-25/client/elicitation
// and .../2026-07-28/client/elicitation): the request is `elicitation/create`
// with a `message` and a `requestedSchema`, a flat object of primitive
// properties (string with an optional format, number, integer, boolean, a
// single-select enum as `enum` or `oneOf` of const and title, a multi-select
// as an array of those). The answer is `{ action: "accept", content }`,
// `{ action: "decline" }` (the owner said no) or `{ action: "cancel" }` (the
// owner made no choice). A client shows which server asks, lets the owner
// decline, and should check the answer against the schema before sending it.
import { withoutHidden } from "../core/hidden-chars.ts";
import type { Answers, Question } from "../tools/interact.ts";

export type ElicitResult = { action: "accept"; content: Record<string, unknown> } | { action: "decline" } | { action: "cancel" };

// A server's words as plain text for the card: nothing a reader cannot see or
// that reorders what is seen (src/core/hidden-chars.ts), and a bound on the
// length. The card never renders it as markup or as a link.
export function plain(v: unknown, max: number): string {
  const s = withoutHidden(typeof v === "string" ? v : v === undefined || v === null ? "" : String(v)).replace(/\n{3,}/g, "\n\n").trim();
  const chars = [...s];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : s;
}
const MESSAGE_MAX = 2000;
const LABEL_MAX = 200;
// The fields one card asks: more is no form a person fills in on a card.
const FIELDS_MAX = 20;
// The options a field shows, and the ones kept so a typed answer can still name one.
const OPTIONS_MAX = 50;
const OPTIONS_KEPT = 2000;

// What a form must not ask for (2025-11-25 client/elicitation: "Servers MUST
// NOT use form mode elicitation to request sensitive information such as
// passwords, API keys, access tokens, or payment credentials"). A field is
// taken for one by the words of its name, its title and its description (a
// server can put the ask in any of them). A field taken for one by mistake
// costs the owner one tick; one missed is typed in the clear.
export const MUST_NOT = "The MCP specification says a server must not ask for passwords, API keys, access tokens or payment details in a form like this one.";
const SECRET_WORDS = new Set([
  "password", "passwd", "pwd", "passphrase", "passcode", "secret", "token", "apikey", "credential", "cvv", "cvc", "pin", "otp", "totp", "mfa", "2fa", "tfa",
  "ssn", "iban", "bearer",
]);
// A word that is one only next to another: "key" after one of these, a code that proves who you are, a number that pays.
const KEY_OF = new Set(["api", "access", "secret", "private", "license", "licence", "encryption", "signing", "ssh", "auth"]);
const CODE_OF = new Set(["security", "verification", "auth", "authentication", "login", "recovery", "backup", "sms", "access"]);
const NUMBER_OF = new Set(["card", "account", "routing", "social", "passport", "tax"]);
// The same words written as one or split another way ("pass_word", "passWord1", "api-key").
const JOINED = /pass(word|wd|phrase|code)|apikey|secretkey|privatekey|accesskey|accesstoken|authtoken|bearertoken|creditcard|cardnumber|socialsecurity|onetime(code|password|pin)/;
// A plural or a trailing number is the same word ("tokens", "secret2").
const stem = (w: string) => { const bare = w.replace(/\d+$/, "") || w; return bare.length > 3 && bare.endsWith("s") && !bare.endsWith("ss") ? bare.slice(0, -1) : bare; };
export function looksSecret(...names: unknown[]): boolean {
  return names.some((n) => {
    if (typeof n !== "string") return false;
    const words = n.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(stem);
    if (JOINED.test(words.join(""))) return true;
    return words.some((w, i) => SECRET_WORDS.has(w)
      || (w === "key" && (words.length === 1 || KEY_OF.has(words[i - 1] ?? "")))
      || (w === "code" && CODE_OF.has(words[i - 1] ?? ""))
      || (["number", "no", "num"].includes(w) && NUMBER_OF.has(words[i - 1] ?? ""))
      || (w === "credit" && words[i + 1] === "card")
      || (w === "social" && words[i + 1] === "security"));
  });
}

type Choice = { label: string; value: unknown };
type Field = {
  name: string;
  kind: "text" | "number" | "integer" | "boolean" | "one" | "many";
  schema: Record<string, any>;
  choices: Choice[];
  required: boolean;
  secret: boolean;
};

// The values and titles of an enum, in the forms the schema allows (and the
// `enumNames` of the 2025-06-18 revision).
function choicesOf(s: Record<string, any>): Choice[] | undefined {
  const pairs = Array.isArray(s.oneOf) ? s.oneOf : Array.isArray(s.anyOf) ? s.anyOf : undefined;
  const raw: [unknown, unknown][] | undefined = pairs
    ? pairs.filter((o: any) => o && typeof o === "object" && Object.hasOwn(o, "const")).map((o: any) => [o.const, o.title])
    : Array.isArray(s.enum) ? s.enum.map((v: unknown, i: number) => [v, Array.isArray(s.enumNames) ? s.enumNames[i] : undefined]) : undefined;
  if (!raw?.length) return undefined;
  const seen = new Set<string>();
  return raw.slice(0, OPTIONS_KEPT).map(([value, title]) => {
    // Two options never share a label: the label is what the owner picks.
    let label = plain(title ?? value, LABEL_MAX) || plain(value, LABEL_MAX) || "(empty)";
    if (seen.has(label)) label = `${label} (${plain(value, LABEL_MAX)})`;
    for (let n = 2; seen.has(label); n++) label = `${label} ${n}`;
    seen.add(label);
    return { label, value };
  });
}

export type Form = {
  message: string;
  questions: Question[];
  // What the card says besides the server's words: fields left out, what a form must not ask.
  notes: string[];
  // A field the form needs is beyond what a card shows: it cannot be answered.
  unanswerable?: string;
  // One of the fields looks like a secret: answered only when the owner says to send it anyway.
  sensitive: boolean;
  // The owner's answers as the content the schema asks for, or what is wrong with them.
  content: (answers: Answers) => { content: Record<string, unknown> } | { problems: string[] };
};

const own = (o: unknown, k: string): any => (o && typeof o === "object" && Object.hasOwn(o, k) ? (o as any)[k] : undefined);

export function formOf(params: any): Form {
  const schema = own(params, "requestedSchema") && typeof params.requestedSchema === "object" ? params.requestedSchema : {};
  const properties = own(schema, "properties");
  const props: [string, any][] = Object.entries(properties && typeof properties === "object" ? properties : {});
  const need = new Set<string>(Array.isArray(schema.required) ? schema.required.map(String) : []);
  const fieldOf = ([name, raw]: [string, any]): Field => {
    const s: Record<string, any> = raw && typeof raw === "object" ? raw : {};
    const many = s.type === "array" && s.items && typeof s.items === "object" ? choicesOf(s.items) : undefined;
    const one = many ? undefined : choicesOf(s);
    const kind: Field["kind"] = many ? "many" : one ? "one" : s.type === "boolean" ? "boolean" : s.type === "number" ? "number" : s.type === "integer" ? "integer" : "text";
    const choices = many ?? one ?? (kind === "boolean" ? [{ label: "Yes", value: true }, { label: "No", value: false }] : []);
    return { name, kind, schema: s, choices, required: need.has(name), secret: looksSecret(name, s.title, s.description) };
  };
  const fields = props.slice(0, FIELDS_MAX).map(fieldOf);
  // The fields past what a card shows: a default still goes with the answer,
  // and a required one without a default means the form cannot be answered.
  const rest = props.slice(FIELDS_MAX, FIELDS_MAX + 1000).map(fieldOf);
  const stuck = rest.filter((f) => f.required && f.schema.default === undefined);
  const labelOf = (f: Field, value: unknown) => f.choices.find((c) => c.value === value)?.label ?? plain(value, LABEL_MAX);
  const questions: Question[] = fields.map((f) => {
    const title = plain(f.schema.title, LABEL_MAX) || plain(f.name, LABEL_MAX);
    const about = plain(f.schema.description, 500);
    const d = f.schema.default;
    const preset = d === undefined ? "" : f.kind === "many" && Array.isArray(d) ? d.map((v) => labelOf(f, v)).join(", ") : labelOf(f, d);
    const more = f.choices.length - OPTIONS_MAX;
    const hint = [
      f.required || d !== undefined ? "" : "optional",
      preset ? `left empty: ${preset}` : "",
      more > 0 ? `${more}${f.choices.length === OPTIONS_KEPT ? " or" : ""} more option${more === 1 ? "" : "s"} not shown: type one` : "",
    ].filter(Boolean).join(", ");
    return {
      id: f.name,
      question: `${title}${about && about !== title ? `: ${about}` : ""}${hint ? ` (${hint})` : ""}`,
      options: f.choices.slice(0, OPTIONS_MAX).map((c) => ({ label: c.label })),
      multiSelect: f.kind === "many",
      optional: !f.required || d !== undefined,
      ...(f.secret ? { secret: true } : {}),
    };
  });
  const sensitive = fields.some((f) => f.secret);
  const notes = [
    sensitive ? MUST_NOT : "",
    props.length > FIELDS_MAX ? `${props.length - FIELDS_MAX} more field${props.length - FIELDS_MAX === 1 ? " is" : "s are"} not shown: a card asks ${FIELDS_MAX} at most. ${stuck.length ? "" : "They are optional and are left as the server defaults them."}`.trim() : "",
  ].filter(Boolean);

  const content: Form["content"] = (answers) => {
    const out: Record<string, unknown> = {};
    const set = (name: string, value: unknown) => Object.defineProperty(out, name, { value, enumerable: true, writable: true, configurable: true });
    const problems: string[] = [];
    for (const f of rest) if (f.schema.default !== undefined) set(f.name, f.schema.default);
    for (const f of fields) {
      const a = own(answers, f.name);
      const typed: string = (typeof a?.other === "string" ? a.other : "").trim();
      const picked: string[] = Array.isArray(a?.picked) ? a.picked.filter((x: unknown) => typeof x === "string") : [];
      const title = plain(f.schema.title, LABEL_MAX) || plain(f.name, LABEL_MAX);
      const bad = (why: string) => { problems.push(`${title} ${why}.`); };
      const shown = () => `${f.choices.slice(0, OPTIONS_MAX).map((x) => x.label).join(", ")}${f.choices.length > OPTIONS_MAX ? " and the ones not shown" : ""}`;
      if (!typed && !picked.length) {
        if (f.schema.default !== undefined) set(f.name, f.schema.default);
        else if (f.required) bad("needs an answer");
        continue;
      }
      // A typed answer to a choice names an option by its label or its value.
      const named = (text: string) => f.choices.find((c) => c.label.toLowerCase() === text.toLowerCase() || String(c.value).toLowerCase() === text.toLowerCase());
      if (f.kind === "one" || f.kind === "boolean") {
        const yesno = f.kind === "boolean" && typed ? (/^(y|yes|true|1)$/i.test(typed) ? f.choices[0] : /^(n|no|false|0)$/i.test(typed) ? f.choices[1] : undefined) : undefined;
        const c = typed ? yesno ?? named(typed) : f.choices.find((x) => x.label === picked[0]);
        if (!c) bad(`must be one of: ${shown()}`);
        else set(f.name, c.value);
      } else if (f.kind === "many") {
        const all = [...picked.map((l) => f.choices.find((x) => x.label === l)), ...(typed ? typed.split(",").map((t) => named(t.trim())) : [])];
        if (all.some((c) => !c)) { bad(`takes only: ${shown()}`); continue; }
        const values = [...new Set(all.map((c) => c!.value))];
        if (typeof f.schema.minItems === "number" && values.length < f.schema.minItems) bad(`needs at least ${f.schema.minItems}`);
        else if (typeof f.schema.maxItems === "number" && values.length > f.schema.maxItems) bad(`takes at most ${f.schema.maxItems}`);
        else set(f.name, values);
      } else if (f.kind === "number" || f.kind === "integer") {
        const text = typed || (picked[0] ?? "").trim();
        const n = Number(text);
        if (!text || !Number.isFinite(n)) bad("must be a number");
        else if (f.kind === "integer" && !Number.isInteger(n)) bad("must be a whole number");
        else if (typeof f.schema.minimum === "number" && n < f.schema.minimum) bad(`must be at least ${f.schema.minimum}`);
        else if (typeof f.schema.maximum === "number" && n > f.schema.maximum) bad(`must be at most ${f.schema.maximum}`);
        else set(f.name, n);
      } else {
        const text = typed || picked.join(", ");
        const fmt: Record<string, (t: string) => boolean> = {
          email: (t) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t),
          uri: (t) => URL.canParse(t),
          date: (t) => /^\d{4}-\d{2}-\d{2}$/.test(t) && !Number.isNaN(Date.parse(t)),
          "date-time": (t) => /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}/.test(t) && !Number.isNaN(Date.parse(t)),
        };
        const check = typeof f.schema.format === "string" && Object.hasOwn(fmt, f.schema.format) ? fmt[f.schema.format]! : undefined;
        const length = [...text].length;
        if (typeof f.schema.minLength === "number" && length < f.schema.minLength) bad(`needs at least ${f.schema.minLength} characters`);
        else if (typeof f.schema.maxLength === "number" && length > f.schema.maxLength) bad(`takes at most ${f.schema.maxLength} characters`);
        else if (check && !check(text)) bad(`must be ${f.schema.format === "uri" ? "a URL" : f.schema.format === "email" ? "an email address" : f.schema.format === "date" ? "a date (YYYY-MM-DD)" : "a date and time (ISO 8601)"}`);
        else set(f.name, text);
      }
    }
    return problems.length ? { problems } : { content: out };
  };
  return {
    message: plain(own(params, "message"), MESSAGE_MAX), questions, notes, sensitive, content,
    ...(stuck.length ? { unanswerable: `it needs ${stuck.length === 1 ? "a field" : `${stuck.length} fields`} beyond the ${FIELDS_MAX} a card shows (${plain(stuck[0]!.name, 60)}${stuck.length > 1 ? " and more" : ""})` } : {}),
  };
}

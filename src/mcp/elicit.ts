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
import type { Answers, Question } from "../tools/interact.ts";

export type ElicitResult = { action: "accept"; content: Record<string, unknown> } | { action: "decline" } | { action: "cancel" };

// A server's words as plain text for the card: no control characters, none of
// the characters that reorder or hide text (bidirectional overrides and
// isolates, zero-width marks), and a bound on the length. The card never
// renders it as markup or as a link.
const HIDDEN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;
export function plain(v: unknown, max: number): string {
  const s = (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v)).replace(HIDDEN, "").replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
const MESSAGE_MAX = 2000;
const LABEL_MAX = 200;
// The fields one card asks: more is no form a person fills in on a card.
const FIELDS_MAX = 20;
const OPTIONS_MAX = 50;

type Choice = { label: string; value: unknown };
type Field = {
  name: string;
  kind: "text" | "number" | "integer" | "boolean" | "one" | "many";
  schema: Record<string, any>;
  choices: Choice[];
  required: boolean;
};

// The values and titles of an enum, in the forms the schema allows (and the
// `enumNames` of the 2025-06-18 revision).
function choicesOf(s: Record<string, any>): Choice[] | undefined {
  const pairs = Array.isArray(s.oneOf) ? s.oneOf : Array.isArray(s.anyOf) ? s.anyOf : undefined;
  const raw: [unknown, unknown][] | undefined = pairs
    ? pairs.filter((o: any) => o && "const" in o).map((o: any) => [o.const, o.title])
    : Array.isArray(s.enum) ? s.enum.map((v: unknown, i: number) => [v, Array.isArray(s.enumNames) ? s.enumNames[i] : undefined]) : undefined;
  if (!raw?.length) return undefined;
  const seen = new Set<string>();
  return raw.slice(0, OPTIONS_MAX).map(([value, title]) => {
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
  // The owner's answers as the content the schema asks for, or what is wrong with them.
  content: (answers: Answers) => { content: Record<string, unknown> } | { problems: string[] };
};

export function formOf(params: any): Form {
  const schema = params?.requestedSchema && typeof params.requestedSchema === "object" ? params.requestedSchema : {};
  const props: [string, any][] = Object.entries(schema.properties && typeof schema.properties === "object" ? schema.properties : {});
  const need = new Set<string>(Array.isArray(schema.required) ? schema.required.map(String) : []);
  const fields: Field[] = props.slice(0, FIELDS_MAX).map(([name, raw]) => {
    const s: Record<string, any> = raw && typeof raw === "object" ? raw : {};
    const many = s.type === "array" && s.items && typeof s.items === "object" ? choicesOf(s.items) : undefined;
    const one = many ? undefined : choicesOf(s);
    const kind: Field["kind"] = many ? "many" : one ? "one" : s.type === "boolean" ? "boolean" : s.type === "number" ? "number" : s.type === "integer" ? "integer" : "text";
    const choices = many ?? one ?? (kind === "boolean" ? [{ label: "Yes", value: true }, { label: "No", value: false }] : []);
    return { name, kind, schema: s, choices, required: need.has(name) };
  });
  const labelOf = (f: Field, value: unknown) => f.choices.find((c) => c.value === value)?.label ?? plain(value, LABEL_MAX);
  const questions: Question[] = fields.map((f) => {
    const title = plain(f.schema.title, LABEL_MAX) || plain(f.name, LABEL_MAX);
    const about = plain(f.schema.description, 500);
    const d = f.schema.default;
    const preset = d === undefined ? "" : f.kind === "many" && Array.isArray(d) ? d.map((v) => labelOf(f, v)).join(", ") : labelOf(f, d);
    const hint = [f.required || d !== undefined ? "" : "optional", preset ? `left empty: ${preset}` : ""].filter(Boolean).join(", ");
    return {
      id: f.name,
      question: `${title}${about && about !== title ? `: ${about}` : ""}${hint ? ` (${hint})` : ""}`,
      options: f.choices.map((c) => ({ label: c.label })),
      multiSelect: f.kind === "many",
      optional: !f.required || d !== undefined,
    };
  });

  const content: Form["content"] = (answers) => {
    const out: Record<string, unknown> = {};
    const problems: string[] = [];
    for (const f of fields) {
      const a = answers[f.name];
      const typed = (a?.other ?? "").trim();
      const picked = a?.picked ?? [];
      const title = plain(f.schema.title, LABEL_MAX) || plain(f.name, LABEL_MAX);
      const bad = (why: string) => { problems.push(`${title} ${why}.`); };
      if (!typed && !picked.length) {
        if (f.schema.default !== undefined) out[f.name] = f.schema.default;
        else if (f.required) bad("needs an answer");
        continue;
      }
      // A typed answer to a choice names an option by its label or its value.
      const named = (text: string) => f.choices.find((c) => c.label.toLowerCase() === text.toLowerCase() || String(c.value).toLowerCase() === text.toLowerCase());
      if (f.kind === "one" || f.kind === "boolean") {
        const yesno = f.kind === "boolean" && typed ? (/^(y|yes|true|1)$/i.test(typed) ? f.choices[0] : /^(n|no|false|0)$/i.test(typed) ? f.choices[1] : undefined) : undefined;
        const c = typed ? yesno ?? named(typed) : f.choices.find((x) => x.label === picked[0]);
        if (!c) bad(`must be one of: ${f.choices.map((x) => x.label).join(", ")}`);
        else out[f.name] = c.value;
      } else if (f.kind === "many") {
        const all = [...picked.map((l) => f.choices.find((x) => x.label === l)), ...(typed ? typed.split(",").map((t) => named(t.trim())) : [])];
        if (all.some((c) => !c)) { bad(`takes only: ${f.choices.map((x) => x.label).join(", ")}`); continue; }
        const values = [...new Set(all.map((c) => c!.value))];
        if (typeof f.schema.minItems === "number" && values.length < f.schema.minItems) bad(`needs at least ${f.schema.minItems}`);
        else if (typeof f.schema.maxItems === "number" && values.length > f.schema.maxItems) bad(`takes at most ${f.schema.maxItems}`);
        else out[f.name] = values;
      } else if (f.kind === "number" || f.kind === "integer") {
        const n = Number(typed || picked[0]);
        if (!(typed || picked[0])!.trim() || !Number.isFinite(n)) bad("must be a number");
        else if (f.kind === "integer" && !Number.isInteger(n)) bad("must be a whole number");
        else if (typeof f.schema.minimum === "number" && n < f.schema.minimum) bad(`must be at least ${f.schema.minimum}`);
        else if (typeof f.schema.maximum === "number" && n > f.schema.maximum) bad(`must be at most ${f.schema.maximum}`);
        else out[f.name] = n;
      } else {
        const text = typed || picked.join(", ");
        const fmt: Record<string, (t: string) => boolean> = {
          email: (t) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t),
          uri: (t) => URL.canParse(t),
          date: (t) => /^\d{4}-\d{2}-\d{2}$/.test(t) && !Number.isNaN(Date.parse(t)),
          "date-time": (t) => /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}/.test(t) && !Number.isNaN(Date.parse(t)),
        };
        const length = [...text].length;
        if (typeof f.schema.minLength === "number" && length < f.schema.minLength) bad(`needs at least ${f.schema.minLength} characters`);
        else if (typeof f.schema.maxLength === "number" && length > f.schema.maxLength) bad(`takes at most ${f.schema.maxLength} characters`);
        else if (typeof f.schema.format === "string" && fmt[f.schema.format] && !fmt[f.schema.format]!(text)) bad(`must be ${f.schema.format === "uri" ? "a URL" : f.schema.format === "email" ? "an email address" : f.schema.format === "date" ? "a date (YYYY-MM-DD)" : "a date and time (ISO 8601)"}`);
        else out[f.name] = text;
      }
    }
    return problems.length ? { problems } : { content: out };
  };
  return { message: plain(params?.message, MESSAGE_MAX), questions, content };
}

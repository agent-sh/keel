// The helper's memory tools over keyed records (memory.ts): get by key,
// find keys by alias, topic, prefix or words, put, delete, and import a big
// file once. Results are short lines; a lookup shows keys with previews and
// the model asks for the values it needs.
import { fail, ok, type Tool, type ToolOutput } from "../tools/types.ts";
import type { Memory } from "./memory.ts";
import { FIND_LIMIT, MEMORY_KINDS, type MemoryRecord } from "./records.ts";

const guard = async (f: () => Promise<string> | string): Promise<ToolOutput> => {
  try { return ok(await f()); } catch (e) { return fail(e instanceof Error ? e.message : String(e)); }
};
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === "string" ? v.split(",") : []).map((s) => s.trim()).filter(Boolean);
const full = (r: MemoryRecord) => `${r.key}${r.kind === "fact" || r.kind === "reference" ? "" : ` (${r.kind})`}: ${r.value}${r.aliases.length ? `\n  aliases: ${r.aliases.join(", ")}` : ""}${r.topics.length ? `\n  topics: ${r.topics.join(", ")}` : ""}`;

const recordSchema = {
  type: "object",
  properties: {
    key: { type: "string", description: "Stable namespaced key, lower case: person.dana-levi, mail.label.label_23, pref.notifications, project.site.domain. Same key replaces the record." },
    value: { type: "string", description: "One fact in plain words, short (at most 500 characters). Dated when time matters." },
    kind: { type: "string", enum: MEMORY_KINDS, description: "reference: lookup data such as ids to names (never recalled unless named)" },
    aliases: { type: "array", items: { type: "string" }, description: "Other names the record is asked for by: a first name, an email, an id, a display name" },
    topics: { type: "array", items: { type: "string" }, description: "A few broad topics it belongs to: mail, tax, family" },
  },
  required: ["key", "value"],
  additionalProperties: false,
};

export function memoryTools(mem: () => Memory): Tool[] {
  const get: Tool = {
    name: "helper__memory_get",
    description: "Look up your memory by key: one record per key, found directly (a hash lookup), with its aliases and topics. An alias or a person's name works as a key when it names one record. Check memory before reading files, mail or other sessions for a fact you may have kept: label names, people, accounts, ids, preferences, decisions, dates.",
    input_schema: { type: "object", properties: { keys: { type: "array", items: { type: "string" }, description: "Keys or aliases, as many as you need at once" } }, required: ["keys"], additionalProperties: false },
    readOnly: true,
    run: (input) => guard(() => {
      const keys = list(input.keys);
      if (!keys.length) throw new Error("keys is a list of record keys");
      const m = mem();
      const found: MemoryRecord[] = [];
      const lines = keys.slice(0, 100).map((k) => {
        const r = m.index.resolve(k);
        if (r.record) { found.push(r.record); return full(r.record); }
        return `${k}: no record${r.candidates.length ? ` (did you mean ${r.candidates.slice(0, 5).join(", ")})` : ""}`;
      });
      m.touch(found.map((r) => r.key));
      return lines.join("\n");
    }),
  };

  const find: Tool = {
    name: "helper__memory_find",
    description: `Find keys in your memory when you do not know the exact one: by alias (a name, an email, an id), by topic, by key prefix (mail.label, person) or by words. Returns at most ${FIND_LIMIT} keys with a one-line preview each, and the topics they carry; get the full records with helper__memory_get. An empty query lists the namespaces and topics you have.`,
    input_schema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number", description: `At most this many keys (default ${FIND_LIMIT}, up to 100)` } }, required: ["query"], additionalProperties: false },
    readOnly: true,
    run: (input) => guard(() => {
      const m = mem();
      const q = String(input.query ?? "").trim();
      if (!q) {
        const o = m.index.overview();
        if (!m.index.size) return "Memory is empty.";
        return `${m.index.size} records.\nNamespaces: ${o.spaces.map((s) => `${s.space} (${s.count})`).join(", ")}${o.topics.length ? `\nTopics: ${o.topics.map((t) => `${t.topic} (${t.count})`).join(", ")}` : ""}`;
      }
      const limit = Math.min(100, Math.max(1, Number(input.limit) || FIND_LIMIT));
      const f = m.index.find(q, limit);
      if (!f.total) return `No record matches "${q}". Namespaces: ${m.index.overview(12).spaces.map((s) => `${s.space} (${s.count})`).join(", ") || "none"}.`;
      const more = f.total > f.hits.length ? ` (showing ${f.hits.length}; narrow the query or raise limit)` : "";
      return `${f.total} record${f.total > 1 ? "s" : ""} for "${q}"${more}:\n${f.hits.map((h) => `${h.key}: ${h.preview}`).join("\n")}${f.topics.length ? `\nTopics: ${f.topics.map((t) => `${t.topic} (${t.count})`).join(", ")}` : ""}`;
    }),
  };

  const put: Tool = {
    name: "helper__memory_put",
    // One record sent as the input itself (its fields beside no `records`) is read as a list of one.
    inputOptional: ["records"],
    inputAlso: ["key", "value", "kind", "aliases", "topics"],
    description: "Keep facts in your memory, one short fact per record under a stable key: the owner's preferences, decisions, people and how they relate, commitments with dates, accounts, and lookup data (ids to names). The same key replaces the record, so update instead of adding a near copy. Give aliases for every name it is asked by. Several records in one call. The owner sees and edits them. Never secrets.",
    input_schema: { type: "object", properties: { records: { type: "array", items: recordSchema } }, required: ["records"], additionalProperties: false },
    readOnly: true,
    run: (input) => guard(() => {
      const recs = Array.isArray(input.records) ? input.records : input.key ? [input] : [];
      const done = mem().put(recs, "helper");
      return `Kept ${done.length}: ${done.slice(0, 12).map((r) => r.key).join(", ")}${done.length > 12 ? ", ..." : ""}`;
    }),
  };

  const drop: Tool = {
    name: "helper__memory_delete",
    description: "Delete records from your memory (they turned false, or the owner asked), by key.",
    input_schema: { type: "object", properties: { keys: { type: "array", items: { type: "string" } } }, required: ["keys"], additionalProperties: false },
    readOnly: true,
    run: (input) => guard(() => {
      const keys = list(input.keys);
      const gone = mem().drop(keys);
      const missing = keys.length - gone.length;
      return `${gone.length ? `Deleted ${gone.map((r) => r.key).join(", ")}.` : "Deleted nothing."}${missing ? ` ${missing} not found.` : ""}`;
    }),
  };

  const imp: Tool = {
    name: "helper__memory_import",
    description: "Turn a JSON or JSON-lines file (a labels list, contacts, accounts, a config's id-to-name map) into memory records once, without reading it into the conversation; later turns look the facts up by key. First call with only path: it shows the file's lists of objects, their size, fields and a sample. Then call with templates naming an item's fields in braces: key \"mail.label.{id}\", value \"{name}\", aliases [\"{name}\"], topics [\"mail\", \"labels\"]. Make the key from what the fact is asked by (a person's name, a label's id), not an opaque record id; put every other name it is asked by in aliases, and what an answer needs in the value (a value template leaves out fields an item lacks). items: the dotted path of the list (from the first call); \"x.*\" takes an object's values, its keys as {$key}.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        items: { type: "string" },
        key: { type: "string" },
        value: { type: "string" },
        aliases: { type: "array", items: { type: "string" } },
        topics: { type: "array", items: { type: "string" } },
        kind: { type: "string", enum: MEMORY_KINDS, description: "default reference" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    readOnly: true,
    run: (input, ctx) => guard(() => {
      const r = mem().importFile({ path: String(input.path ?? ""), cwd: ctx.cwd, items: input.items, key: input.key, value: input.value, aliases: list(input.aliases), topics: list(input.topics), kind: input.kind });
      if (r.shape) {
        if (!r.shape.length) return "No list of objects in that file.";
        return `Lists in the file:\n${r.shape.map((s) => `${s.path ? `items "${s.path}"` : "top level (leave items out)"}: ${s.count} objects, fields ${s.fields.join(", ")}\n  sample: ${JSON.stringify(s.sample).slice(0, 300)}`).join("\n")}\nCall again with key and value templates.`;
      }
      return `Imported ${r.written} records${r.skipped ? ` (${r.skipped} skipped: a field missing, or a value that looked like a secret)` : ""}. For example:\n${(r.sample ?? []).map(full).join("\n")}`;
    }),
  };

  return [get, find, put, drop, imp];
}

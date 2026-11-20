import { expect, test } from "bun:test";
import { candidates, fill, itemsAt, keyFor, normKey, normTerm, RecordIndex, shapes, type MemoryRecord } from "./records.ts";

const rec = (key: string, value: string, o: Partial<MemoryRecord> = {}): MemoryRecord => ({ key, value, kind: "fact", aliases: [], topics: [], source: "helper", ts: 0, updated: 0, used: 0, ...o });

test("keys and terms normalize to one spelling", () => {
  expect(normKey("  Mail.Label.Label_23 ")).toBe("mail.label.label_23");
  expect(normKey("person.Dana Levi")).toBe("person.dana-levi");
  expect(normKey("person..dana!!")).toBe("person.dana");
  expect(normKey("person.Zoë")).toBe("person.zoe");
  expect(normKey("אדם.דנה")).toBe("אדם.דנה");
  expect(normKey("...")).toBe("");
  expect(normTerm("  \"Finance/Receipts\" ")).toBe("finance/receipts");
  expect(normTerm("Tax   Office.")).toBe("tax office");
  expect(keyFor("preference", "Keep replies short, no hedging", () => false)).toBe("preference.keep-replies-short-hedging");
  expect(keyFor("fact", "x", (k) => k === "fact.item")).toBe("fact.item-2");
});

test("lookups: key, alias, the key's own last part, topic, namespace, words", () => {
  const ix = new RecordIndex([
    rec("mail.label.label_23", "Finance/Receipts", { kind: "reference", aliases: ["finance/receipts"], topics: ["mail", "labels"] }),
    rec("mail.label.label_31", "Clients/Acme", { kind: "reference", aliases: ["clients/acme"], topics: ["mail", "labels"] }),
    rec("person.dana-levi", "Dana Levi is the accountant; invoices go to her by the 5th", { kind: "person", aliases: ["dana", "dana@example.com", "accountant"], topics: ["finance"] }),
  ]);
  expect(ix.get("Mail.Label.Label_23")?.value).toBe("Finance/Receipts");
  expect(ix.resolve("Dana").record?.key).toBe("person.dana-levi");
  expect(ix.resolve("label_31").record?.key).toBe("mail.label.label_31"); // last part of the key
  expect(ix.resolve("dana levi").record?.key).toBe("person.dana-levi");
  expect(ix.byTopic("Labels").sort()).toEqual(["mail.label.label_23", "mail.label.label_31"]);
  expect(ix.byPrefix("mail.label.").length).toBe(2);
  expect(ix.byPrefix("mail.label.label_2")).toEqual(["mail.label.label_23"]);
  const f = ix.find("invoices accountant");
  expect(f.hits[0]?.key).toBe("person.dana-levi");
  expect(ix.find("labels").hits.map((h) => h.via)).toEqual(["topic", "topic"]);
  expect(ix.find("labels", 1)).toMatchObject({ total: 2, hits: [{ via: "topic" }] });
  // Removing a record removes its index entries.
  ix.remove("person.dana-levi");
  expect(ix.byAlias("dana")).toEqual([]);
  expect(ix.byTopic("finance")).toEqual([]);
  expect(ix.overview().spaces).toEqual([{ space: "mail", count: 2 }]);
  const many = new RecordIndex(["mail.label.a", "mail.label.b", "mail.label.c", "mail.filter.x", "person.a", "account.v.1", "account.w.2"].map((k) => rec(k, "v")));
  expect(many.overview().spaces).toEqual([{ space: "account", count: 2 }, { space: "mail", count: 4 }, { space: "mail.label", count: 3 }, { space: "person", count: 1 }]);
});

test("recall: named records first, reference data only when named, standing ones last, nothing twice, within budget", () => {
  const ix = new RecordIndex([
    rec("mail.label.label_23", "Finance/Receipts", { kind: "reference", topics: ["labels"] }),
    rec("mail.label.label_31", "Clients/Acme", { kind: "reference", topics: ["labels"] }),
    rec("person.dana-levi", "Dana is the accountant; invoices go to her", { kind: "person", aliases: ["dana"] }),
    rec("pref.replies", "Replies in short sentences, no hedging", { kind: "preference" }),
    rec("fact.router", "The office router is in the hallway closet"),
  ]);
  const r = ix.recall("Move the mail in Label_23 and send the invoices to the accountant", new Set(), 2000);
  expect(r.records.map((x) => x.key)).toEqual(["mail.label.label_23", "person.dana-levi", "pref.replies"]);
  // A topic named in the text is a hint with a count, not its values.
  expect(ix.recall("which labels do I have?", new Set(), 2000)).toMatchObject({ hints: ['topic "labels": 2 records (helper__memory_find)'] });
  expect(ix.recall("which labels do I have?", new Set(), 2000).records.map((x) => x.key)).toEqual(["pref.replies"]);
  expect(ix.recall("Send the invoices to Dana", new Set(["person.dana-levi", "pref.replies"]), 2000).records).toEqual([]);
  expect(ix.recall("Where is the router?", new Set(), 60).records.map((x) => x.key)).toEqual(["fact.router"]);
});

test("candidates keep ids whole and runs of words", () => {
  const c = candidates("Label_23, mail.label.label_31 and the Tax Office.");
  for (const x of ["Label_23", "mail.label.label_31", "tax office", "label_23"]) expect(c.has(x)).toBe(true);
});

test("import: a file's lists, items at a path, templates filled", () => {
  const doc = { labels: [{ id: "Label_23", name: "Finance/Receipts", type: "user" }, { id: "INBOX", name: "INBOX", type: "system" }], meta: { n: 2 } };
  expect(shapes(doc)).toEqual([{ path: "labels", count: 2, fields: ["id", "name", "type"], sample: { id: "Label_23", name: "Finance/Receipts", type: "user" } }]);
  const people = [{ names: [{ displayName: "Dana Levi" }], emails: [{ value: "dana@example.com" }], org: { title: "Accountant" } }, { names: [{ displayName: "Omer Tal" }] }];
  expect(shapes(people)[0]!.fields).toEqual(["names.0.displayName", "emails.0.value", "org.title"]);
  expect(fill("{names.0.displayName}, {org.title} ({emails.0.value})", people[0]!, false)).toBe("Dana Levi, Accountant (dana@example.com)");
  expect(fill("{names.0.displayName}, {org.title} ({emails.0.value})", people[1]!, false)).toBe("Omer Tal");
  expect(fill("{names.0.displayName} at {org.name}", people[1]!, false)).toBe("Omer Tal");
  expect(fill("{org.title}", people[1]!, false)).toBeUndefined();
  const byId = { a1: { name: "Acme" }, b2: { name: "Beta" }, c3: { name: "Gamma" } };
  expect(shapes(byId)[0]).toMatchObject({ path: "*", count: 3 });
  expect(itemsAt(byId, "*")?.map((x) => x.$key)).toEqual(["a1", "b2", "c3"]);
  const items = itemsAt(doc, "labels")!;
  expect(fill("mail.label.{id}", items[0]!)).toBe("mail.label.Label_23");
  expect(fill("{name} ({type})", items[1]!)).toBe("INBOX (system)");
  expect(fill("{missing}", items[0]!)).toBeUndefined();
  expect(fill("{meta.n}", doc as any)).toBe("2");
});

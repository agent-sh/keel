import { expect, test } from "bun:test";
import { candidates, fill, itemsAt, keyFor, normKey, normTerm, recallLine, RecordIndex, shapes, wordSet, type MemoryRecord } from "./records.ts";

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

// A corpus of thousands of records that share no word with what is asked:
// a lookup reads the few records its words and names lead to, and splits no
// record into words while answering (that happens once, when a record is set).
test("recall and word search stay sparse on a large corpus; edits and deletes show at once", () => {
  const list: MemoryRecord[] = [];
  for (let i = 0; i < 4000; i++) list.push(rec(`mail.label.label_${i}`, `Folder${i}x`, { kind: "reference", topics: ["labels"] }));
  for (let i = 0; i < 1000; i++) list.push(rec(`note.n${i}`, `quartz${i} basalt${i} shale${i}`, { topics: [`area${i % 50}`] }));
  list.push(rec("person.dana-levi", "Dana is the accountant; invoices go to her", { kind: "person", aliases: ["dana"] }));
  list.push(rec("pref.replies", "Replies in short sentences", { kind: "preference" }));
  const ix = new RecordIndex(list);
  expect(ix.work).toEqual({ records: 0, tokenized: list.length });
  const cost = <T>(run: () => T) => {
    const before = { ...ix.work };
    const out = run();
    return { out, records: ix.work.records - before.records, tokenized: ix.work.tokenized - before.tokenized };
  };

  // Recall by name: the named record, the one sharing a word, the standing one.
  const named = cost(() => ix.recall("Move the mail in Label_3141 and tell Dana about basalt77", new Set(), 2000));
  expect(named.out.records.map((r) => r.key)).toEqual(["mail.label.label_3141", "person.dana-levi", "note.n77", "pref.replies"]);
  expect(named).toMatchObject({ tokenized: 0 });
  expect(named.records).toBeLessThan(10);
  // Words only a few records hold.
  const words = cost(() => ix.find("quartz12 shale12"));
  expect(words.out.hits.map((h) => [h.key, h.via])).toEqual([["note.n12", "words"]]);
  expect(words).toMatchObject({ tokenized: 0 });
  expect(words.records).toBeLessThan(10);
  // A key prefix that is no namespace: one run of the sorted keys.
  const prefix = cost(() => ix.find("note.n99"));
  expect(prefix.out.hits.map((h) => h.key)).toEqual(["note.n99", "note.n990", "note.n991", "note.n992", "note.n993", "note.n994", "note.n995", "note.n996", "note.n997", "note.n998", "note.n999"]);
  expect(prefix.records).toBeLessThan(20);

  // An edit: the old words stop finding it and the new ones find it, at the cost of one record.
  const edit = cost(() => ix.set(rec("note.n12", "feldspar12 gneiss12", { updated: 5 })));
  expect(edit.tokenized).toBe(1);
  expect(ix.find("quartz12").total).toBe(0);
  expect(ix.find("gneiss12").hits.map((h) => h.key)).toEqual(["note.n12"]);
  expect(ix.recall("what about feldspar12?", new Set(), 2000).records.map((r) => r.key)).toEqual(["note.n12", "pref.replies"]);
  // A record that became reference data is recalled by name only, and found by its words still.
  ix.set(rec("note.n12", "feldspar12 gneiss12", { kind: "reference" }));
  expect(ix.recall("what about feldspar12?", new Set(), 2000).records.map((r) => r.key)).toEqual(["pref.replies"]);
  expect(ix.find("feldspar12").total).toBe(1);
  // A delete: gone from the word search, the prefix, the recall and the standing ones.
  ix.remove("note.n12");
  ix.remove("pref.replies");
  expect(ix.find("feldspar12").total).toBe(0);
  expect(ix.find("note.n12").hits.map((h) => h.key).slice(0, 2)).toEqual(["note.n120", "note.n121"]);
  expect(ix.recall("what about feldspar12 and n12?", new Set(), 2000).records).toEqual([]);
});

// The lookups read postings; what they return is what a walk over every
// record returns (the rule the index was written from), ties included.
test("the indexed search and recall answer as a walk over every record does", () => {
  const scanFind = (all: MemoryRecord[], q: string) => {
    const want = [...wordSet(q)];
    const scored: { key: string; n: number; u: number }[] = [];
    for (const r of all) {
      const have = wordSet(`${r.key.replace(/[._-]+/g, " ")} ${r.aliases.join(" ")} ${r.topics.join(" ")} ${r.value}`);
      const n = want.filter((w) => have.has(w)).length;
      if (n) scored.push({ key: r.key, n, u: r.updated });
    }
    const best = Math.max(0, ...scored.map((s) => s.n));
    return scored.filter((s) => s.n === best || (best < want.length && s.n >= Math.max(1, best - 1))).sort((a, b) => b.n - a.n || b.u - a.u).map((s) => s.key);
  };
  const scanRecall = (ix: RecordIndex, all: MemoryRecord[], text: string, seen: Set<string>, budget: number) => {
    const named: string[] = [];
    for (const c of candidates(text)) {
      if (ix.byKey.has(normKey(c))) named.push(normKey(c));
      named.push(...ix.byAlias(c));
    }
    const named1 = [...new Set(named)];
    const q = wordSet(text);
    const scored: { r: MemoryRecord; rank: number; hits: number }[] = [];
    for (const r of all) {
      if (seen.has(r.key)) continue;
      const at = named1.indexOf(r.key);
      if (at >= 0) { scored.push({ r, rank: 3, hits: named1.length - at }); continue; }
      if (r.kind === "reference") continue;
      let hits = 0;
      for (const w of wordSet(`${r.value} ${r.aliases.join(" ")} ${r.key.replace(/[._-]+/g, " ")}`)) if (q.has(w)) hits++;
      if (hits) scored.push({ r, rank: 2, hits });
      else if (r.kind === "preference" || r.kind === "commitment") scored.push({ r, rank: 1, hits: 0 });
    }
    scored.sort((a, b) => b.rank - a.rank || b.hits - a.hits || b.r.updated - a.r.updated);
    const out: string[] = [];
    let used = 0;
    for (const { r } of scored) {
      const n = recallLine(r).length + 1;
      if (used + n > budget) continue;
      out.push(r.key);
      used += n;
    }
    return out;
  };
  // A fixed sequence, so a failure repeats.
  let state = 7;
  const next = (n: number) => ((state = (Math.imul(state, 1103515245) + 12345) & 0x7fffffff) >>> 8) % n;
  const vocab = ["invoice", "router", "accountant", "deadline", "label", "office", "report", "budget", "train", "garden", "piano", "harbor"];
  const kinds = ["fact", "reference", "preference", "person", "commitment", "decision"] as const;
  const pick = (n: number) => Array.from({ length: n }, () => vocab[next(vocab.length)]!).join(" ");
  const make = (i: number): MemoryRecord => rec(`${["a", "b", "mail.label"][next(3)]}.k${i}`, pick(1 + next(4)), { kind: kinds[next(kinds.length)]!, aliases: next(3) ? [] : [vocab[next(vocab.length)]!], topics: next(2) ? [] : [vocab[next(vocab.length)]!], updated: next(3) });
  const ix = new RecordIndex(Array.from({ length: 300 }, (_, i) => make(i)));
  // Records set again (they move to the end of the order), removed and added.
  for (let i = 0; i < 120; i++) {
    const key = [...ix.byKey.keys()][next(ix.size)]!;
    if (next(3) === 0) ix.remove(key);
    else ix.set({ ...make(1000 + i), key });
    if (next(4) === 0) ix.set(make(2000 + i));
  }
  for (let i = 0; i < 200; i++) {
    const all = ix.all(); // in the order the records were set
    const q = pick(1 + next(3));
    // The word search is what find falls back to: asked for directly here.
    const direct = ix.find(q, 1000);
    if (direct.hits.every((h) => h.via === "words")) expect(direct.hits.map((h) => h.key)).toEqual(scanFind(all, q));
    const seen = new Set(all.filter(() => next(5) === 0).map((r) => r.key));
    const text = `${pick(2 + next(4))} ${all[next(all.length)]!.key}`;
    const budget = [60, 400, 2000][next(3)]!;
    expect(ix.recall(text, seen, budget).records.map((r) => r.key)).toEqual(scanRecall(ix, all, text, seen, budget));
    const p = `${["a", "b", "mail"][next(3)]}.k${next(10)}`;
    expect(ix.byPrefix(p)).toEqual(all.map((r) => r.key).filter((k) => k.startsWith(normKey(p))));
  }
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

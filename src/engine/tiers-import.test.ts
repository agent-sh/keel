import { expect, test } from "bun:test";
import { modelWords, oneRoute } from "./tiers-import.ts";

// Made-up listings: nothing here is a real model.
const LISTED = [
  { id: "acme:acme-zephyr-2", model: "acme-zephyr-2", name: "Acme Zephyr 2 preview", provider: "acme", family: "acme" },
  { id: "acme:acme-quill-1", model: "acme-quill-1", name: "Acme Quill 1 preview", provider: "acme", family: "acme" },
  { id: "bolt:bolt-ember", model: "bolt-ember", name: "Bolt Ember preview", provider: "bolt", family: "boltfam" },
  { id: "bolt:bolt-sprout", model: "bolt-sprout", name: "Bolt Sprout", provider: "bolt", family: "boltfam" },
];

test("the words to ignore come from the listing: its providers, families and the words most models share", () => {
  const w = modelWords(LISTED);
  expect([...w].sort()).toEqual(["ember", "quill", "sprout", "zephyr"]);
  // A provider or family no fixed list knows is ignored too.
  expect(modelWords([{ id: "zork:zork-alpha", model: "zork-alpha", name: "Zork Alpha", provider: "zork", family: "zorkish" }]).has("zork")).toBe(false);
});

test("one request carries the newest session's folder rule and folders with none, never another rule's words", () => {
  const words = modelWords(LISTED);
  const only = (p: string[]) => ({ providers: p });
  const said = [
    { text: "use zephyr for most work", session: "s1", route: only(["acme"]) },
    { text: "nothing about models here", session: "s2", route: null },
    { text: "quill for the readers, effort low", session: "s3", route: null },
    { text: "ember for research", session: "s4", route: only(["bolt"]) },
    { text: "sprout for the simplest", session: "s5", route: only(["acme"]) },
  ];
  expect(oneRoute(said, words)).toEqual({ at: "s1", texts: ["use zephyr for most work", "quill for the readers, effort low", "sprout for the simplest"] });
  expect(oneRoute(said.slice(1, 2), words)).toBeUndefined();
});

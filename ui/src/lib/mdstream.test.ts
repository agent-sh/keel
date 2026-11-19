import { expect, test } from "bun:test";
import { finishedLength, mend } from "./mdstream.ts";

test("mend closes what a half-written block left open", () => {
  expect(mend("This is **bold")).toBe("This is **bold**");
  expect(mend("This is **")).toBe("This is ");
  expect(mend("Run `bun te")).toBe("Run `bun te`");
  expect(mend("See [the spec](https://spec.common")).toBe("See the spec");
  expect(mend("See [the sp")).toBe("See the sp");
  expect(mend("Old ~~way")).toBe("Old ~~way~~");
  expect(mend("A `**` mark")).toBe("A `**` mark");
  expect(mend("Done **bold** and `code`.")).toBe("Done **bold** and `code`.");
  expect(mend("```ts\nconst a = `x")).toBe("```ts\nconst a = `x");
});

test("only blocks before the last one with text are finished", () => {
  const t = (type: string, raw: string) => ({ type, raw });
  expect(finishedLength([t("paragraph", "a\n"), t("space", "\n"), t("list", "- b\n")])).toEqual({ done: 3, count: 2 });
  expect(finishedLength([t("paragraph", "a\n"), t("space", "\n\n")])).toEqual({ done: 0, count: 0 });
  expect(finishedLength([])).toEqual({ done: 0, count: 0 });
});

import { expect, test } from "bun:test";
import { CHECK_FIRST, STOPPED_WHILE, STOPPED_WHILE_CHANGING, quietEnd, stopKind, stoppedByUser, stoppedByWords, stoppedRunning, stoppedWhile } from "./stops.ts";

test("a stop that reaches a call that changes things says to check first; a read's stop does not", () => {
  expect(stoppedWhile("owner")).toBe(STOPPED_WHILE);
  expect(stoppedWhile("owner", true)).toBe(STOPPED_WHILE_CHANGING);
  expect(STOPPED_WHILE_CHANGING).toContain("check its effects before running it again");
  expect(stoppedWhile("api", true)).toBe(`${stoppedWhile("api")}${CHECK_FIRST}`);
  expect(stoppedWhile("api")).not.toContain("check");
});

test("the page still reads the new words as a stop that reached the call, by whoever made it", () => {
  for (const by of [undefined, "owner", "api", "parent"]) {
    const plain = stoppedWhile(by);
    const checked = stoppedWhile(by, true);
    expect(stopKind(checked)).toBe("stopped");
    expect(stoppedRunning(checked)).toBe(true);
    expect(stoppedByUser(checked)).toBe(stoppedByUser(plain));
    expect(stoppedByWords(checked)).toBe(stoppedByWords(plain));
    expect(quietEnd(checked)).toBe(quietEnd(plain));
  }
  expect(stoppedByWords(stoppedWhile("api", true))).not.toContain("check");
});

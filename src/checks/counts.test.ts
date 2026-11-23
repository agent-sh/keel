import { expect, test } from "bun:test";
import { countsOf } from "./counts.ts";

test("the summaries test tools, typecheckers and linters print", () => {
  expect(countsOf("src/a.test.ts:\n(pass) a\n\n 37 pass\n 2 fail\n 80 expect() calls\nRan 39 tests across 4 files. [1.2s]\n")).toEqual({ pass: 37, fail: 2 });
  expect(countsOf(" 12 pass\n 0 fail\n")).toEqual({ pass: 12, fail: 0 });
  expect(countsOf("Test Suites: 1 failed, 3 passed, 4 total\nTests:       2 failed, 1 skipped, 40 passed, 43 total\n")).toEqual({ pass: 40, fail: 2 });
  expect(countsOf(" Test Files  1 failed | 3 passed (4)\n      Tests  2 failed | 40 passed (42)\n")).toEqual({ pass: 40, fail: 2 });
  expect(countsOf("===== 2 failed, 40 passed, 1 error in 1.23s =====\n")).toEqual({ pass: 40, fail: 3 });
  expect(countsOf("====== 40 passed in 0.50s ======\n")).toEqual({ pass: 40, fail: 0 });
  expect(countsOf("test result: ok. 10 passed; 0 failed; 0 ignored\n...\ntest result: FAILED. 3 passed; 1 failed; 0 ignored\n")).toEqual({ pass: 13, fail: 1 });
  expect(countsOf("ok  \texample.com/a\t0.12s\nFAIL\texample.com/b\t0.30s\nok  \texample.com/c\t(cached)\n")).toEqual({ pass: 2, fail: 1 });
  expect(countsOf("Running 42 tests using 4 workers\n\n  2 failed\n    [chromium] a.spec.ts\n  40 passed (1.2m)\n")).toEqual({ pass: 40, fail: 2 });
  expect(countsOf("  40 passing (2s)\n  2 failing\n")).toEqual({ pass: 40, fail: 2 });
  expect(countsOf("src/a.ts(3,1): error TS2304\n\nFound 3 errors in 2 files.\n")).toEqual({ fail: 3 });
  expect(countsOf("\n✖ 5 problems (3 errors, 2 warnings)\n")).toEqual({ fail: 3 });
});

test("colors are read through, the last summary wins, and a log with none has no counts", () => {
  expect(countsOf("\x1b[32m 5 pass\x1b[0m\n\x1b[31m 1 fail\x1b[0m\n")).toEqual({ pass: 5, fail: 1 });
  expect(countsOf(" 5 pass\n 1 fail\n...\n 6 pass\n 0 fail\n")).toEqual({ pass: 6, fail: 0 });
  expect(countsOf("built in 2.1s\n")).toBeUndefined();
});

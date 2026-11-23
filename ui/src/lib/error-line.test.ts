import { expect, test } from "bun:test";
import { errorLine } from "./error-line.ts";

const at = (text: string) => { const lines = text.split("\n"); const i = errorLine(lines); return i < 0 ? null : lines[i]!.trim(); };

test("a node test's assertion, not the source line that throws it", () => {
  const out = [
    "> app@1.0.0 test", "> node test.js", "", "node:assert:126", "  throw new AssertionError(obj);", "  ^", "",
    "AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:", "", "7 !== 8", "",
    "    at Object.<anonymous> (/w/test.js:2:8)", "  code: 'ERR_ASSERTION',", "}", "", "Node.js v26.13.0",
  ].join("\n");
  expect(at(out)).toBe("AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:");
});

test("compilers, package managers and test runners say it their own way", () => {
  expect(at("Compiling x v0.1.0\nerror[E0308]: mismatched types\n --> src/main.rs:2:5")).toBe("error[E0308]: mismatched types");
  expect(at("src/a.ts(1,7): error TS2322: Type 'number' is not assignable")).toBe("src/a.ts(1,7): error TS2322: Type 'number' is not assignable");
  expect(at("a.c: In function 'main':\na.c:3:5: error: expected ';' before '}' token")).toBe("a.c:3:5: error: expected ';' before '}' token");
  expect(at("npm ERR! code ENOENT\nnpm ERR! syscall open")).toBe("npm ERR! code ENOENT");
  expect(at("test_a.py F\n    def test_a():\n>       assert 7 == 8\nE       assert 7 == 8\n")).toBe("E       assert 7 == 8");
  expect(at("Traceback (most recent call last):\n  File \"a.py\", line 1, in <module>\nValueError: bad")).toBe("ValueError: bad");
});

test("a line said outright comes before a word of failure above it, and a count of none is not one", () => {
  expect(at("bun test v1\n✗ reports each part once\n  error: expect(received).toEqual(expected)\n 1 fail")).toBe("error: expect(received).toEqual(expected)");
  expect(at("0 errors, 0 failed\nrm: cannot remove x: No such file")).toBe("rm: cannot remove x: No such file");
  expect(at("all good\nnothing here")).toBeNull();
});

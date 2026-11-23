import { expect, test } from "bun:test";
import { newTypedCode, TYPED_ALPHABET, TYPED_BITS, typedCodeOf, typedShown } from "./typed-code.ts";

test("a typed code reads the same however it is typed, and nothing else reads as one", () => {
  expect(TYPED_ALPHABET.length).toBe(32);
  expect(TYPED_BITS).toBe(40);
  const code = newTypedCode();
  expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
  expect(typedCodeOf(typedShown(code))).toBe(code);
  // Case, spaces and dashes do not matter; O reads as 0, I and L as 1.
  expect(typedCodeOf("abcd-efgh")).toBe("ABCDEFGH");
  expect(typedCodeOf(" 7k2o 9ilz ")).toBe("7K20911Z");
  // U is not in the alphabet, a wrong length is not a code, nor is a link's code.
  expect(typedCodeOf("ABCD-EFGU")).toBeNull();
  expect(typedCodeOf("ABCD-EFG")).toBeNull();
  expect(typedCodeOf("a".repeat(36))).toBeNull();
});

import { expect, test } from "bun:test";
import { contains } from "./paths.ts";

test("contains: root, children, siblings, parents", () => {
  expect(contains("/w", "/w")).toBe(true);
  expect(contains("/w", "/w/a/b")).toBe(true);
  expect(contains("/w", "/w/..foo")).toBe(true);
  expect(contains("/w", "/wx")).toBe(false);
  expect(contains("/w", "/")).toBe(false);
  expect(contains("/w/a", "/w/b")).toBe(false);
  expect(contains("/", "/anything")).toBe(true);
});

import { expect, test } from "bun:test";
import { homedir, tmpdir } from "node:os";
import { dirname } from "node:path";
import { contains, homeDir } from "./paths.ts";

test("contains: root, children, siblings, parents", () => {
  expect(contains("/w", "/w")).toBe(true);
  expect(contains("/w", "/w/a/b")).toBe(true);
  expect(contains("/w", "/w/..foo")).toBe(true);
  expect(contains("/w", "/wx")).toBe(false);
  expect(contains("/w", "/")).toBe(false);
  expect(contains("/w/a", "/w/b")).toBe(false);
  expect(contains("/", "/anything")).toBe(true);
});

test("homeDir reads HOME as it is now, not as the process started", () => {
  const before = process.env.HOME;
  try {
    process.env.HOME = "/scratch/one";
    expect(homeDir()).toBe("/scratch/one");
    process.env.HOME = "/scratch/two";
    expect(homeDir()).toBe("/scratch/two");
    // A relative HOME is not a home: the account's is used.
    process.env.HOME = "relative/home";
    expect(homeDir()).toBe(homedir());
  } finally {
    if (before === undefined) delete process.env.HOME; else process.env.HOME = before;
  }
});

test("the preload gives every test a scratch home", () => {
  expect(homeDir()).toBe(process.env.HOME!);
  expect(homeDir().startsWith(dirname(tmpdir()))).toBe(true); // the run's folder, which holds the scratch home and its TMPDIR
});

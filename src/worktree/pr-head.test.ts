import { expect, test } from "bun:test";
import { hostOfRemote, hostKind, parsePr, prRef, prTarget } from "./pr-head.ts";

test("a pull request is named by its number or its address", () => {
  expect(parsePr("7")).toEqual({ number: 7 });
  expect(parsePr(" #12 ")).toEqual({ number: 12 });
  expect(parsePr(9)).toEqual({ number: 9 });
  expect(parsePr("https://github.com/agent-sh/keel/pull/42")).toEqual({ number: 42, host: "github", at: "github.com" });
  expect(parsePr("https://github.com/agent-sh/keel/pull/42/files#diff")).toEqual({ number: 42, host: "github", at: "github.com" });
  expect(parsePr("https://gitlab.example.org/group/sub/proj/-/merge_requests/5")).toEqual({ number: 5, host: "gitlab", at: "gitlab.example.org" });
  for (const bad of ["", "0", "-3", "7x", "https://github.com/agent-sh/keel", "https://github.com/agent-sh/keel/issues/3", "ftp://h/o/r/pull/1", "main"]) expect("error" in parsePr(bad)).toBe(true);
});

test("the ref is the host's: pull on GitHub, merge-requests on GitLab", () => {
  expect(prRef("github", 7)).toBe("refs/pull/7/head");
  expect(prRef("gitlab", 7)).toBe("refs/merge-requests/7/head");
  expect(hostOfRemote("git@gitlab.com:g/p.git")).toBe("gitlab.com");
  expect(hostOfRemote("ssh://git@GitHub.com/o/r.git")).toBe("github.com");
  expect(hostOfRemote("https://gitlab.example.org/g/p")).toBe("gitlab.example.org");
  expect(hostOfRemote("/srv/git/r.git")).toBeUndefined();
  expect(hostOfRemote("file:///srv/git/r.git")).toBeUndefined();
  expect(hostKind("gitlab.com")).toBe("gitlab");
  expect(hostKind("code.gitlab.example.org")).toBe("gitlab");
  expect(hostKind("github.com")).toBe("github");
  expect(hostKind("git.example.org")).toBe("github");
  expect(hostKind(undefined)).toBe("github");
});

test("the origin's host picks the layout unless the address names it, and an address of another host is refused", () => {
  expect(prTarget("7", "https://github.com/o/r.git")).toEqual({ number: 7, host: "github", ref: "refs/pull/7/head" });
  expect(prTarget("7", "git@gitlab.com:g/p.git")).toEqual({ number: 7, host: "gitlab", ref: "refs/merge-requests/7/head" });
  expect(prTarget("7", "/srv/git/origin.git")).toEqual({ number: 7, host: "github", ref: "refs/pull/7/head" });
  // A self-hosted GitLab whose name does not say so: its address does.
  expect(prTarget("https://git.corp.example/g/p/-/merge_requests/3", "https://git.corp.example/g/p.git")).toEqual({ number: 3, host: "gitlab", ref: "refs/merge-requests/3/head" });
  expect(prTarget("https://github.com/o/r/pull/3", "https://gitlab.com/o/r.git")).toMatchObject({ error: expect.stringContaining("not the host of origin") });
  expect(prTarget("nope", "https://github.com/o/r.git")).toMatchObject({ error: expect.any(String) });
});

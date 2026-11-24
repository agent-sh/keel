// Who wrote a pull request's head, and whether that is enough to read its files as the repository's own.
import { expect, test } from "bun:test";
import { ownEnv } from "../../test/env.ts";
import { judge, whoWroteHead, type Run } from "./head-trust.ts";

test("the head is trusted for a branch of the repository, the owner's own request, or a writer; else held", () => {
  expect(judge({ known: true, author: "a", fork: false }).trusted).toBe(true);
  expect(judge({ known: true, author: "Me", fork: true, viewer: "me" }).trusted).toBe(true);
  for (const permission of ["write", "maintain", "admin"]) expect(judge({ known: true, author: "a", fork: true, permission }).trusted).toBe(true);
  for (const permission of ["read", "triage", "none", undefined]) expect(judge({ known: true, author: "a", fork: true, permission }).trusted).toBe(false);
  expect(judge({ known: true, author: "a" }).trusted).toBe(false);
  expect(judge({ known: false }).trusted).toBe(false);
});

// A host's tool that answers from a table of its arguments.
const table = (answers: Record<string, unknown>): Run & { asked: string[] } => {
  const asked: string[] = [];
  const run: Run = async (_bin, args) => {
    const key = args.slice(0, 2).join(" ");
    asked.push(args.join(" "));
    const a = answers[key];
    return a === undefined ? { code: 1, out: "" } : { code: 0, out: JSON.stringify(a) };
  };
  return Object.assign(run, { asked });
};
const ask = (run: Run, host: "github" | "gitlab") => whoWroteHead(run, { host, named: "7", cwd: "/", origin: "https://example.org/o/r", hasHost: true });

test("GitHub: a fork's author is looked up for write access, a login that is not one is never put in a path", async () => {
  const pr = { author: { login: "dev" }, isCrossRepository: true, baseRefName: "main", url: "https://github.com/o/r/pull/7" };
  const run = table({ "pr view": pr, "api repos/o/r/collaborators/dev/permission": { role_name: "write" }, "api user": { login: "me" } });
  expect(await ask(run, "github")).toMatchObject({ known: true, fork: true, author: "dev", baseRef: "main" });
  const keyed = (r: Run) => (r as any).asked as string[];
  expect(keyed(run).some((a) => a === "api repos/o/r/collaborators/dev/permission")).toBe(true);
  const bad = table({ "pr view": { ...pr, author: { login: "../../x" } } });
  expect((await ask(bad, "github")).known).toBe(false);
  expect(keyed(bad)).toHaveLength(1);
});

test("GitLab: a merge request from another project is a fork, and an access level of 30 writes", async () => {
  const mr = { author: { username: "dev", id: 5 }, source_project_id: 9, target_project_id: 1, target_branch: "main" };
  const run = table({ "mr view": mr, "api projects/1/members/all/5": { access_level: 30 }, "api user": { username: "me" } });
  expect(await ask(run, "gitlab")).toMatchObject({ known: true, fork: true, permission: "write", viewer: "me" });
  expect(await ask(table({ "mr view": { ...mr, source_project_id: 1 } }), "gitlab")).toMatchObject({ known: true, fork: false });
  expect((await ask(table({}), "gitlab")).known).toBe(false);
});

test("a folder on this machine is no host to ask, unless a stand-in tool is named", async () => {
  ownEnv({ KEEL_GH_BIN: undefined, KEEL_GLAB_BIN: undefined });
  const run = table({});
  const w = await whoWroteHead(run, { host: "github", named: "7", cwd: "/", origin: "/srv/o.git", hasHost: false });
  expect(w.known).toBe(false);
  expect(run.asked).toEqual([]);
});

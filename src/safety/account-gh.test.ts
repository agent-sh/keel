// The owner's GitHub sign-in as a source of namespaces: the login and the organizations it administers, reads only, asked
// only at his press, and nothing is added by them.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADMIN_ORGS, ghAdminOrgs, ghLogin, ghOwnLogin, learnFromGh, type GhRun } from "./account-learn.ts";

// (What gh prints for the filter over every page: a login a line.)
const orgs = "Acme\nsecond-page-org\nbad name\n\n";

test("the login and the organizations the sign-in administers are read from GitHub's answers", () => {
  expect(ghLogin('{"login":"me","id":1}')).toBe("me");
  expect(ghLogin('{"login":"a b"}')).toBeNull();
  expect(ghLogin("not json")).toBeNull();
  expect(ghAdminOrgs(orgs)).toEqual(["Acme", "second-page-org"]);
  expect(ghAdminOrgs("")).toEqual([]);
  // The filter keeps an active membership with the admin role, on every page.
  expect(ADMIN_ORGS).toContain('.state == "active"');
  expect(ADMIN_ORGS).toContain('.role == "admin"');
});

const home = () => {
  const dir = mkdtempSync(join(tmpdir(), "gh-learn-"));
  mkdirSync(join(dir, "gh"));
  return dir;
};

test("reads only, each naming its host, every page of the memberships; nothing asked when gh is signed in nowhere, an error is told", async () => {
  const dir = home();
  const calls: string[][] = [];
  const run: GhRun = async (args) => {
    calls.push(args);
    return args.includes("user") ? { out: '{"login":"Me"}' } : { out: orgs };
  };
  // No sign-in: GitHub is not asked.
  expect(await learnFromGh(dir, { GH_CONFIG_DIR: join(dir, "gh") }, run)).toEqual({ candidates: [], note: expect.stringContaining("not signed in") });
  expect(calls).toEqual([]);
  writeFileSync(join(dir, "gh", "hosts.yml"), "github.com:\n    user: Me\n    oauth_token: x\n");
  const r = await learnFromGh(dir, { GH_CONFIG_DIR: join(dir, "gh") }, run);
  expect(r.candidates.map((c) => c.namespace)).toEqual(["github.com/me", "github.com/acme", "github.com/second-page-org"]);
  expect(r.candidates[1]!.why).toContain("administers");
  // Reads only (no method, no field, no input), each naming its host, the memberships read to their last page.
  expect(calls).toEqual([["api", "--hostname", "github.com", "user"], ["api", "--hostname", "github.com", "--paginate", "user/memberships/orgs?state=active&per_page=100", "--jq", ADMIN_ORGS]]);
  for (const c of calls) expect(c.some((a) => /^(-X|--method|-f|-F|--field|--input)/.test(a))).toBe(false);
  // A GH_HOST in the environment moves no read: gh is told the host each time, and is started without the variable.
  calls.length = 0;
  await learnFromGh(dir, { GH_CONFIG_DIR: join(dir, "gh"), GH_HOST: "elsewhere.example" }, run);
  expect(calls.every((c) => c[1] === "--hostname" && c[2] === "github.com")).toBe(true);
  // The account gh is signed in as is a personal account, by the file alone; an organization or another host's is not.
  expect(ghOwnLogin("me", dir, { GH_CONFIG_DIR: join(dir, "gh") })).toBe(true);
  expect(ghOwnLogin("github.com/Me", dir, { GH_CONFIG_DIR: join(dir, "gh") })).toBe(true);
  expect(ghOwnLogin("acme", dir, { GH_CONFIG_DIR: join(dir, "gh") })).toBe(false);
  expect(ghOwnLogin("gitlab.com/me", dir, { GH_CONFIG_DIR: join(dir, "gh") })).toBe(false);
  expect(ghOwnLogin("npm:@me", dir, { GH_CONFIG_DIR: join(dir, "gh") })).toBe(false);
  // A failure is said, not hidden.
  const failing = await learnFromGh(dir, { GH_CONFIG_DIR: join(dir, "gh") }, async () => ({ error: "HTTP 401" }));
  expect(failing.candidates).toEqual([]);
  expect(failing.note).toContain("HTTP 401");
});

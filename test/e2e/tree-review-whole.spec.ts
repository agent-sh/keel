import { expect, test } from "./isolate.ts";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HAIKU, ask } from "./shots.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });

// Feature: the whole-tree landing decision (area "*") holds every line an area's does. Five agents leave a branch:
// a and b each add a file in an area of their own, c and d change line 3 of one file (d would conflict with c),
// e adds a file in a fourth area. The owner sends e back, and a branch the tree does not hold is made in the
// repository. Then: no confirm refuses the set that holds d, whether the list is absent or empty (it means every
// branch that can land, not the safe ones); a list naming e (sent back), the outsider, a name no branch has and
// a branch of the page's earlier view lands only the ones that are in the tree and can land; a branch already
// queued is queued once; and each area records the decision only when one of its branches was queued.
test("the whole-tree landing decision queues only what an area's would, and asks the same confirm", async ({ request }) => {
  test.setTimeout(240_000);
  await request.put("/api/permissions/settings", { data: { default_mode: "full-auto" } });
  const repo = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `tree-whole-${Date.now()}`, "repo");
  mkdirSync(join(repo, "src/shared"), { recursive: true });
  mkdirSync(join(repo, ".keel"));
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "src/shared/rules.ts"), Array.from({ length: 10 }, (_, i) => `export const rule${i + 1} = ${i + 1};`).join("\n") + "\n");
  writeFileSync(join(repo, "check.sh"), "echo checking; test -f src/shared/rules.ts\n");
  writeFileSync(join(repo, ".keel/checks.json"), JSON.stringify({ checks: { files: "sh check.sh" }, land: { checks: ["files"] } }));
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  const calls = (list: unknown[]) => `script:calls ${JSON.stringify(list)}`;
  const commit = (msg: string) => `git add -A && git -c user.name=k -c user.email=k@k commit -qm '${msg}'`;
  const lane = (title: string, command: string) => ({ name: "spawn_agent", input: { message: `${title}\n${calls([{ name: "Bash", input: { command } }])}` } });
  const adds = (dir: string) => `mkdir -p src/${dir} && printf 'export const ${dir} = 1;\\n' > src/${dir}/${dir}.ts`;
  const coord = (await (await request.post("/api/sessions", { data: { model: HAIKU, workspace: repo, title: "Coordinator" } })).json()).session.id as string;
  await request.post(`/api/sessions/${coord}/messages`, { data: { text: ask("Start five agents.", `script:batch ${JSON.stringify([
    lane("Lane a", `${adds("aaa")} && ${commit("Lane a")}`),
    lane("Lane b", `${adds("bbb")} && ${commit("Lane b")}`),
    lane("Lane c", `sed -i 's/rule3 = 3/rule3 = 30/' src/shared/rules.ts && ${commit("Lane c")}`),
    lane("Lane d", `sed -i 's/rule3 = 3/rule3 = 300/' src/shared/rules.ts && ${commit("Lane d")}`),
    lane("Lane e", `${adds("eee")} && ${commit("Lane e")}`),
  ])}`) } });
  const agentsOf = async () => (await (await request.get(`/api/sessions/${coord}/agents`)).json()).agents as any[];
  await expect.poll(async () => (await agentsOf()).filter((a) => a.status === "completed" && a.branch).length, { timeout: 90_000 }).toBe(5);
  const by = async (title: string) => (await agentsOf()).find((a) => a.title === title)!;
  const [a, b, c, d, e] = [await by("Lane a"), await by("Lane b"), await by("Lane c"), await by("Lane d"), await by("Lane e")];
  git(repo, "branch", "keel/outsider", "main");
  const entries = async () => ((await (await request.get(`/api/sessions/${coord}/landing`)).json()).entries as any[]).map((x) => x.branch).sort();
  const view = async () => (await (await request.get(`/api/sessions/${coord}/tree-review?fresh=1`)).json()) as any;
  const whole = (data: object) => request.post(`/api/sessions/${coord}/tree-review/decide`, { data: { area: "*", action: "land", ...data } });
  // What the decision's own answer shows (read before the queue lands the branches, which leave the tree).
  const decided = (v: any, key: string) => (v.areas as any[]).find((x) => x.key === key)?.decisions.filter((x: any) => x.action === "land").map((x: any) => x.branch).sort() ?? [];

  // The owner sends e back: it is held in every area it is in.
  const back = await request.post(`/api/sessions/${coord}/tree-review/decide`, { data: { area: "src/eee", action: "back", note: "Not this one.", agents: [e.id] } });
  expect(back.status()).toBe(200);

  // Only landing takes the whole tree.
  for (const action of ["back", "drop", "undo"]) expect((await request.post(`/api/sessions/${coord}/tree-review/decide`, { data: { area: "*", action } })).status()).toBe(404);

  // No confirm: refused with the branch that conflicts named, for no list and for an empty one (every branch that
  // can land, not the safe ones), and nothing is queued.
  for (const data of [{}, { branches: [] }, { branches: [a.branch, c.branch, d.branch] }]) {
    const r = await whole(data);
    expect(r.status()).toBe(409);
    expect(await r.json()).toMatchObject({ needs_confirm: true, would_conflict: [d.branch] });
  }
  expect(await entries()).toEqual([]);

  // A list of what the page saw: the sent-back branch, one the tree does not hold, a name no branch has and a
  // repeated one. Only a and c are queued (d, the one that would conflict, is not named).
  const some = await whole({ branches: [e.branch, "keel/outsider", "keel/no-such-branch", a.branch, a.branch, c.branch] });
  expect(some.status()).toBe(200);
  const body = await some.json();
  expect(body.queued.map((x: any) => x.branch).sort()).toEqual([a.branch, c.branch].sort());
  await expect.poll(entries, { timeout: 30_000 }).toEqual([a.branch, c.branch].sort());
  // The areas of what was queued record it; the sent-back area and the one with nothing queued do not.
  expect(decided(body.view, "src/aaa")).toEqual([a.branch]);
  expect(decided(body.view, "src/shared")).toEqual([c.branch]);
  expect(decided(body.view, "src/bbb")).toEqual([]);
  expect(decided(body.view, "src/eee")).toEqual([]);

  // Naming only what is held or not in the tree queues nothing.
  const none = await whole({ branches: [e.branch, "keel/outsider", "keel/no-such-branch"], confirmed: true });
  expect(none.status()).toBe(409);
  expect((await none.json()).error).toContain("nothing to land");

  // With the confirm and no list: every branch that can land and is not queued, b and d here (a and c may have
  // landed by now and left the tree), never e (sent back) or the outsider; no branch is queued twice.
  const all = await whole({ confirmed: true });
  expect(all.status()).toBe(200);
  const rest = await all.json();
  const queued = (rest.queued as any[]).map((x) => x.branch);
  expect(queued).toEqual(expect.arrayContaining([b.branch, d.branch]));
  expect(queued).not.toContain(e.branch);
  expect(queued).not.toContain("keel/outsider");
  expect(decided(rest.view, "src/bbb")).toEqual([b.branch]);
  expect(decided(rest.view, "src/eee")).toEqual([]);
  const l = await entries();
  expect(new Set(l).size).toBe(l.length);
  expect(l).not.toContain(e.branch);
  expect(l).not.toContain("keel/outsider");
});

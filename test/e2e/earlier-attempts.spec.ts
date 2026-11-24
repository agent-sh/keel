import { expect, test } from "./isolate.ts";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SCRIPTED } from "./shots.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();

// Feature: earlier attempts at a spawn. A coordinator's repository has three earlier agents: one landed its
// branch, one was refused by a reviewer's structured verdict, one worked on something else. A new agent started
// on the first two's subject gets its spawn's result with the two, each with its outcome (the refusal with the
// reviewer's first sentence), its branch and head and the first line of its report, and not the third. An agent
// on a subject nobody worked on gets no lines. The lines ride the result once and come from Keel's facts: no
// model request.
test("a spawn names the closest earlier agents of the repository with how each ended", async ({ request }) => {
  test.setTimeout(240_000);
  test.skip(!SCRIPTED, "needs the scripted stand-in: the agents' commits and a reviewer's verdict are scripted calls");
  const model = "scripted:stand-in";
  await request.put("/api/permissions/settings", { data: { default_mode: "full-auto" } });
  const top = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `earlier-${Date.now()}`);
  const repo = join(top, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "notes.md"), "notes\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");

  const calls = (list: unknown[]) => `script:calls ${JSON.stringify(list)}`;
  const bash = (command: string) => ({ name: "Bash", input: { command } });
  const commit = (file: string, msg: string) => bash(`echo ${file} > ${file}.md && git add -A && git -c user.name=k -c user.email=k@k commit -qm '${msg}'`);
  const idle = (id: string) => expect.poll(async () => { const d = await (await request.get(`/api/sessions/${id}`)).json(); return !d.running && d.events.at(-1)?.kind === "turn_end"; }, { timeout: 90_000 }).toBe(true);
  const send = async (id: string, text: string) => { await request.post(`/api/sessions/${id}/messages`, { data: { text } }); await idle(id); };
  const lane = (title: string, words: string, steps: unknown[]) => ({ name: "spawn_agent", input: { message: `${title}\n${words}\n${calls(steps)}` } });

  const coord = (await (await request.post("/api/sessions", { data: { model, workspace: repo, title: "Coordinator" } })).json()).session.id as string;
  const agentsOf = async () => (await (await request.get(`/api/sessions/${coord}/agents`)).json()).agents as any[];
  await send(coord, `script:batch ${JSON.stringify([
    lane("Leftovers: remove only what Keel made", "When an agent ends, list the worktrees, branches and jobs it leaves behind and remove only what Keel made.", [commit("leftovers", "Leftovers"), { name: "Bash", input: { command: "echo done" } }]),
    lane("Leftovers settle at the end of an agent", "Show what an agent leaves behind when it ends, its worktrees and branches, and remove what Keel made when nothing would be lost.", [commit("settle", "Settle")]),
    lane("Sidebar rows redesign", "Redesign the sidebar's session rows and the top bar at 1920x1040 in both themes.", [commit("sidebar", "Sidebar")]),
  ])}`);
  await expect.poll(async () => (await agentsOf()).filter((a) => a.status === "completed" && a.branch).length, { timeout: 90_000 }).toBe(3);
  const by = async (title: string) => (await agentsOf()).find((a) => a.title === title)!;
  const landed = await by("Leftovers: remove only what Keel made"), refused = await by("Leftovers settle at the end of an agent"), other = await by("Sidebar rows redesign");

  // The first one's branch goes onto main; a reviewer refuses the second's head with a structured verdict.
  git(repo, "merge", "-q", "--ff-only", landed.branch);
  const verdict = { name: "keel__verdict", input: { commit: git(repo, "rev-parse", refused.branch), land: "no", why: "It removes a worktree another session still works in. Nothing checks that first." } };
  await send(coord, `script:batch ${JSON.stringify([{ name: "spawn_agent", input: { message: `Review it.\n${calls([verdict])}`, agent_type: "explorer", reviews: refused.branch } }])}`);
  await expect.poll(async () => (await agentsOf()).filter((a) => a.reviews?.length && a.status === "completed").length, { timeout: 60_000 }).toBe(1);

  // The spawn's results, as the coordinator reads them.
  const resultOf = async (title: string) => {
    const events = (await (await request.get(`/api/sessions/${coord}`)).json()).events as any[];
    const text = events.filter((e) => e.kind === "tool_result").flatMap((e) => e.data.results).map((r: any) => String(typeof r.content === "string" ? r.content : r.content.map((b: any) => b.text ?? "").join("\n"))).find((t: string) => t.includes(`"nickname":"${title}"`));
    return text ? JSON.parse(text) : undefined;
  };
  await send(coord, `script:batch ${JSON.stringify([lane("Leftovers when agents end", "Show what an agent leaves behind when it ends (worktrees, branches, jobs) and remove only what Keel made.", [])])}`);
  await expect.poll(async () => !!(await resultOf("Leftovers when agents end")), { timeout: 30_000 }).toBe(true);
  const near = await resultOf("Leftovers when agents end");
  const note = String(near.earlier_attempts);
  expect(note).toContain(`(agent ${landed.id}): landed; branch ${landed.branch} @${git(repo, "rev-parse", "--short=7", landed.branch)}`);
  expect(note).toContain(`(agent ${refused.id}): refused by review (It removes a worktree another session still works in); branch ${refused.branch}`);
  expect(note).not.toContain(other.id);
  expect(note).not.toContain("Sidebar");
  expect(note.match(/^- /gm)).toHaveLength(2);
  // Token cost: the lines are one block of the result, a few hundred bytes, never in the system prompt.
  expect(Buffer.byteLength(note)).toBeLessThan(1_200);
  console.log(`earlier-attempts: ${Buffer.byteLength(note)} bytes for two agents`);

  // A subject nobody worked on: no lines at all.
  await send(coord, `script:batch ${JSON.stringify([lane("Phone dock keyboard", "Keep the phone dock in place while the keyboard is open.", [])])}`);
  await expect.poll(async () => !!(await resultOf("Phone dock keyboard")), { timeout: 30_000 }).toBe(true);
  expect((await resultOf("Phone dock keyboard")).earlier_attempts).toBeUndefined();
});

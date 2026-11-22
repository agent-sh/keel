import { expect, test } from "./isolate.ts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HAIKU, shoot, ask, scriptBash } from "./shots.ts";

// Feature: the command sandbox. In auto-edits mode with the workspace-write
// profile and the network off, a command runs without asking, can write the
// workspace, cannot write outside it and cannot reach the network.
test("command sandbox", async ({ page, request }) => {
  const settings = await (await request.get("/api/permissions/settings")).json();
  test.skip(!settings.sandbox.available, `sandbox unavailable: ${settings.sandbox.reason}`);
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  const root = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws");
  const ws = join(root, `sandbox-${Date.now()}`);
  const outside = `${ws}-outside.txt`;
  mkdirSync(ws, { recursive: true });
  const { session } = await (await request.post("/api/sessions", { data: { workspace: ws, model: HAIKU } })).json();
  await page.goto(`/s/${session.id}`);

  // Turn the sandbox on from the menu.
  await page.getByTestId("permission-menu").click();
  await page.getByTestId("mode-auto-edits").click();
  await page.getByTestId("sandbox-workspace-write").click();
  await page.getByTestId("sandbox-network").click();
  await expect(page.getByTestId("sandbox-network")).not.toHaveAttribute("data-checked");
  await shoot(page, "sandbox-01-menu");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("permission-menu")).toContainText("sandbox");

  const cmd = `touch inside.txt; touch ${outside}; getent hosts example.com || echo no-network`;
  await page.getByTestId("composer").fill(ask(`Run exactly this one Bash command, once, and nothing else: ${cmd}\nThen reply with one word: done.`, scriptBash(cmd)));
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 120_000 });
  await expect(page.getByTestId("approval")).toHaveCount(0);

  expect(existsSync(join(ws, "inside.txt"))).toBe(true);
  expect(existsSync(outside)).toBe(false);
  const tool = page.getByTestId("tool-call").first();
  await tool.click();
  await expect(tool).toContainText("Read-only file system");
  await expect(tool).toContainText("no-network");
  await shoot(page, "sandbox-02-result");

  const errorsAfter = (await (await request.get("/api/errors")).json()).errors.length;
  expect(errorsAfter).toBe(errorsBefore);
});

// A session in a linked worktree commits with the sandbox on. git keeps a
// linked worktree's index and the repository's objects and refs outside the
// folder: those are writable, and nothing wider. The repository's hooks, the
// main checkout's own files and the folder next door stay read-only.
test("a sandboxed session commits in its worktree", async ({ page, request }) => {
  const settings = await (await request.get("/api/permissions/settings")).json();
  test.skip(!settings.sandbox.available, `sandbox unavailable: ${settings.sandbox.reason}`);
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();
  const repo = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `sandbox-wt-${Date.now()}`);
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "# test repo\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "first");
  // A second worktree of the same repository: its files are not this session's.
  git(repo, "worktree", "add", "-q", "-b", "other", `${repo}-other`);
  const mainHead = readFileSync(join(repo, ".git/HEAD"), "utf8");
  const otherHead = readFileSync(join(repo, ".git/worktrees", `${repo.split("/").pop()}-other`, "HEAD"), "utf8");

  const made = await (await request.post("/api/worktrees", { data: { workspace: repo, model: HAIKU, title: "sandboxed commit" } })).json();
  const id = made.session.id as string;
  await request.put(`/api/sessions/${id}/permissions`, { data: { mode: "full-auto", sandbox: "workspace-write", network: false } });
  const outside = `${repo}-outside.txt`;
  const tries = [
    `touch ${outside}`,
    `touch ${repo}/README.new`,
    `echo evil > ${repo}/.git/hooks/pre-commit`,
    `echo x >> ${repo}/.git/config`,
    `echo ref: refs/heads/x > ${repo}/.git/HEAD`,
    `echo ref: refs/heads/x > ${repo}/.git/worktrees/${repo.split("/").pop()}-other/HEAD`,
    // The state of an operation in progress, which the main checkout would continue.
    `mkdir ${repo}/.git/rebase-merge`,
    `touch ${repo}/.git/MERGE_HEAD`,
  ];
  const command = `echo hello > NOTES.md && git add NOTES.md && git -c user.name=k -c user.email=k@k commit -qm notes && echo com""mitted; ${tries.map((t, i) => `(${t}) 2>&1 || echo re""fused-${i}`).join("; ")}`;
  await page.goto(`/s/${id}`);
  await page.getByTestId("composer").fill(`script:calls ${JSON.stringify([{ name: "Bash", input: { command } }])}`);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 60_000 });
  await expect(page.getByTestId("approval")).toHaveCount(0);

  const tool = page.getByTestId("tool-call").first();
  await tool.click();
  await expect(tool).toContainText("committed");
  for (let i = 0; i < tries.length; i++) await expect(tool).toContainText(`refused-${i}`);
  await shoot(page, "sandbox-03-worktree-commit");

  const { worktree } = await (await request.get(`/api/sessions/${id}/worktree`)).json();
  expect(worktree.commits_ahead).toBe(1);
  expect(git(repo, "show", `${worktree.branch}:NOTES.md`)).toBe("hello");
  expect(existsSync(outside)).toBe(false);
  expect(existsSync(join(repo, "README.new"))).toBe(false);
  expect(existsSync(join(repo, ".git/hooks/pre-commit"))).toBe(false);
  expect(readFileSync(join(repo, ".git/HEAD"), "utf8")).toBe(mainHead);
  for (const planted of ["rebase-merge", "MERGE_HEAD"]) expect(existsSync(join(repo, ".git", planted))).toBe(false);
  expect(readFileSync(join(repo, ".git/worktrees", `${repo.split("/").pop()}-other`, "HEAD"), "utf8")).toBe(otherHead);
  expect(git(repo, "config", "--get", "core.bare")).toBe("false");

  // The same for an agent: a sandboxed session's work agent commits in the
  // worktree it was given, and its report counts the commit.
  const { session: parent } = await (await request.post("/api/sessions", { data: { workspace: repo, model: HAIKU, title: "sandboxed agent" } })).json();
  await request.put(`/api/sessions/${parent.id}/permissions`, { data: { mode: "full-auto", sandbox: "workspace-write", network: false } });
  const work = [{ name: "Bash", input: { command: "echo hi > AGENT.md && git add AGENT.md && git -c user.name=k -c user.email=k@k commit -qm agent" } }];
  await request.post(`/api/sessions/${parent.id}/messages`, { data: { text: `script:calls ${JSON.stringify([{ name: "spawn_agent", input: { message: `Add a note\nscript:calls ${JSON.stringify(work)}` } }])}` } });
  await page.goto(`/s/${parent.id}`);
  await expect(page.getByTestId("agent-report")).toHaveCount(1, { timeout: 90_000 });
  const report = async () => JSON.stringify((await (await request.get(`/api/sessions/${parent.id}`)).json()).events.filter((e: any) => e.kind === "user"));
  await expect.poll(report, { timeout: 30_000 }).toContain("1 commit over main");
  await shoot(page, "sandbox-04-agent-commit");

  // The limit of the profile, said when it is used: every ref of the shared
  // repository is writable (a commit needs lock files next to them), so a
  // confined command can move a branch another checkout has out or delete
  // one. The result of such a command says what changed, and so does the
  // session's activity. A command that only commits says nothing.
  git(repo, "branch", "gone");
  const results = async () => ((await (await request.get(`/api/sessions/${id}`)).json()).events as any[]).filter((e) => e.kind === "tool_result").map((e) => String(e.data.results[0].content));
  const run = async (cmd: string, n: number) => {
    await request.post(`/api/sessions/${id}/messages`, { data: { text: `script:calls ${JSON.stringify([{ name: "Bash", input: { command: cmd } }])}` } });
    await expect.poll(async () => (await results()).length, { timeout: 60_000 }).toBe(n);
    return (await results()).at(-1)!;
  };
  const quiet = await run("echo more >> NOTES.md && git -c user.name=k -c user.email=k@k commit -qam more && echo again", 2);
  expect(quiet).toContain("again");
  expect(quiet).not.toContain("[sandbox]");
  const before = git(repo, "rev-parse", "--short=7", "main");
  const loud = await run("git update-ref refs/heads/main HEAD && git update-ref -d refs/heads/gone && echo moved", 3);
  const said = `While this command ran, what this worktree shares with the repository's other checkouts changed: moved branch main (${before} to ${git(repo, "rev-parse", "--short=7", "main")}); deleted branch gone.`;
  expect(loud).toContain(`[sandbox] ${said}`);
  const rows = ((await (await request.get(`/api/activity?session_id=${id}`)).json()).items as any[]).filter((a) => a.sub === "sandbox").map((a) => a.text);
  expect(rows).toEqual([said]);
  await page.goto(`/s/${id}`);
  const last = page.getByTestId("tool-call").last();
  await last.click();
  await expect(last).toContainText("moved branch main");
  await shoot(page, "sandbox-05-refs-changed");

  // What the worktree's read-only view of the shared git directory closes is
  // said in the result of a command that runs into it.
  const shut = await run("git pack-refs --all; echo status-$?", 4);
  expect(shut).toContain("status-128");
  expect(shut).toContain("[sandbox] This worktree's sandbox keeps the top of the repository's git directory read-only");
  expect(git(repo, "rev-parse", "--verify", "-q", "refs/heads/main")).toHaveLength(40);
});

// A sandboxed command is not the owner to the daemon's API. With the
// session's network on it has a network namespace of its own and a proxy
// that never connects to this machine: the API's port is not on its
// loopback, and the proxy refuses it by name. In every mode that runs a
// confined command without a card: reading another session, widening its own
// read list, turning its own sandbox off, answering an approval.
test("a sandboxed command with the network on cannot reach the daemon's API", async ({ page, request, baseURL }) => {
  const settings = await (await request.get("/api/permissions/settings")).json();
  test.skip(!settings.sandbox.available, `sandbox unavailable: ${settings.sandbox.reason}`);
  const port = new URL(baseURL!).port;
  const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `sandbox-api-${Date.now()}`);
  mkdirSync(ws, { recursive: true });
  const { session: other } = await (await request.post("/api/sessions", { data: { workspace: ws, model: HAIKU, title: `OTHER-SESSION-${Date.now()}` } })).json();
  const { session } = await (await request.post("/api/sessions", { data: { workspace: ws, model: HAIKU } })).json();
  const id = session.id;
  const before = await (await request.get("/api/permissions/sandbox")).json();
  // Each act two ways: straight at the port, and through the proxy the sandbox was given.
  const api = `http://127.0.0.1:${port}`;
  const acts: [string, string][] = [
    ["read", `${api}/api/sessions/${other.id}`],
    ["widen", `-X PUT -H 'content-type: application/json' -d '{"workspace":{"scope":"${ws}","read":["${ws}-elsewhere"]}}' ${api}/api/permissions/sandbox`],
    ["unconfine", `-X PUT -H 'content-type: application/json' -d '{"sandbox":"off","mode":"full-auto"}' ${api}/api/sessions/${id}/permissions`],
    ["answer", `-X POST -H 'content-type: application/json' -d '{"choice":"once"}' ${api}/api/sessions/${id}/approvals/any`],
  ];
  const command = acts.flatMap(([name, args]) => [
    `echo "${name} straight: $(curl -s -m 4 --noproxy '*' -o /dev/null -w '%{http_code}' ${args})"`,
    `echo "${name} by proxy: $(curl -s -m 4 --noproxy '' -x "$HTTP_PROXY" -o /dev/null -w '%{http_code}' ${args})"`,
  ]).join("; ") + `; curl -s -m 4 --noproxy '' -x "$HTTP_PROXY" ${api}/api/sessions/${other.id} | head -c 300`;
  await page.goto(`/s/${id}`);
  const results = async () => ((await (await request.get(`/api/sessions/${id}`)).json()).events as any[]).filter((e) => e.kind === "tool_result").map((e) => String(e.data.results[0].content));
  let n = 0;
  for (const mode of ["ask", "auto-edits", "auto", "full-auto"]) {
    await request.put(`/api/sessions/${id}/permissions`, { data: { mode, sandbox: "workspace-write", network: true } });
    await page.getByTestId("composer").fill(`script:calls ${JSON.stringify([{ name: "Bash", input: { command } }])}`);
    await page.keyboard.press("Enter");
    // Where a mode asks for a command of this shape, the owner allows it: it fails all the same.
    n++;
    await expect.poll(async () => (await page.getByTestId("turn-end").count()) >= n || (await page.getByTestId("approval").count()) > 0, { timeout: 60_000 }).toBe(true);
    if ((await page.getByTestId("turn-end").count()) < n) {
      const card = page.getByTestId("approval").first();
      if (await card.getByTestId("approval-expand").count()) await card.getByTestId("approval-expand").click();
      await expect(card.getByTestId("allow-once")).not.toHaveAttribute("aria-disabled", "true");
      await card.getByTestId("allow-once").click();
    }
    await expect(page.getByTestId("turn-end")).toHaveCount(n, { timeout: 60_000 });
    const out = (await results()).at(-1)!;
    for (const [name] of acts) {
      expect([mode, out]).toEqual([mode, expect.stringContaining(`${name} straight: 000`)]);
      expect([mode, out]).toEqual([mode, expect.stringContaining(`${name} by proxy: 403`)]);
    }
    expect(out).not.toContain(other.title);
    expect(out).toContain(`Keel's sandbox proxy refused 127.0.0.1:${port}: Keel's own API is never reachable from a sandbox.`);
    // The command is told, with no way around offered for Keel's own API.
    expect(out).toContain(`[sandbox] This session's sandbox reaches the network only through Keel's proxy, which refused 127.0.0.1:${port}: Keel's own API is never reachable from a sandbox`);
    expect(out).not.toContain("dangerouslyDisableSandbox");
    // Nothing changed: the session is still confined in the mode it was put in, and the read list is as it was.
    const { perm } = await (await request.get(`/api/sessions/${id}/permissions`)).json();
    expect([perm.mode, perm.sandbox, perm.network]).toEqual([mode, "workspace-write", true]);
    expect(await (await request.get("/api/permissions/sandbox")).json()).toEqual(before);
  }
  const tool = page.getByTestId("tool-call").last();
  await tool.click();
  await expect(tool).toContainText("Keel's own API is never reachable from a sandbox");
  await shoot(page, "sandbox-09-api-refused");
});

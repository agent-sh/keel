import { expect, test } from "./isolate.ts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ask, boxTools, closeBoxTools, endsAre, HAIKU, openPanel, scriptBash, shoot, turnEnds } from "./shots.ts";

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
  await (await boxTools(page)).getByTestId("permission-menu").click();
  await page.getByTestId("mode-auto-edits").click();
  await page.getByTestId("sandbox-workspace-write").click();
  await page.getByTestId("sandbox-network").click();
  await expect(page.getByTestId("sandbox-network")).not.toHaveAttribute("data-checked");
  await shoot(page, "sandbox-01-menu");
  await page.keyboard.press("Escape");
  await expect((await boxTools(page)).getByTestId("permission-menu")).toContainText("sandbox");
  await closeBoxTools(page);

  const cmd = `touch inside.txt; touch ${outside}; getent hosts example.com || echo no-network`;
  await page.getByTestId("composer").fill(ask(`Run exactly this one Bash command, once, and nothing else: ${cmd}\nThen reply with one word: done.`, scriptBash(cmd)));
  await page.keyboard.press("Enter");
  await endsAre(page, 1, 120_000);
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
  await endsAre(page, 1, 60_000);
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

// What a sandboxed command can read: the session's folder, the system and the
// owner's toolchains. Not the rest of the home (a key under ~/.ssh, a file of
// another project) and not Keel's own state folder. A command that looked for
// one of those is told what was hidden; the owner opens a folder for the
// workspace in Settings; and the file tools, which run outside the sandbox,
// ask before they read where credentials are kept.
test("a sandboxed command reads none of the owner's secrets, and the owner opens a folder for it", async ({ page, request }) => {
  const settings = await (await request.get("/api/permissions/settings")).json();
  test.skip(!settings.sandbox.available, `sandbox unavailable: ${settings.sandbox.reason}`);
  const home = process.env.HOME!;
  const stamp = Date.now();
  const ws = join(home, ".cache/keel-work/bun/e2e-ws", `sandbox-read-${stamp}`);
  mkdirSync(ws, { recursive: true });
  // The owner's files: a key, a note in a folder of their own, and a tool on PATH-less reach (a script in the folder).
  mkdirSync(join(home, ".ssh"), { recursive: true });
  writeFileSync(join(home, ".ssh", `id_e2e_${stamp}`), `PRIVATE-KEY-${stamp}\n`);
  const notes = join(home, `notes-${stamp}`);
  mkdirSync(notes, { recursive: true });
  writeFileSync(join(notes, "plan.md"), `OWNER-NOTE-${stamp}\n`);
  writeFileSync(join(ws, ".env"), `WORKSPACE-ENV-${stamp}\n`);
  const { state_dir } = await (await request.get("/api/daemon")).json();
  expect(existsSync(join(state_dir, "keel.db"))).toBe(true);

  const { session } = await (await request.post("/api/sessions", { data: { workspace: ws, model: HAIKU } })).json();
  const id = session.id;
  await request.put(`/api/sessions/${id}/permissions`, { data: { mode: "auto-edits", sandbox: "workspace-write", network: false } });
  await page.goto(`/s/${id}`);
  const results = async () => ((await (await request.get(`/api/sessions/${id}`)).json()).events as any[]).filter((e) => e.kind === "tool_result").map((e) => String(e.data.results[0].content));
  const bash = async (command: string, n: number) => {
    await page.getByTestId("composer").fill(`script:calls ${JSON.stringify([{ name: "Bash", input: { command } }])}`);
    await page.keyboard.press("Enter");
    await endsAre(page, n, 60_000);
    return (await results()).at(-1)!;
  };

  // 1. The command runs without a card. It reads its own folder's .env, and finds no key, no note and no Keel state.
  const look = `cat .env; cat ~/.ssh/id_e2e_${stamp}; cat ${notes}/plan.md; ls ${state_dir}/keel.db; echo x > "$XDG_CACHE_HOME/made-by-sandbox" && echo wr""ote-cache; echo x > ~/made-by-sandbox || echo home-cl""osed`;
  const first = await bash(look, 1);
  await expect(page.getByTestId("approval")).toHaveCount(0);
  expect(first).toContain(`WORKSPACE-ENV-${stamp}`);
  expect(first).not.toContain(`PRIVATE-KEY-${stamp}`);
  expect(first).not.toContain(`OWNER-NOTE-${stamp}`);
  expect(first.match(/No such file or directory/g)!.length).toBeGreaterThanOrEqual(3);
  // Its cache folder is the sandbox's own; the rest of the home it sees takes no write. Nothing reached the owner's home.
  expect(first).toContain("wrote-cache");
  expect(first).toContain("home-closed");
  expect(existsSync(join(home, ".keel-sandbox"))).toBe(false);
  expect(existsSync(join(home, "made-by-sandbox"))).toBe(false);
  // It is told what was hidden and how the owner allows it, in its own tool's words for leaving the sandbox. For
  // the key and Keel's own file no way around is offered.
  expect(first).toContain("[sandbox] This session's sandbox does not show");
  expect(first).toMatch(new RegExp(`does not show [^\\n]*\\.ssh/id_e2e_${stamp}[^\\n]*: the owner's credential stores and Keel's own files are kept from every sandboxed command\\.(\\n|$)`));
  expect(first).toMatch(new RegExp(`does not show [^\\n]*notes-${stamp}/plan\\.md: the home folder is not readable there`));
  expect(first).toContain("The owner can add a folder to what this session's folder may read, in Settings, Permissions.");
  expect(first).toContain("dangerouslyDisableSandbox: true");
  // On the card too. (A command that just ended stands as it was, with the tail of its own output, until the owner
  // folds it: opened again it shows its result, which holds the sentence.)
  const tool = page.getByTestId("tool-call").first();
  await expect(async () => {
    await tool.getByRole("button").first().click();
    await expect(tool).toContainText("This session's sandbox does not show", { timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await shoot(page, "sandbox-06-hidden");

  // 2. The owner adds the folder for this workspace in Settings.
  await page.goto("/settings/safety");
  const card = page.getByTestId("sandbox-reads");
  await card.getByTestId("sandbox-scope").click();
  await page.getByRole("option", { name: ws, exact: true }).click();
  await expect(card.getByTestId("sandbox-scope")).toContainText(ws);
  // The home itself is refused, with the reason.
  const one = card.getByTestId("sandbox-read-one");
  await one.getByTestId("sandbox-read-add").fill("~");
  await one.getByTestId("sandbox-read-add-button").click();
  await expect(card.getByTestId("sandbox-reads-error")).toContainText("would open all of the home folder");
  await one.getByTestId("sandbox-read-add").fill(notes);
  await one.getByTestId("sandbox-read-add").press("Enter");
  await expect(one.getByTestId("sandbox-read-path")).toHaveText([notes]);
  await shoot(page, "sandbox-07-settings");
  // The same card on a phone: a long path wraps, nothing is wider than the page.
  const size = page.viewportSize()!;
  await page.setViewportSize({ width: 390, height: 844 });
  await card.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect(await card.evaluate((el) => [...el.querySelectorAll("*")].every((n) => n.getBoundingClientRect().right <= window.innerWidth + 1))).toBe(true);
  await shoot(page, "sandbox-07b-settings-390");
  await page.setViewportSize(size);
  expect((await (await request.get("/api/permissions/sandbox")).json()).workspaces[ws]).toEqual({ read: [notes] });

  // 3. The same command now reads the note, and still no key.
  await page.goto(`/s/${id}`);
  const second = await bash(look, 2);
  expect(second).toContain(`OWNER-NOTE-${stamp}`);
  expect(second).not.toContain(`PRIVATE-KEY-${stamp}`);

  // The session's own files in Keel's state are there: an artifact it writes from a command lands in its artifacts folder.
  const artifacts = join(state_dir, "artifacts", id);
  const third = await bash(`echo chart > ${artifacts}/chart.txt && cat ${artifacts}/chart.txt; ls ${state_dir}/artifacts | wc -l`, 3);
  expect(third).toContain("chart\n1");
  expect(readFileSync(join(artifacts, "chart.txt"), "utf8")).toBe("chart\n");

  // 4. A file tool runs outside the sandbox: reading the key asks the owner, and says why.
  await page.getByTestId("composer").fill(`script:calls ${JSON.stringify([{ name: "Read", input: { file_path: join(home, ".ssh", `id_e2e_${stamp}`) } }])}`);
  await page.keyboard.press("Enter");
  const approval = page.getByTestId("approval");
  await expect(approval).toHaveCount(1, { timeout: 30_000 });
  await expect(approval).toContainText("where the owner's credentials, history or sign-in settings are kept");
  await shoot(page, "sandbox-08-read-asks");
  await approval.getByTestId("deny").click();
  await page.getByTestId("deny-reason").fill("that is my key");
  await page.getByTestId("deny-send").click();
  await endsAre(page, 4, 60_000);
  expect((await results()).join("\n")).not.toContain(`PRIVATE-KEY-${stamp}`);
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
  // (The owner's lists: what the page shows beside them, the size on disk among it, moves as commands run.)
  const lists = (x: any) => ({ read: x.read, env: x.env, workspaces: x.workspaces });
  const before = lists(await (await request.get("/api/permissions/sandbox")).json());
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
    await expect.poll(async () => (await turnEnds(page)) >= n || (await page.getByTestId("approval").count()) > 0, { timeout: 60_000 }).toBe(true);
    if ((await turnEnds(page)) < n) {
      const card = page.getByTestId("approval").first();
      if (await card.getByTestId("approval-expand").count()) await card.getByTestId("approval-expand").click();
      await expect(card.getByTestId("allow-once")).not.toHaveAttribute("aria-disabled", "true");
      await card.getByTestId("allow-once").click();
    }
    await endsAre(page, n, 60_000);
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
    expect(lists(await (await request.get("/api/permissions/sandbox")).json())).toEqual(before);
  }
  const tool = page.getByTestId("tool-call").last();
  await tool.click();
  await expect(tool).toContainText("Keel's own API is never reachable from a sandbox");
  await shoot(page, "sandbox-09-api-refused");
});

// A dev server a sandboxed command starts listens on the sandbox's own
// loopback: nothing else on the machine reaches it there. The session's
// portal still shows it: the daemon reaches into that sandbox's network
// namespace for the port.
test("the portal shows a dev server a sandboxed command runs", async ({ page, request }) => {
  const settings = await (await request.get("/api/permissions/settings")).json();
  test.skip(!settings.sandbox.available, `sandbox unavailable: ${settings.sandbox.reason}`);
  const port = Number(execFileSync("python3", ["-c", "import socket; s=socket.socket(); s.bind(('127.0.0.1', 0)); print(s.getsockname()[1])"], { encoding: "utf8" }).trim());
  const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `sandbox-portal-${Date.now()}`);
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, "index.html"), "<!doctype html><title>t</title><h1>served from inside the sandbox</h1>\n");
  const { session } = await (await request.post("/api/sessions", { data: { workspace: ws, model: HAIKU } })).json();
  const id = session.id;
  await request.put(`/api/sessions/${id}/permissions`, { data: { mode: "full-auto", sandbox: "workspace-write", network: true } });
  try {
    await page.goto(`/s/${id}`);
    await page.getByTestId("composer").fill(`script:calls ${JSON.stringify([{ name: "Bash", input: { command: `python3 -m http.server ${port} --bind 127.0.0.1`, run_in_background: true } }])}`);
    await page.keyboard.press("Enter");
    await endsAre(page, 1, 60_000);
    // The port is the session's, though it is on no address of this machine.
    const ports = async () => ((await (await request.get(`/api/sessions/${id}/portal`)).json()).ports as any[]);
    await expect.poll(async () => (await ports()).map((p) => p.port), { timeout: 20_000 }).toContain(port);
    expect((await ports()).find((p) => p.port === port).ns).toMatch(/^net:/);
    expect(await fetch(`http://127.0.0.1:${port}/`).then((r) => r.status, () => 0)).toBe(0);
    // Opened in the Preview panel, the portal serves it.
    await openPanel(page, "preview");
    const entry = page.locator(`[data-testid="preview-port"][data-port="${port}"]`);
    await expect(entry).toBeVisible({ timeout: 15_000 });
    await entry.click();
    await expect(page.frameLocator('[data-testid="preview-frame"]').locator("h1")).toHaveText("served from inside the sandbox", { timeout: 15_000 });
    await shoot(page, "sandbox-10-portal");
    const url = (await ports()).find((p) => p.port === port).url as string;
    const served = await request.get(url);
    expect(served.status()).toBe(200);
    expect(await served.text()).toContain("served from inside the sandbox");
  } finally {
    await request.delete(`/api/sessions/${id}`);
  }
});

import { expect, test } from "./isolate.ts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GitHubStandin, TOKEN } from "./fixtures/github-standin.ts";
import { daemon, exited, ROOT } from "./own-daemon.ts";
import { shoot } from "./shots.ts";

// Feature: a pull request gets a review from GitHub's events with no public
// URL. The daemon polls a stand-in GitHub (conditional requests, the pace it
// states), reviews each new head once with the scripted reviewer in a
// worktree of that head, keeps it a draft the owner posts with one button,
// or posts it by itself once the owner turns that on; the Inbox says so. A
// restart between pushes neither loses a push nor reviews a head twice.
const REPO = "acme/widgets";
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();

test("pull requests are reviewed from GitHub's events, once a head, drafts posted by the owner", async ({ page, request }) => {
  // Another person's code is reviewed only inside the sandbox: where it cannot run, a review is refused (not run unconfined).
  const { sandbox } = await (await request.get("/api/permissions/settings")).json();
  test.skip(!sandbox.available, `sandbox unavailable: ${sandbox.reason}`);
  test.setTimeout(300_000);
  const state = join(ROOT, `pr-review-${Date.now()}`);
  const work = join(state, "work");
  const bare = join(state, "widgets.git");
  mkdirSync(work, { recursive: true });
  git(state, "init", "-q", "--bare", bare);
  git(work, "init", "-q", "-b", "main");
  writeFileSync(join(work, "calc.py"), "def div(a, b):\n    return a / b\n");
  // The repository names a filter for its Python files, and the owner's global git config has one of that name:
  // git would run it on the pull request's files (a checkout smudges, a snapshot cleans). Keel runs neither.
  writeFileSync(join(work, ".gitattributes"), "*.py filter=probe\n");
  const marks = join(state, "marks");
  mkdirSync(marks, { recursive: true });
  writeFileSync(join(state, "filter.sh"), `#!/bin/sh\ntouch "${marks}/$1"\ncat\n`, { mode: 0o755 });
  writeFileSync(join(state, "gitconfig"), `[filter "probe"]\n\tclean = ${join(state, "filter.sh")} clean\n\tsmudge = ${join(state, "filter.sh")} smudge\n`);
  git(work, "add", "-A");
  git(work, "commit", "-qm", "init");
  git(work, "push", "-q", bare, "main");
  // A pull request is a branch over main whose head GitHub keeps as refs/pull/N/head.
  const head = (n: number, file: string, text: string) => {
    git(work, "checkout", "-q", "-B", `pr${n}`, n === 2 && git(work, "branch", "--list", "pr2") ? "pr2" : "main");
    writeFileSync(join(work, file), text);
    git(work, "add", "-A");
    git(work, "commit", "-qm", `change ${file}`);
    const sha = git(work, "rev-parse", "HEAD");
    git(work, "push", "-q", "-f", bare, `HEAD:refs/pull/${n}/head`);
    git(work, "checkout", "-q", "main");
    return sha;
  };

  const gh = new GitHubStandin();
  await gh.start();
  gh.repo(REPO, bare);
  // One pull request a page: the list is several pages, and a change to one leaves the others answering 304.
  gh.pageSize = 1;
  // The daemon holds a GitHub token in its environment: the reviewer's commands must not.
  const env = { KEEL_GITHUB_API: gh.url, KEEL_GH_BIN: join(process.cwd(), "test/e2e/fixtures/gh-standin.sh"), GH_TOKEN: TOKEN, GIT_CONFIG_GLOBAL: join(state, "gitconfig") };
  let d = await daemon(state, 0, false, env);
  const api = (path: string, init?: RequestInit) => fetch(d.url + path, { ...init, headers: { "content-type": "application/json" } }).then((r) => r.json() as any);
  const reviews = async () => (await api("/api/pr-reviews")).reviews as any[];
  try {
    // A pull request open before the watch began: remembered, not reviewed.
    const h1 = head(1, "old.py", "# script:review\nx = 1  # BUG: an old bug\n");
    gh.pulls.get(REPO)!.push({ number: 1, head: h1, title: "Old change" });

    await page.setViewportSize({ width: 1920, height: 1040 });
    await page.goto(`${d.url}/settings/pull-requests`);
    await page.getByTestId("pr-watch-input").fill(REPO);
    await page.getByTestId("pr-watch-add").click();
    const card = page.getByTestId("pr-watch");
    await expect(card).toHaveAttribute("data-repo", REPO);
    await expect(page.getByTestId("pr-credentials")).toHaveAttribute("data-source", "env");
    await expect(card.getByTestId("pr-watch-status")).toContainText("read", { timeout: 20_000 });
    await expect(card.getByTestId("pr-watch-status")).toContainText("every 1 s, as GitHub asks");
    await expect.poll(() => gh.gets(`/repos/${REPO}/pulls`).filter((l) => l.status === 304).length, { timeout: 15_000 }).toBeGreaterThan(0);
    expect(await reviews()).toEqual([]);
    await shoot(page, "pr-review-01-watched");

    // A new pull request: one review, a draft; nothing is posted.
    const h2 = head(2, "b.py", "# script:review\ndef ratio(a, b):\n    return a / b  # BUG: divides by zero when b is 0\n");
    gh.pulls.get(REPO)!.push({ number: 2, head: h2, title: "Add ratio" });
    await expect.poll(async () => (await reviews()).find((r) => r.head === h2)?.state, { timeout: 60_000 }).toBe("draft");
    const r2 = (await reviews()).find((r) => r.head === h2);
    expect(r2.why).toBe("opened");
    expect(r2.findings.map((f: any) => [f.file, f.line, f.title])).toEqual([["b.py", 3, "divides by zero when b is 0"]]);
    expect(gh.posted).toEqual([]);
    // The reviewer ran confined: read-only, in the sandbox, with no network.
    expect((await api(`/api/sessions/${r2.session_id}/permissions`)).perm).toMatchObject({ mode: "read-only", sandbox: "read-only", network: false });
    // The Inbox says a draft is ready, once, and the review session is not filed as finished too.
    const { alerts } = await api("/api/alerts");
    expect(alerts.filter((a: any) => a.kind === "review").map((a: any) => a.title)).toEqual([`Review ready: ${REPO}#2`]);
    expect(alerts.filter((a: any) => a.session_id === r2.session_id && a.kind !== "review")).toEqual([]);

    await page.goto(`${d.url}/?inbox=1`);
    await expect(page.getByTestId("inbox-list")).toContainText("1 finding, has problems. A draft: read it and post it from Keel.");
    await shoot(page, "pr-review-02-inbox");

    // The draft in its session, and the one button that posts it.
    await page.goto(`${d.url}/s/${r2.session_id}`);
    // The header keeps three tools in its row; the rest are under "More" (a stowed action is opened from there).
    const prAction = page.getByTestId("header-action-pr-review");
    if (!(await prAction.isVisible())) await page.getByTestId("header-more-button").first().click();
    await prAction.click();
    const panel = page.getByTestId("pr-review-panel");
    await expect(panel).toHaveAttribute("data-state", "draft");
    await expect(panel.getByTestId("pr-review-finding")).toHaveCount(1);
    await expect(panel.getByTestId("pr-review-finding")).toContainText("b.py:3");
    // The reviewer's checkout of the head stays with its session (it can still be asked about the code).
    await expect(page.getByTestId("folder-gone")).toHaveCount(0);
    await shoot(page, "pr-review-03-draft");
    await panel.getByTestId("pr-review-post").click();
    await expect(panel).toHaveAttribute("data-state", "posted");
    await expect(panel.getByTestId("pr-review-posted")).toBeVisible();
    expect(gh.posted.length).toBe(1);
    expect(gh.posted[0]!.number).toBe(2);
    expect(gh.posted[0]!.body).toMatchObject({ event: "COMMENT", commit_id: h2, comments: [{ path: "b.py", line: 3, side: "RIGHT" }] });
    await shoot(page, "pr-review-04-posted");
    // A second post of the same review posts nothing.
    expect((await fetch(`${d.url}/api/pr-reviews/${r2.id}/post`, { method: "POST" })).status).toBe(409);

    // The owner asks the reviewer one more thing: its command reads the head's files in the sandbox, without the
    // daemon's GitHub token, and that turn's end is told in the Inbox as any turn's is.
    await page.goto(`${d.url}/settings/pull-requests`);
    // Its git works in the checkout (the git folder is shown read-only), and it has no MCP tool.
    const ask = [
      { name: "Bash", input: { command: "cat b.py; echo GH=[${GH_TOKEN:-none}]; git rev-parse HEAD" } },
      { name: "mcp_call", input: { tool: "web__webfetch", arguments: { url: "https://example.com" } } },
    ];
    await api(`/api/sessions/${r2.session_id}/messages`, { method: "POST", body: JSON.stringify({ text: `script:calls ${JSON.stringify(ask)}` }) });
    await expect.poll(async () => (await api(`/api/sessions/${r2.session_id}`)).events.filter((e: any) => e.kind === "turn_end").length, { timeout: 30_000 }).toBe(2);
    const out = (await api(`/api/sessions/${r2.session_id}`)).events.filter((e: any) => e.kind === "tool_result").flatMap((e: any) => e.data.results).map((x: any) => String(x.content)).join("\n");
    expect(out).toContain("def ratio(a, b):");
    expect(out).toContain("GH=[none]");
    expect(out).toContain(h2);
    expect(out).toContain("mcp_call is not one of them");
    // No filter of the owner's ran on the pull request's files: not at the checkout, not at the snapshot after the tool turn.
    expect(readdirSync(marks)).toEqual([]);
    expect(out).not.toContain(TOKEN);
    await expect.poll(async () => (await api("/api/alerts")).alerts.filter((a: any) => a.session_id === r2.session_id && a.kind === "finished").length, { timeout: 10_000 }).toBe(1);

    // A comment asks for a review of the pull request that was open before: only one from someone with write access counts.
    gh.comments.get(REPO)!.push({ id: 100, pr: 1, body: "@keel review", association: "NONE", user: "drive-by" });
    await expect.poll(() => gh.log.some((l) => l.path.includes("issues/comments") && l.status === 200 && l.at > Date.now() - 3000), { timeout: 15_000 }).toBe(true);
    await page.waitForTimeout(2_500);
    expect((await reviews()).some((r) => r.head === h1)).toBe(false);
    gh.comments.get(REPO)!.push({ id: 101, pr: 1, body: "@Keel review please, the parser", association: "OWNER", user: "owner" });
    await expect.poll(async () => (await reviews()).find((r) => r.head === h1)?.state, { timeout: 60_000 }).toBe("draft");
    expect((await reviews()).find((r) => r.head === h1)).toMatchObject({ why: "asked", asked_by: "owner" });

    // A restart, and a push to #2 while the daemon is down.
    d.proc.kill("SIGTERM");
    await exited(d.proc);
    const h2b = head(2, "b.py", "# script:review\ndef ratio(a, b):\n    if b == 0:\n        return 0\n    return a / b\nlimit = 0  # BUG: the limit is never read\n");
    gh.pulls.get(REPO)!.find((p) => p.number === 2)!.head = h2b;
    const before = gh.log.length;
    d = await daemon(state, 0, false, env);
    await expect.poll(async () => (await reviews()).find((r) => r.head === h2b)?.state, { timeout: 60_000 }).toBe("draft");
    expect((await reviews()).find((r) => r.head === h2b)).toMatchObject({ why: "updated" });
    // A newer head's review takes the pull request's checkout: the older one's goes.
    await expect.poll(() => existsSync(join(state, "pr-review/wt/acme", `widgets-pr2-${h2.slice(0, 7)}`))).toBe(false);
    expect(existsSync(join(state, "pr-review/wt/acme", `widgets-pr2-${h2b.slice(0, 7)}`))).toBe(true);
    expect(gh.posted.length).toBe(1); // posting is still off: a draft
    // The kept ETags went with the restart: the unchanged comments were asked for conditionally, and answered 304.
    expect(gh.log.slice(before).some((l) => l.path.includes("issues/comments") && l.conditional && l.status === 304)).toBe(true);

    // Posting turned on: the next push is posted by itself.
    await page.goto(`${d.url}/settings/pull-requests`);
    await page.getByRole("radio", { name: "Post by itself" }).click();
    await expect.poll(async () => (await api("/api/pr-reviews")).repos[0].post).toBe(true);
    const h2c = head(2, "b.py", "# script:review\ndef ratio(a, b):\n    return a / b if b else 0\n");
    gh.pulls.get(REPO)!.find((p) => p.number === 2)!.head = h2c;
    await expect.poll(async () => (await reviews()).find((r) => r.head === h2c)?.state, { timeout: 60_000 }).toBe("posted");
    expect((await reviews()).find((r) => r.head === h2c)).toMatchObject({ posted_by: "auto", findings: [] });
    expect(gh.posted.map((p) => p.body.commit_id)).toEqual([h2, h2c]);
    await expect(page.getByTestId("pr-review-row")).toHaveCount(4);
    await shoot(page, "pr-review-05-posting-on");

    // Once a head, across everything above: four heads, four reviews, never two of one.
    const all = await reviews();
    expect(all.map((r) => r.head).sort()).toEqual([h1, h2, h2b, h2c].sort());
    // An unchanged page still counts: #1 sat on a page that answered 304 while #2's changed, and its checkout is there.
    expect(existsSync(join(state, "pr-review/wt/acme", `widgets-pr1-${h1.slice(0, 7)}`))).toBe(true);
    // Never faster than GitHub asked (1 s here), for each page of each listing.
    for (const path of new Set(gh.log.filter((l) => l.method === "GET").map((l) => l.path))) {
      const at = gh.log.filter((l) => l.method === "GET" && l.path === path).map((l) => l.at);
      for (let i = 1; i < at.length; i++) expect([path, at[i]! - at[i - 1]! >= 900]).toEqual([path, true]);
    }
  } finally {
    d.proc.kill("SIGTERM");
    await exited(d.proc);
    await gh.stop();
    rmSync(state, { recursive: true, force: true });
  }
});

import { expect, test } from "./isolate.ts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { shoot } from "./shots.ts";

const STAND_IN = "scripted:stand-in";
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

// Feature: a spawn names the paths its agent may write. The agent writes inside them; a write elsewhere is refused
// and asks its parent once, and the parent's yes lets that path; the owner's checkout's git directory and a branch
// it has out are refused with no question. The same with the sandbox off (the gate reads the command's writes) and
// on (the sandbox holds what the words do not show).
for (const sandbox of ["off", "workspace-write"] as const) {
  test(`an agent's write scope with the sandbox ${sandbox === "off" ? "off" : "on"}`, async ({ page, request }) => {
    const models = (await (await request.get("/api/models")).json()).models as { id: string }[];
    test.skip(!models.some((m) => m.id === STAND_IN), "needs the scripted provider: the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
    const settings = await (await request.get("/api/permissions/settings")).json();
    test.skip(sandbox !== "off" && !settings.sandbox.available, `needs the command sandbox: ${settings.sandbox.reason}`);
    const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
    const root = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `scope-${sandbox}-${Date.now()}`);
    const repo = join(root, "repo"), out = join(root, "lane-out");
    mkdirSync(repo, { recursive: true });
    mkdirSync(out, { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "README.md"), "# base\n");
    git(repo, "add", "-A");
    git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "first");
    const mainBefore = git(repo, "rev-parse", "main");

    const { session } = await (await request.post("/api/sessions", { data: { model: STAND_IN, workspace: repo, title: "Scope lead" } })).json();
    await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto", sandbox, network: false } });
    // (One more write in the sandbox: a path its words do not show, which only the sandbox refuses.)
    const hidden = `D=${out}; echo hidden > $D/hidden.txt`;
    const child = [
      { name: "Bash", input: { command: "echo in > inside.txt" } },
      { name: "Bash", input: { command: `echo out > ${out}/x.txt` } },
      { name: "Bash", input: { command: `echo again > ${out}/x.txt` } },
      { name: "Bash", input: { command: `echo bad > ${repo}/.git/probe` } },
      { name: "Bash", input: { command: "git commit --allow-empty -qm mine && git update-ref refs/heads/main HEAD" } },
      // (A here-document's lines are text the file is given: no write outside, and nothing asked.)
      { name: "Bash", input: { command: `cat > mk.sh <<'EOS'\necho h > ${out}/h.txt\nEOS` } },
      ...(sandbox === "off" ? [] : [{ name: "Bash", input: { command: hidden } }]),
    ];
    const spawn = [{ name: "spawn_agent", input: { message: `Scoped writer\nscript:calls ${JSON.stringify(child)}`, writes: ["."] } }];
    await request.post(`/api/sessions/${session.id}/messages`, { data: { text: `script:calls ${JSON.stringify(spawn)}` } });
    await page.goto(`/s/${session.id}`);

    // The question reaches the parent once, naming the path.
    const events = async () => (await (await request.get(`/api/sessions/${session.id}`)).json()).events as any[];
    const asks = async () => (await events()).filter((e) => e.kind === "user" && String(e.data.text).includes("asks to write outside the paths it was given"));
    await expect.poll(async () => (await asks()).length, { timeout: 90_000 }).toBeGreaterThan(0);
    const { agents } = await (await request.get(`/api/sessions/${session.id}/agents`)).json();
    const a = agents[0];
    const results = async () => (await (await request.get(`/api/sessions/${a.session_id}`)).json()).events.filter((e: any) => e.kind === "tool_result").flatMap((e: any) => e.data.results.map((r: any) => String(typeof r.content === "string" ? r.content : r.content.map((b: any) => b.text ?? "").join("\n"))));
    await expect.poll(async () => (await results()).length, { timeout: 60_000 }).toBe(child.length);
    const said = await results();
    expect(existsSync(join(a.worktree, "inside.txt"))).toBe(true);
    expect(said[1]).toContain("Your parent session was asked once");
    expect(said[2]).toContain("asked about it already");
    expect(said[3]).toContain("git directory of the owner's checkout");
    expect(said[3]).not.toContain("parent session was asked");
    expect(said[4]).toContain("another checkout of the repository has out");
    expect(said[5]).not.toContain("Refused");
    expect(existsSync(join(a.worktree, "mk.sh"))).toBe(true);
    if (sandbox !== "off") expect(said[6]).toContain("The sandbox refused a write outside the paths this agent may write");
    expect(existsSync(join(out, "x.txt"))).toBe(false);
    expect(existsSync(join(out, "hidden.txt"))).toBe(false);
    expect(existsSync(join(repo, ".git", "probe"))).toBe(false);
    expect(git(repo, "rev-parse", "main")).toBe(mainBefore);
    const x = join(out, "x.txt");
    await expect.poll(async () => (await asks()).filter((e) => String(e.data.text).includes(x)).length, { timeout: 30_000 }).toBe(1);
    expect((await asks()).some((e) => String(e.data.text).includes("h.txt"))).toBe(false);
    // The spawn's result told the parent where the agent writes and why.
    const spawned = (await events()).filter((e) => e.kind === "tool_result").flatMap((e) => e.data.results).map((r: any) => String(typeof r.content === "string" ? r.content : r.content.map((b: any) => b.text ?? "").join("\n")));
    expect(spawned.some((t) => t.includes("write_scope") && t.includes("its spawn named the paths it may write"))).toBe(true);
    const notice = page.getByTestId("write-ask-notice").first();
    await expect(notice).toContainText("asks to write outside the paths it was given", { timeout: 30_000 });
    await expect(notice).toContainText(x);
    await notice.scrollIntoViewIfNeeded();
    await shoot(page, `write-scope-01-question-${sandbox}`);

    // The parent's yes: the agent writes the path, and nothing is asked again.
    const yes = [{ name: "send_input", input: { target: a.id, message: `Go ahead.\nscript:calls ${JSON.stringify([{ name: "Bash", input: { command: `echo yes > ${out}/x.txt` } }])}`, writes: [x] } }];
    await request.post(`/api/sessions/${session.id}/messages`, { data: { text: `script:calls ${JSON.stringify(yes)}` } });
    await expect.poll(() => (existsSync(x) ? readFileSync(x, "utf8").trim() : ""), { timeout: 60_000 }).toBe("yes");
    expect((await asks()).filter((e) => String(e.data.text).includes(x)).length).toBe(1);
    expect(existsSync(join(repo, ".git", "probe"))).toBe(false);
    expect(git(repo, "rev-parse", "main")).toBe(mainBefore);
    const errorsAfter = (await (await request.get("/api/errors")).json()).errors.length;
    expect(errorsAfter).toBe(errorsBefore);
    await request.delete(`/api/sessions/${session.id}`);
  });
}

import { expect, test } from "./isolate.ts";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { openPanel, shoot } from "./shots.ts";

// Feature: agents on another machine. Two daemons on this machine stand in
// for two machines. A session starts an agent whose tools run on the other
// one, in a git worktree of its own there; it sends the agent a folder of its
// workspace (one path outside the workspace is refused); the agent reads it
// there. The agent's session shows its machine, and its terminal pane lists
// the commands that ran there. In Ask mode starting one asks, and a grant
// covers that machine. The scripted stand-in sends the exact calls.
const PEER = process.env.KEEL_PEER_URL ?? "http://127.0.0.1:47996";
const STAND_IN = "scripted:stand-in";
const script = (calls: unknown[]) => `script:calls ${JSON.stringify(calls)}`;

test("agents on another machine: spawn there, send files, the gate per machine", async ({ page, request }) => {
  const peerUp = await request.get(`${PEER}/api/health`, { timeout: 3000 }).then((r) => r.ok(), () => false);
  test.skip(!peerUp, `no peer daemon at ${PEER}: start a second daemon and set KEEL_PEER_URL and KEEL_PEER_ROOT`);
  const models = (await (await request.get("/api/models")).json()).models as { id: string }[];
  test.skip(!models.some((m) => m.id === STAND_IN), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;

  // The other daemon: the machine already enabled for it (the other fleet specs
  // pair it), else one paired here (the fleet spec covers pairing from the page).
  const { machines } = await (await request.get("/api/fleet/machines")).json();
  const known = machines.find((m: any) => m.daemon_url === PEER && m.workspace_root);
  const ROOT: string = known?.workspace_root ?? process.env.KEEL_PEER_ROOT ?? `${process.env.HOME}/.cache/keel-work/bun/dev-remote-peer/root`;
  const NAME: string = known?.name ?? "agentbox";
  let machineId: string = known?.id;
  if (!known) {
    const added = await request.post("/api/fleet/machines", { data: { name: NAME, daemon_url: PEER, workspace_root: ROOT } });
    expect(added.status()).toBe(201);
    machineId = (await added.json()).id;
  }

  // A repository on the other machine, and a folder of this session's workspace to send.
  const tag = Date.now().toString(36);
  const repo = `${ROOT}/agents-${tag}`;
  mkdirSync(repo, { recursive: true });
  writeFileSync(`${repo}/README.md`, "there\n");
  for (const a of [["init", "-q", "-b", "main"], ["add", "."], ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]]) execFileSync("git", a, { cwd: repo });
  const ws = `${process.env.HOME}/.cache/keel-work/bun/e2e-ws/agents-${tag}`;
  mkdirSync(`${ws}/notes`, { recursive: true });
  writeFileSync(`${ws}/notes/brief.txt`, `brief-${tag}\n`);

  const made: string[] = [];
  const newSession = async (title: string, mode: string) => {
    const { session } = await (await request.post("/api/sessions", { data: { model: STAND_IN, title, workspace: ws } })).json();
    await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode } });
    made.push(session.id);
    return session.id as string;
  };

  try {
    // Full auto: start it there, send it the notes, have it read them.
    const s = await newSession("Agent on another machine", "full-auto");
    const child = `Remote helper\n${script([{ name: "Bash", input: { command: "pwd; git branch --show-current" } }])}`;
    const later = script([{ name: "Bash", input: { command: "cat notes/brief.txt" } }]);
    await request.post(`/api/sessions/${s}/messages`, {
      data: {
        text: script([
          { name: "spawn_agent", input: { message: child, machine: NAME, cwd: `agents-${tag}` } },
          { name: "wait_agent", input: { targets: ["Remote helper"], timeout_ms: 30000 } },
          { name: "keel__send_files", input: { agent_id: "Remote helper", paths: ["notes", "/etc/hostname"] } },
          { name: "keel__send_files", input: { agent_id: "Remote helper", paths: ["notes"] } },
          { name: "send_input", input: { target: "Remote helper", message: later } },
          { name: "wait_agent", input: { targets: ["Remote helper"], timeout_ms: 30000 } },
        ]),
      },
    });
    await page.goto(`/s/${s}`);
    await expect(page.getByTestId("turn-end")).toBeVisible({ timeout: 60_000 });
    const call = page.getByTestId("agent-call").first();
    await expect(call.getByTestId("agent-call-machine")).toHaveText(NAME);
    await expect(call.getByTestId("agent-call-branch")).toContainText("keel/agent-");
    // What the calls answered: one path was outside the workspace, so nothing went; then the folder went.
    const results = (await (await request.get(`/api/sessions/${s}`)).json()).events
      .filter((e: any) => e.kind === "tool_result").flatMap((e: any) => e.data.results.map((r: any) => String(r.content)));
    expect(results.find((r: string) => r.includes("/etc/hostname"))).toContain("outside this session's directory");
    expect(results.find((r: string) => r.startsWith("Copied"))).toMatch(new RegExp(`^Copied 1 file\\(s\\), \\d+ bytes, to ${NAME} into ${ROOT}/\\.keel/worktrees/agent-`));
    expect(results.at(-1)).toContain(`brief-${tag}`);
    await expect(page.getByTestId("agent-call").first().getByTestId("agent-call-status")).toContainText("Done");
    await shoot(page, "fleet-agents-01-parent");

    // The agent's own session: its machine, and the commands that ran there.
    await call.getByTestId("agent-call-open").click();
    await expect(page.getByTestId("machine-chip")).toContainText(NAME);
    await openPanel(page, "terminal");
    const rows = page.getByTestId("terminal-panel").getByTestId("term-entry");
    await expect(rows).toHaveCount(2);
    await expect(rows.first().getByTestId("term-machine")).toHaveText(`on ${NAME}`);
    await rows.first().getByTestId("term-toggle").click();
    await expect(rows.first().getByTestId("term-output")).toContainText(`brief-${tag}`);
    await rows.last().getByTestId("term-toggle").click();
    await expect(rows.last().getByTestId("term-output")).toContainText(/\.keel\/worktrees\/agent-\w+\nkeel\/agent-/);
    await shoot(page, "fleet-agents-02-child-terminal");

    // Ask mode: the first start on that machine asks; a grant for the machine covers the next.
    const a = await newSession("Agents that ask", "ask");
    const quick = (t: string) => ({ name: "spawn_agent", input: { message: `${t}\nscript:calls []`, machine: NAME, isolation: "none" } });
    await request.post(`/api/sessions/${a}/messages`, { data: { text: script([quick("First helper"), quick("Second helper")]) } });
    await page.goto(`/s/${a}`);
    const card = page.getByTestId("approval");
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card).toContainText("keel__spawn_on_machine");
    await expect(card.getByTestId("approval-summary")).toContainText(NAME);
    await shoot(page, "fleet-agents-03-ask");
    await card.getByTestId("allow-always").click();
    await expect(page.getByTestId("grant-pattern")).toHaveValue(`keel__spawn_on_machine:${NAME.toLowerCase()}`);
    await page.getByTestId("grant-session").click();
    await expect(page.getByTestId("turn-end")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("agent-call")).toHaveCount(2);
    // The second start ran under the grant: no second card held the turn.
    await expect(page.getByTestId("approval")).toHaveCount(0);
  } finally {
    for (const id of made) await request.delete(`/api/sessions/${id}`);
    // Deleting the sessions takes the agent's worktree and branch there with it.
    await expect.poll(() => execFileSync("git", ["worktree", "list"], { cwd: repo }).toString().trim().split("\n").length, { timeout: 15_000 }).toBe(1);
    expect(execFileSync("git", ["branch", "--list", "keel/*"], { cwd: repo }).toString().trim()).toBe("");
    if (!known) await request.delete(`/api/fleet/machines/${machineId}`);
  }
  const errorsAfter = (await (await request.get("/api/errors")).json()).errors.length;
  expect(errorsAfter).toBe(errorsBefore);
});

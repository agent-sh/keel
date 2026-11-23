import { expect, test } from "./isolate.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { shoot } from "./shots.ts";

// Feature: agents start agents of their own. A root starts a coordinator and
// a sibling; the coordinator starts a worker and, after a daemon restart cut
// the tree mid-work, one that fails. The coordinator messages its sibling
// through the same queue a parent's message goes through; the failure two
// levels down is told to the coordinator that started it and shows in the
// root's record under it; the restart is told to each parent of the agents
// it cut; the session list shows the tree; and the owner's Stop on the
// coordinator stops the worker below it and holds both. The spec runs its own
// daemons on a scratch state folder, on the scripted stand-in.
const ROOT = join(process.env.HOME!, ".cache/keel-work/bun/e2e-state");

function daemon(state: string): Promise<{ proc: ChildProcess; url: string }> {
  const args = ["serve", "--bind", "127.0.0.1:0", "--state-dir", state, "--workspace", state];
  const proc = spawn("bun", ["src/main.ts", ...args], {
    // A config folder of its own: never the owner's.
    env: { ...process.env, KEEL_CONFIG_DIR: join(state, "config"), KEEL_SCRIPTED_PROVIDER: "1", KEEL_DRAIN_MS: "300", KEEL_DEFAULT_MODEL: "scripted:stand-in" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    let out = "";
    const t = setTimeout(() => reject(new Error(`no listen line:\n${out}`)), 30_000);
    const on = (d: Buffer) => {
      out += d;
      const m = out.match(/keel listening on (http:\/\/\S+?)\/? /);
      if (m) { clearTimeout(t); resolve({ proc, url: m[1]!.replace(/\/$/, "") }); }
    };
    proc.stdout!.on("data", on);
    proc.stderr!.on("data", on);
  });
}
const exited = (p: ChildProcess) => new Promise<void>((r) => (p.exitCode !== null ? r() : p.once("exit", () => r())));

const calls = (list: { name: string; input: unknown }[]) => `script:calls ${JSON.stringify(list)}`;
const bash = (command: string) => ({ name: "Bash", input: { command } });

test("agents start agents, message each other, and stop as a tree", async ({ page }) => {
  test.setTimeout(240_000);
  const state = join(ROOT, `agent-tree-${Date.now()}`);
  mkdirSync(state, { recursive: true });
  let d = await daemon(state);
  const api = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
    fetch(d.url + path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }).then((r) => r.json() as any);
  const events = async (id: string) => (await api(`/api/sessions/${id}`)).events as any[];
  // What a session was told: its inputs, and the notes that rode its requests (a restart's line).
  const said = (evs: any[]) => evs.filter((e) => e.kind === "user" || (e.kind === "note" && e.data.model)).map((e) => [e.data.text, ...(e.data.parts ?? []).map((p: any) => p.text)].join("\n")).join("\n\n");
  try {
    const { session } = await api("/api/sessions", { model: "scripted:stand-in", title: "Tree of agents" });
    await api(`/api/sessions/${session.id}/permissions`, { mode: "full-auto" }, "PUT");

    const worker = `Worker\n${calls([bash("sleep 5; echo first"), bash("sleep 120; echo second")])}`;
    const coordinator = `Coordinator\n${calls([
      { name: "spawn_agent", input: { message: worker } },
      bash("sleep 1"),
      { name: "send_input", input: { target: "Sibling", message: "hello from the coordinator" } },
      bash("sleep 6; echo coordinated"),
      { name: "spawn_agent", input: { message: "Broken\nscript:billing" } },
    ])}`;
    const sibling = `Sibling\n${calls([bash("sleep 8; echo sibling")])}`;
    // Both in one step, as a model starts parallel work.
    await api(`/api/sessions/${session.id}/messages`, { text: `script:batch ${JSON.stringify([{ name: "spawn_agent", input: { message: coordinator } }, { name: "spawn_agent", input: { message: sibling } }])}` });

    const tree = async () => (await api(`/api/sessions/${session.id}/agents`)).tree as any[];
    const node = async (title: string) => (await tree()).find((a) => a.title === title);
    const own = async (id: string) => ((await api(`/api/sessions/${id}/agents`)).agents as any[]).map((a) => a.title).sort();
    await expect.poll(() => own(session.id), { timeout: 30_000 }).toEqual(["Coordinator", "Sibling"]);
    const first = ((await api(`/api/sessions/${session.id}/agents`)).agents as any[]).find((a) => a.title === "Coordinator");
    // The coordinator starts an agent of its own.
    await expect.poll(() => own(first.session_id), { timeout: 30_000 }).toEqual(["Worker"]);
    expect((await tree()).map((a) => `${a.title}:${a.depth}`)).toEqual(["Coordinator:1", "Worker:2", "Sibling:1"]);
    const coord = await node("Coordinator");
    const sib = await node("Sibling");
    const work = await node("Worker");
    // A child never asks less than its parent: the full-auto root's grandchild runs in full-auto, not past it.
    expect((await api(`/api/sessions/${work.session_id}/permissions`)).perm.mode).toBe("full-auto");
    // The message between siblings is stored in the sibling's queue, named with its sender.
    await expect.poll(async () => (await api(`/api/sessions/${coord.session_id}`)).events.some((e: any) => e.kind === "tool_result" && JSON.stringify(e.data).includes("delivery")), { timeout: 30_000 }).toBe(true);

    // A crash while the tree works: the coordinator, its worker and the sibling are all mid-command.
    await page.waitForTimeout(1_500);
    d.proc.kill("SIGKILL");
    await exited(d.proc);
    d = await daemon(state);

    // Each parent is told of the agents of its own that the restart cut: the root of its two, the coordinator of its worker.
    await expect.poll(async () => said(await events(coord.session_id)), { timeout: 60_000 }).toContain('"Worker"');
    expect(said(await events(coord.session_id))).toMatch(/A daemon restart cut 1 of your agents mid-turn: "Worker" \(\w+\) resumed/);
    // The sibling read its sibling's message, said as from that agent.
    await expect.poll(async () => said(await events(sib.session_id)), { timeout: 60_000 }).toContain(`Message from agent "Coordinator" (${coord.id}), another agent of your session's tree:\nhello from the coordinator`);

    // The failure two levels down: told to the coordinator that started it, and in the root's record under the coordinator.
    await expect.poll(async () => (await tree()).find((a) => a.title === "Broken")?.status, { timeout: 60_000 }).toBe("failed");
    const broken = await node("Broken");
    expect(broken.depth).toBe(2);
    await expect.poll(async () => (await events(coord.session_id)).some((e) => e.kind === "user" && JSON.stringify(e.data).includes(broken.id) && JSON.stringify(e.data).includes('"failures"')), { timeout: 60_000 }).toBe(true);
    const record = (await api(`/api/errors?session=${session.id}`)).failures as any[];
    expect(record.some((g) => g.under?.id === coord.id && g.refs.some((r: any) => r.id === broken.id))).toBe(true);
    // The root's own notices never name it: it is the coordinator's agent.
    expect((await events(session.id)).filter((e) => e.kind === "user" && JSON.stringify(e.data).includes('"failures"')).some((e) => JSON.stringify(e.data).includes(broken.id))).toBe(false);

    // The root's restart line names its own agents.
    await expect.poll(async () => said(await events(session.id)), { timeout: 90_000 }).toMatch(/A daemon restart cut \d of your agents mid-turn: [^\n]*"(Coordinator|Sibling)"/);
    // The coordinator is not finished while its worker works: its turn ended, its record still runs.
    await expect.poll(async () => (await node("Coordinator")).status, { timeout: 30_000 }).toBe("running");
    expect((await node("Worker")).status).toBe("running");

    // The session list shows the tree: each agent's own under it, a step further in.
    await page.goto(`${d.url}/s/${session.id}`);
    const kids = page.getByTestId("session-list").locator(`[data-testid="session-row"][data-session="${session.id}"]`).locator("xpath=..").getByTestId("session-children");
    await expect(kids.getByTestId("children-total")).toContainText("4 agents");
    await kids.getByTestId("children-toggle").click();
    const rows = kids.getByTestId("child-row");
    await expect(rows).toHaveCount(4);
    await expect(rows.nth(0)).toHaveAttribute("data-depth", "1");
    await expect(rows.nth(0).getByTestId("child-title")).toHaveText("Coordinator");
    await expect(rows.nth(0).getByTestId("child-below")).toHaveText("+2");
    await expect(rows.nth(1)).toHaveAttribute("data-depth", "2");
    await expect(rows.nth(2)).toHaveAttribute("data-depth", "2");
    await expect(rows.nth(3).getByTestId("child-title")).toHaveText("Sibling");
    await shoot(page, "agent-tree-01-list");

    // The owner's Stop on the coordinator stops the worker below it, and holds both as the owner's.
    await rows.nth(0).hover();
    await rows.nth(0).getByTestId("child-stop").click();
    const confirm = page.getByTestId("confirm");
    await expect(confirm).toContainText("The agent below it stops too, and waits for you to resume it.");
    await shoot(page, "agent-tree-02-stop-asks");
    await confirm.getByRole("button", { name: "Stop agent" }).click();
    await expect.poll(async () => { const t = await tree(); return ["Coordinator", "Worker"].map((n) => { const a = t.find((x) => x.title === n); return `${a.status}:${a.stopped_by}`; }); }, { timeout: 30_000 })
      .toEqual(["stopped:owner", "stopped:owner"]);
    expect((await api(`/api/sessions/${work.session_id}`)).held).toBe(true);
    expect((await api(`/api/sessions/${coord.session_id}`)).held).toBe(true);
    // Held as the owner's: a message from the agent that started the worker waits in its queue and starts nothing.
    const sent = await api(`/api/sessions/${coord.session_id}/agents/${work.id}/message`, { message: "go on" });
    expect(sent.held).toBe(true);
    await page.waitForTimeout(1_000);
    expect((await node("Worker")).status).toBe("stopped");
    expect((await api(`/api/sessions/${work.session_id}`)).running).toBe(false);
    // The root hears of it from the coordinator, and of its sibling's own work.
    await expect.poll(async () => said(await events(session.id)), { timeout: 60_000 }).toContain(`agent_id="${coord.id}" title="Coordinator" status="stopped" stopped_by="owner"`);
    await expect.poll(async () => said(await events(session.id)), { timeout: 60_000 }).toContain(`agent_id="${sib.id}" title="Sibling" status="completed"`);
    await expect(rows.nth(0).getByTestId("child-state")).toHaveText(/stopped/i);
    await shoot(page, "agent-tree-03-stopped");
  } finally {
    d.proc.kill("SIGKILL");
    await exited(d.proc);
    rmSync(state, { recursive: true, force: true });
  }
});

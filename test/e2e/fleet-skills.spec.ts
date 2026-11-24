import { expect, test } from "./isolate.ts";
import { peerProblem } from "./peer.ts";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { shoot } from "./shots.ts";

// Feature: a session whose tools run on another machine takes its skills from
// that machine. Two daemons on this machine stand in for two machines. The
// other one has a skill in the folder the session works in (x) and one in its
// own folders (y); this one has a skill the other lacks (local-only). The
// session's prompt lists x and y and not local-only, the skill tool loads y's
// text from the other machine with that machine's path as the skill's
// directory, and asking for local-only is answered with what is available
// there. The scripted stand-in sends the exact calls.
const PEER = process.env.KEEL_PEER_URL ?? "http://127.0.0.1:47996";
const STAND_IN = "scripted:stand-in";
const script = (calls: unknown[]) => `script:calls ${JSON.stringify(calls)}`;

test("skills of a session on another machine come from that machine", async ({ page, request }) => {
  const peerWhy = await peerProblem(request, PEER);
  test.skip(!!peerWhy, peerWhy ?? "");
  const models = (await (await request.get("/api/models")).json()).models as { id: string }[];
  test.skip(!models.some((m) => m.id === STAND_IN), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const { machines } = await (await request.get("/api/fleet/machines")).json();
  const known = machines.find((m: any) => m.daemon_url === PEER && m.workspace_root);
  const ROOT: string = known?.workspace_root ?? process.env.KEEL_PEER_ROOT ?? `${process.env.HOME}/.cache/keel-work/bun/dev-remote-peer/root`;
  // Where each daemon keeps the skills of its owner: its config folder (the scratch daemons' sit beside their roots).
  const peerConfig = join(dirname(ROOT), "config");
  const here = process.env.KEEL_CONFIG_DIR;
  test.skip(!here || !existsSync(peerConfig), "needs both daemons' config folders: KEEL_CONFIG_DIR and the peer's beside its root (scripts/dev.sh)");

  const NAME: string = known?.name ?? "skillbox";
  let machineId: string = known?.id;
  if (!known) {
    const added = await request.post("/api/fleet/machines", { data: { name: NAME, daemon_url: PEER, workspace_root: ROOT } });
    expect(added.status()).toBe(201);
    machineId = (await added.json()).id;
  }

  const tag = Date.now().toString(36);
  const ws = `${ROOT}/skills-${tag}`;
  const skill = (dir: string, name: string, description: string, body: string) => {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`);
  };
  const x = `x-${tag}`, y = `y-${tag}`, only = `local-only-${tag}`;
  skill(join(ws, ".claude/skills"), x, "a skill of the peer's folder", "x body");
  skill(join(peerConfig, "skills"), y, "a skill of the peer's own folders", `y body: read \${CLAUDE_SKILL_DIR}/notes.md`);
  skill(join(here!, "skills"), only, "a skill only this machine has", "local body");

  const made: string[] = [];
  try {
    const { session } = await (await request.post("/api/fleet/sessions", { data: { machine: machineId, workspace: ws, model: STAND_IN, title: "Skills of the other machine" } })).json();
    made.push(session.id);
    await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto" } });
    await request.post(`/api/sessions/${session.id}/messages`, {
      data: { text: script([{ name: "Skill", input: { skill: y } }, { name: "Skill", input: { skill: only } }]) },
    });
    await page.goto(`/s/${session.id}`);
    await expect(page.getByTestId("turn-end").first()).toBeVisible({ timeout: 60_000 });

    // The prompt kept with the session: the other machine's skills, not this one's.
    const kept = await (await request.get(`/api/telemetry/prompt?session_id=${session.id}&text=1`)).json();
    expect(kept.text).toContain(`Skills on ${NAME}`);
    expect(kept.text).toContain(`- ${x}: a skill of the peer's folder`);
    expect(kept.text).toContain(`- ${y}: a skill of the peer's own folders`);
    expect(kept.text).not.toContain(only);

    // The calls: y's text from the other machine, its directory that machine's path; the local-only skill is not there.
    const results = (await (await request.get(`/api/sessions/${session.id}`)).json()).events
      .filter((e: any) => e.kind === "tool_result").flatMap((e: any) => e.data.results.map((r: any) => String(r.content)));
    expect(results[0]).toContain(`Base directory for this skill: ${peerConfig}/skills/${y}`);
    expect(results[0]).toContain(`y body: read ${peerConfig}/skills/${y}/notes.md`);
    expect(results[1]).toContain(`No skill named "${only}" on ${NAME}`);
    expect(results[1]).toMatch(new RegExp(`Available: .*${x}.*`));
    expect(results[1]).toContain(y);
    expect(results[1]).not.toContain(`Available: ${only}`);
    await shoot(page, "fleet-skills-01-peer-skills");
  } finally {
    for (const id of made) await request.delete(`/api/sessions/${id}`);
    rmSync(ws, { recursive: true, force: true });
    rmSync(join(peerConfig, "skills", y), { recursive: true, force: true });
    rmSync(join(here!, "skills", only), { recursive: true, force: true });
    if (!known) await request.delete(`/api/fleet/machines/${machineId}`);
  }
});

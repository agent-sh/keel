import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { handsRoutes } from "./hands-routes.ts";

// The skill routes serve a folder of the granted directory, not one a link inside it leads out to.
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

test("the skill routes refuse a folder that a link leads out of the granted directory", async () => {
  const base = mkdtempSync(join(process.env.TMPDIR ?? ".", "hands-skills-"));
  dirs.push(base);
  const granted = join(base, "granted");
  const outside = join(base, "outside");
  mkdirSync(join(outside, ".claude/skills/secret"), { recursive: true });
  writeFileSync(join(outside, ".claude/skills/secret/SKILL.md"), "---\nname: secret\ndescription: not for the peer\n---\nbody\n");
  mkdirSync(join(granted, "real"), { recursive: true });
  symlinkSync(outside, join(granted, "link"));
  const routes: any = handsRoutes({ spillRoot: join(base, "spill"), capture: () => {} } as any);
  const call = (path: string, cwd: string) =>
    routes[path].POST(new Request("http://x", { method: "POST", body: JSON.stringify({ cwd, root: granted, session: "s1", name: "secret" }) })) as Promise<Response>;
  for (const path of ["/api/fleet/hands/skills", "/api/fleet/hands/skill"]) {
    const out = await call(path, join(granted, "link"));
    expect(out.status).toBe(400);
    expect(JSON.stringify(await out.json())).not.toContain("secret/SKILL.md");
    expect((await call(path, join(granted, "real"))).status).toBe(200);
  }
});

// The walk up from the folder for a project's skills ends at the granted directory: a folder above it
// (here a repository's root over it) is not the peer's to read.
test("the skill routes stop the project walk at the granted directory", async () => {
  const base = mkdtempSync(join(process.env.TMPDIR ?? ".", "hands-skills-"));
  dirs.push(base);
  mkdirSync(join(base, ".git"));
  mkdirSync(join(base, ".claude/skills/above"), { recursive: true });
  writeFileSync(join(base, ".claude/skills/above/SKILL.md"), "---\nname: above\ndescription: over the granted folder\n---\nbody\n");
  const granted = join(base, "granted");
  mkdirSync(join(granted, ".claude/skills/inside"), { recursive: true });
  writeFileSync(join(granted, ".claude/skills/inside/SKILL.md"), "---\nname: inside\ndescription: in it\n---\nbody\n");
  const routes: any = handsRoutes({ spillRoot: join(base, "spill"), capture: () => {} } as any);
  const call = (path: string, name: string) =>
    routes[path].POST(new Request("http://x", { method: "POST", body: JSON.stringify({ cwd: granted, root: granted, session: "s1", name }) })) as Promise<Response>;
  const names = ((await (await call("/api/fleet/hands/skills", "")).json()) as { skills: { name: string }[] }).skills.map((s) => s.name);
  expect(names).toContain("inside");
  expect(names).not.toContain("above");
  const one = (await (await call("/api/fleet/hands/skill", "above")).json()) as { missing?: { names: string[] } };
  expect(one.missing?.names).toContain("inside");
  expect(one.missing?.names).not.toContain("above");
});

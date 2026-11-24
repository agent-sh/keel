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

import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { notManaged, workspaceRoutes } from "./workspace.ts";

test("the folders sessions used leave out the worktrees Keel made for agents", () => {
  const state = "/home/a/.local/share/keel/state";
  const used = ["/home/a/code/repo", `${state}/worktrees/keel-repo-1a2b3c`, `${state}/worktrees`, `${state}/artifacts/x`, "/home/a/code/worktrees-notes"];
  expect(notManaged(used, state)).toEqual(["/home/a/code/repo", `${state}/artifacts/x`, "/home/a/code/worktrees-notes"]);
});

// The Files panel's two file routes, on a state folder that is inside the folder they are asked about.
test("the file routes never show the daemon's own secrets, read a hostile offset as none, and frame a page with no base or form", async () => {
  const root = mkdtempSync(join(tmpdir(), "keel-files-"));
  try {
    const state = join(root, "state");
    mkdirSync(join(state, "artifacts"), { recursive: true });
    writeFileSync(join(state, "api-token"), "tok-0123456789");
    writeFileSync(join(state, "secret-key"), Buffer.alloc(32, 7));
    writeFileSync(join(state, "mcp-oauth.json"), "{}");
    writeFileSync(join(state, "artifacts", "note.txt"), "plain words");
    writeFileSync(join(state, "page.html"), "<p>hi</p>");
    const routes = workspaceRoutes({ store: { stateDir: state }, workspace: root } as any) as Record<string, { GET: (r: Request) => Promise<Response> }>;
    const ask = (route: string, path: string, more = "") => routes[route]!.GET(new Request(`http://x/${route}?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}${more}`));
    for (const route of ["/api/fs/raw", "/api/fs/file"]) {
      for (const name of ["state/api-token", "state/secret-key", "state/mcp-oauth.json"]) {
        const r = await ask(route, name);
        expect(r.status, `${route} ${name}`).toBe(403);
        expect(await r.text()).not.toContain("tok-0123456789");
      }
      expect((await ask(route, "state/artifacts/note.txt")).status, route).toBe(200);
    }
    const f = await (await ask("/api/fs/file", "state/artifacts/note.txt", "&offset=1e999")).json() as { from: number; text: string };
    expect(f.from).toBe(0);
    expect(f.text).toBe("plain words");
    const raw = await ask("/api/fs/raw", "state/page.html");
    const csp = raw.headers.get("content-security-policy")!;
    for (const part of ["default-src 'none'", "base-uri 'none'", "form-action 'none'", "navigate-to 'none'", "sandbox"]) expect(csp).toContain(part);
    expect(csp).not.toContain("allow-scripts");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

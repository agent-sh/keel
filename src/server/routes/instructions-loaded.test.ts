// Settings' As loaded and the session profile say what the prompt carries: the chain rendered for a
// model's window, with the trust pins, what repeats and the chain's bound applied, and for a folder
// with no session, which model and window the prediction is for.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Bus } from "../../core/bus.ts";
import { ErrorTracker } from "../../core/errors.ts";
import { Store } from "../../core/store.ts";
import { instructionFilter, instructionsMade } from "../../engine/turn.ts";
import { PromptStore } from "../../engine/prompt-store.ts";
import { surfaceRoutes } from "./surfaces.ts";
import { Trust } from "../../safety/trust.ts";
import { profileRoutes } from "./profile.ts";

const root = join(process.env.HOME!, ".cache/keel-work/bun/unit", `instructions-loaded-${process.pid}`);
afterAll(() => rmSync(root, { recursive: true, force: true }));

const rules = `# Rules\n\n${Array.from({ length: 30 }, (_, i) => `- shared rule ${i}: said in both files.`).join("\n")}\n`;
const tail = Array.from({ length: 1300 }, (_, i) => `- filler line ${i} of the long file, to pass a small window.`).join("\n");
const top = join(root, "top"), cwd = join(top, "work");
mkdirSync(cwd, { recursive: true });
writeFileSync(join(top, "AGENTS.md"), rules);
writeFileSync(join(cwd, "AGENTS.md"), `${rules}\n## Local\n\n- LOCAL-RULE: on disk now.\n\n## Long\n\n${tail}\n\nEND-RULE: the last line.\n`);
writeFileSync(join(cwd, "CLAUDE.md"), `${rules}\n## Local\n\n- LOCAL-RULE: on disk now.\n\n## Long\n\n${tail}\n\nEND-RULE: the last line.\n`);

const store = new Store(join(root, "state"));
const bus = new Bus();
const prompts = new PromptStore(store);
const models = [{ id: "s:small", name: "Small", context: 32_000, efforts: [], family: "claude", tools: false }, { id: "s:big", name: "Big", context: 1_000_000, efforts: [], family: "claude", tools: false }];
const providers = { models: async () => models, defaultModel: async () => "s:small", plugins: {}, get: () => undefined };
const deps = { store, bus, errors: new ErrorTracker(store, bus), engine: {}, workspace: cwd, providers } as any;
const surfaces = surfaceRoutes(deps) as any;
const profile = profileRoutes(deps) as any;
const view = async (q: string) => (await surfaces["/api/instructions"].GET(new Request(`http://x/api/instructions?${q}`))).json();
const fileOf = (v: any, p: string) => v.files.find((f: any) => f.path === p);

test("a folder's view is a prediction for the default model's window, as its prompt renders it", async () => {
  const v = await view(`cwd=${encodeURIComponent(cwd)}`);
  expect(v.loads).toMatchObject({ model: "Small", window: 32_000, prediction: true });
  const own = fileOf(v, join(cwd, "CLAUDE.md"));
  // The sections the folder above says are left out; the window cuts the rest, where the prompt cuts it.
  expect(own.loaded).not.toContain("shared rule 7:");
  expect(own.loaded).toContain("LOCAL-RULE");
  expect(own.state).toBe("cut");
  expect(own.loaded).not.toContain("END-RULE");
  expect(instructionsMade(cwd, 32_000).text).toContain(own.loaded);
  // The AGENTS.md beside it is the same text: named once, not carried.
  expect(v.same.map((x: any) => x.path)).toContain(join(cwd, "AGENTS.md"));
});

test("a session's view is for its own model's window; an untrusted edit shows as the version trusted", async () => {
  const s = store.createSession({ workspace: cwd, model: "s:big", title: "big" });
  const v = await view(`session=${s.id}`);
  expect(v.loads).toMatchObject({ model: "Big", window: 1_000_000, prediction: false });
  expect(fileOf(v, join(cwd, "CLAUDE.md")).loaded).toContain("END-RULE");
  const was = instructionFilter.file;
  instructionFilter.file = (p, t) => (p === join(cwd, "CLAUDE.md") ? "# Local\n\n- TRUSTED-RULE: last trusted.\n" : t);
  try {
    const t = fileOf(await view(`session=${s.id}`), join(cwd, "CLAUDE.md"));
    expect(t.loaded).toContain("TRUSTED-RULE");
    expect(t.loaded).not.toContain("LOCAL-RULE");
    expect(t.note).toContain("last trusted");
  } finally {
    instructionFilter.file = was;
  }
});

test("the profile reports the chain on the session's window, with its cuts", async () => {
  const s = store.createSession({ workspace: cwd, model: "s:small", title: "small" });
  const p = await (await profile["/api/sessions/:id/profile"].GET(Object.assign(new Request("http://x"), { params: { id: s.id } }))).json();
  expect(p.instructions.window).toBe(32_000);
  const own = p.instructions.files.find((f: any) => f.path === join(cwd, "CLAUDE.md"));
  expect(own.state).toBe("cut");
  expect(p.instructions.files.find((f: any) => f.path === join(cwd, "AGENTS.md")).state).toBe("same");
  expect(p.instructions.warnings.join("\n")).toContain("Small, a 32,000-token window");
  expect(p.instructions.stored).toBe("none");
  // A prompt kept from an earlier render (before a move, or an edit told as a note) is said to be one.
  prompts.put(s.id, { text: "x", split: 0, blocks: [{ name: "instruction files", hash: "h", bytes: 1 }], model: null });
  const q = await (await profile["/api/sessions/:id/profile"].GET(Object.assign(new Request("http://x"), { params: { id: s.id } }))).json();
  expect(q.instructions.stored).toBe("earlier");
});

// A view says what a start would load; only a start pins a file it sees first.
test("the views pin no file a start has not loaded yet", async () => {
  const repo = join(root, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  writeFileSync(join(repo, "AGENTS.md"), "# Repo\n\n- REPO-RULE: new here.\n");
  const trust = new Trust(store);
  const was = instructionFilter.file;
  instructionFilter.file = (p, t, look) => trust.instructionText(p, t, look);
  const pins = () => store.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM trust_pins WHERE path = ?").get(join(repo, "AGENTS.md"))!.n;
  try {
    const v = await view(`cwd=${encodeURIComponent(repo)}`);
    expect(fileOf(v, join(repo, "AGENTS.md")).loaded).toContain("REPO-RULE");
    const s = store.createSession({ workspace: repo, model: "s:big", title: "repo" });
    expect((await view(`session=${s.id}`)).files.length).toBeGreaterThan(0);
    await profile["/api/sessions/:id/profile"].GET(Object.assign(new Request("http://x"), { params: { id: s.id } }));
    expect(pins()).toBe(0);
    // A start's render pins it, as before.
    expect(instructionsMade(repo, 1_000_000).text).toContain("REPO-RULE");
    expect(pins()).toBe(1);
  } finally {
    instructionFilter.file = was;
  }
});

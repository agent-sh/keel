// Skills MCP servers serve (src/mcp/skills.ts), against a stand-in modern stdio server that serves them and logs
// what it is asked (test/e2e/fixtures/skills-mcp.ts): one skills/list at connect and no file read until a skill is
// used, the owner's allow once a server (kept, and bound to the manifests), the files read checked against the
// manifest, and no skills/list to a server that does not declare the extension.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpManager } from "./manager.ts";
import { entryOf, fileIn, manifestDigest, verifyFile, verifyFrontmatter } from "./skills.ts";

const FIXTURE = join(import.meta.dir, "../../test/e2e/fixtures/skills-mcp.ts");
const dir = mkdtempSync(join(tmpdir(), "keel-skills-"));
const managers: McpManager[] = [];
afterAll(() => { for (const m of managers) m.dispose(); rmSync(dir, { recursive: true, force: true }); });
const errors: string[] = [];
const sink = { capture(_k: string, e: unknown) { errors.push(String((e as Error)?.message ?? e)); } } as any;

// One scenario: a state folder, the stand-in's log and its mode file. `make()` is the daemon, again after a restart.
function scenario(name: string, extra: string[] = []) {
  const state = join(dir, `${name}-state`), log = join(dir, `${name}.log`), mode = join(dir, `${name}.mode`);
  writeFileSync(log, "");
  writeFileSync(mode, "");
  const told: string[] = [];
  const make = () => {
    const m = new McpManager(sink, state, "/");
    m.onToolsHeld = (n, _c, _i, skills) => void told.push(`${n}: ${(skills ?? []).map((k) => `${k.name} ${k.kind}`).join(", ")}`);
    (m as any).addEntry("sk", { command: "bun", args: [FIXTURE, "--log", log, "--mode", mode, ...extra] });
    managers.push(m);
    return m;
  };
  const asked = () => readFileSync(log, "utf8").split("\n").filter(Boolean);
  const reads = () => asked().filter((l) => l.startsWith("resources/read"));
  return { make, told, asked, reads, setMode: (v: string) => writeFileSync(mode, v) };
}
const held = (m: McpManager) => m.list().find((s) => s.name === "sk")!.held;
const text = (r: unknown) => (r && typeof r === "object" && "text" in r ? String((r as { text: string }).text) : "");
const error = (r: unknown) => (r && typeof r === "object" && "error" in r ? String((r as { error: string }).error) : "");

test("one skills/list at connect, no file read until a skill is used, and the server's skills wait for the owner's allow", async () => {
  const sc = scenario("first");
  const m = sc.make();
  await m.ensure("sk");
  expect(sc.asked().filter((l) => l === "skills/list")).toHaveLength(1);
  expect(sc.asked().filter((l) => l.startsWith("skills/get"))).toEqual([]);
  expect(sc.reads()).toEqual([]);
  // Listed, held: the model is offered nothing, and the owner is told once.
  expect(await m.skills()).toEqual([]);
  expect(held(m)!.skills!.map((k) => [k.name, k.kind, k.files])).toEqual([["code-review", "added", 2]]);
  expect(sc.told).toEqual(["sk: code-review added"]);
  // A skill that is not allowed is not read.
  expect(error(await m.loadSkill("mcp:sk:code-review"))).toMatch(/not allowed yet|No skill named/);
  expect(sc.reads()).toEqual([]);

  // The owner allows it, once.
  m.acceptTools("sk", held(m)!.digest);
  expect(held(m)).toBeUndefined();
  expect((await m.skills()).map((k) => [k.server, k.label])).toEqual([["sk", "mcp:sk:code-review"]]);
  expect(sc.reads()).toEqual([]); // allowed is not read

  // Loaded on demand: SKILL.md only; a supporting file when it is read.
  const loaded = text(await m.loadSkill("mcp:sk:code-review"));
  expect(loaded).toContain("# Code review");
  expect(loaded).toContain("MCP server sk");
  expect(loaded).not.toContain("description: Review"); // the frontmatter is not the instructions
  expect(loaded).toContain("references/checklist.md");
  expect(sc.reads()).toEqual(["resources/read skill://code-review/SKILL.md"]);
  expect(text(await m.skillFile("mcp:sk:code-review", "references/checklist.md"))).toContain("Check correctness");
  // Only the manifest's files: another skill's file, a path outside it, a file it does not name are refused unread.
  for (const path of ["skill://hidden/SKILL.md", "../hidden/SKILL.md", "references/missing.md", "/etc/passwd"]) {
    expect(error(await m.skillFile("mcp:sk:code-review", path))).toMatch(/is not a file of/);
  }
  expect(sc.reads()).toEqual(["resources/read skill://code-review/SKILL.md", "resources/read skill://code-review/references/checklist.md"]);
  expect(sc.asked().filter((l) => l === "skills/list")).toHaveLength(1);

  // The allow is kept: the daemon after a restart offers the skill and asks nobody again.
  m.dispose();
  const again = sc.make();
  await again.ensure("sk");
  expect((await again.skills()).map((k) => k.label)).toEqual(["mcp:sk:code-review"]);
  expect(held(again)).toBeUndefined();
  expect(sc.told).toHaveLength(1);

  // A manifest that changed revokes the allow: the owner is asked again, and nothing of the skill is read meanwhile.
  again.dispose();
  sc.setMode("rotate");
  const rotated = sc.make();
  await rotated.ensure("sk");
  expect(await rotated.skills()).toEqual([]);
  expect(held(rotated)!.skills!.map((k) => [k.name, k.kind])).toEqual([["code-review", "changed"]]);
  expect(sc.told).toHaveLength(2);
  const before = sc.reads().length;
  expect(error(await rotated.loadSkill("mcp:sk:code-review"))).toMatch(/not allowed yet/);
  expect(sc.reads().length).toBe(before);
  rotated.acceptTools("sk", held(rotated)!.digest);
  expect((await rotated.skills()).map((k) => k.label)).toEqual(["mcp:sk:code-review"]);
});

test("a file whose bytes are not its manifest's is not used, and a manifest that changed meanwhile is held", async () => {
  const sc = scenario("tamper");
  const m = sc.make();
  await m.ensure("sk");
  m.acceptTools("sk", held(m)!.digest);
  sc.setMode("tamper");
  expect(text(await m.loadSkill("mcp:sk:code-review"))).toContain("# Code review"); // SKILL.md is as its manifest says
  const bad = await m.skillFile("mcp:sk:code-review", "references/checklist.md");
  expect(error(bad)).toMatch(/does not match the digest/);
  expect(error(bad)).toMatch(/its own manifest/); // the entry was asked for again and still says the same
  expect(JSON.stringify(bad)).not.toContain("correctnxss");
  expect(sc.asked()).toContain("skills/get skill://code-review/SKILL.md");

  // The server rotated a file and its manifest with it after the owner allowed the skill: the read fails, the entry is refreshed, the allow is revoked.
  sc.setMode("rotate");
  expect(error(await m.skillFile("mcp:sk:code-review", "references/checklist.md"))).toMatch(/changed since you allowed/);
  expect(held(m)!.skills!.map((k) => k.kind)).toEqual(["changed"]);
  expect(await m.skills()).toEqual([]);
  expect(sc.told.at(-1)).toBe("sk: code-review changed");
});

test("a SKILL.md whose frontmatter is not its entry's is not used", async () => {
  const sc = scenario("front");
  sc.setMode("name");
  const m = sc.make();
  await m.ensure("sk");
  m.acceptTools("sk", held(m)!.digest);
  expect(error(await m.loadSkill("mcp:sk:code-review"))).toMatch(/frontmatter field description/);
});

test("a skill asked for by its URI that the listing does not hold comes from skills/get, and waits for the allow like a listed one", async () => {
  const sc = scenario("uri");
  const m = sc.make();
  await m.ensure("sk");
  m.acceptTools("sk", held(m)!.digest);
  expect(error(await m.loadSkill("mcp:sk:skill://hidden/SKILL.md"))).toMatch(/not allowed yet/);
  expect(sc.asked()).toContain("skills/get skill://hidden/SKILL.md");
  expect(sc.reads()).toEqual([]);
  expect(held(m)!.skills!.map((k) => k.name)).toEqual(["hidden"]);
  // It is the owner's to allow, with the listed one kept as it was.
  m.acceptTools("sk", held(m)!.digest);
  expect(text(await m.loadSkill("mcp:sk:skill://hidden/SKILL.md"))).toContain("An unlisted skill.");
  expect((await m.skills()).map((k) => k.label).sort()).toEqual(["mcp:sk:code-review", "mcp:sk:hidden"]);
  // An unknown URI is the server's -32602.
  expect(error(await m.loadSkill("mcp:sk:skill://nothing/SKILL.md"))).toMatch(/no skill/);
});

test("a skill with generated content is declined", async () => {
  const sc = scenario("dynamic");
  sc.setMode("dynamic");
  errors.length = 0;
  const m = sc.make();
  await m.ensure("sk");
  expect(held(m)!.skills!.map((k) => k.name)).toEqual(["code-review"]);
  expect(errors.join("\n")).toMatch(/gen\/SKILL.md is generated/);
});

test("a server that does not declare the extension is not sent skills/list, whatever it would answer", async () => {
  const sc = scenario("none", ["--no-extension"]);
  const m = sc.make();
  await m.ensure("sk");
  expect(await m.skills()).toEqual([]);
  expect(held(m)).toBeUndefined();
  expect(error(await m.loadSkill("mcp:sk:skill://hidden/SKILL.md"))).toMatch(/No skill named/);
  expect(sc.asked().filter((l) => l.startsWith("skills/"))).toEqual([]);
});

test("entries are checked as the spec says", () => {
  const md = "---\nname: code-review\ndescription: Review.\nmetadata:\n  team: core\n---\n# Review\n";
  const bytes = new TextEncoder().encode(md);
  const digest = `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`;
  const raw = { uri: "skill://code-review/SKILL.md", frontmatter: { name: "code-review", description: "Review.", metadata: { team: "core" } }, resources: [{ uri: "skill://code-review/SKILL.md", digest, size: bytes.length }] };
  const e = entryOf(raw);
  if ("problem" in e) throw new Error(e.problem);
  expect(verifyFile(bytes, e.entry.files[0]!)).toBeUndefined();
  expect(verifyFile(new Uint8Array([...bytes, 10]), e.entry.files[0]!)).toMatch(/bytes, its manifest says/);
  expect(verifyFile(new TextEncoder().encode(md.replace("# Review", "# Rewiew")), e.entry.files[0]!)).toMatch(/digest/);
  expect(verifyFrontmatter(md, e.entry)).toBeUndefined();
  expect(verifyFrontmatter(md.replace("team: core", "team: other"), e.entry)).toMatch(/metadata/);
  expect(verifyFrontmatter(md.replace("description: Review.", "description: Review.\nallowed-tools: Bash"), e.entry)).toMatch(/allowed-tools/);
  // An allow binds to every URI and digest: a file added, removed or rotated is another manifest; the order is not one.
  const more = { ...raw, resources: [...raw.resources, { uri: "skill://code-review/a.md", digest, size: 1 }] };
  const entry = (r: unknown) => (entryOf(r) as { entry: Parameters<typeof manifestDigest>[0] }).entry;
  expect(manifestDigest(entry(more))).not.toBe(manifestDigest(e.entry));
  expect(manifestDigest(entry({ ...raw, resources: [...more.resources].reverse() }))).toBe(manifestDigest(entry(more)));
  // Dynamic, missing and self-less manifests are not entries; a path leaves the manifest only by being in it.
  expect(entryOf({ ...raw, resources: "dynamic" })).toHaveProperty("problem");
  expect(entryOf({ ...raw, resources: undefined })).toHaveProperty("problem");
  expect(entryOf({ ...raw, resources: [{ uri: "skill://x", digest, size: 1 }] })).toHaveProperty("problem");
  expect(fileIn(e.entry, "SKILL.md")?.uri).toBe("skill://code-review/SKILL.md");
  expect(fileIn(e.entry, "../other/SKILL.md")).toBeUndefined();
});

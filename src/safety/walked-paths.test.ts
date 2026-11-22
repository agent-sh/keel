// A path is judged as the kernel walks it, and a file tool opens the path
// that was judged. A link followed by `..` is the parent of the link's
// target, not of the link: `<workspace>/sk/../hooks.json` with `sk` a link
// to Keel's config's skills folder is Keel's hooks file.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atCwd, canonical, realOf } from "../core/paths.ts";
import { claudeTools } from "../tools/claude.ts";
import { geminiTools } from "../tools/gemini.ts";
import { gptTools } from "../tools/gpt.ts";
import type { Tool, ToolContext } from "../tools/types.ts";
import { landing } from "./gate.ts";
import { classify, decide, type Mode } from "./policy.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "keel-walk-")));
const ws = join(root, "ws"), config = join(root, "config"), outside = join(root, "outside"), home = join(root, "home");
for (const d of [ws, join(config, "skills"), join(outside, "deep"), join(home, ".aws"), join(ws, "sub")]) mkdirSync(d, { recursive: true });
writeFileSync(join(config, "hooks.json"), "{}\n");
writeFileSync(join(outside, "file.txt"), "outside\n");
writeFileSync(join(home, ".aws/credentials"), "KEELMARK-aws\n");
writeFileSync(join(ws, "plain.txt"), "plain\n");
// The links a repository can ship or a command can make.
symlinkSync(join(config, "skills"), join(ws, "sk"));          // sk/.. is Keel's config
symlinkSync(join(outside, "deep"), join(ws, "out"));          // out/.. is a folder outside
symlinkSync(join(home, ".aws"), join(ws, "keys"));            // keys/../.aws/credentials
symlinkSync("../outside/deep", join(ws, "rel"));              // a relative target
symlinkSync("sk/..", join(ws, "twice"));                      // a target that itself ends in `..` after a link
symlinkSync("loop-b", join(ws, "loop-a")); symlinkSync("loop-a", join(ws, "loop-b"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("realOf walks a path as the kernel does: each part resolved, then `..` applied", () => {
  const same = (p: string) => { const a = statSync(p), b = statSync(realOf(p)); return a.ino === b.ino && a.dev === b.dev; };
  const cases: [string, string][] = [
    [`${ws}/sk/../hooks.json`, join(config, "hooks.json")],
    [`${ws}/sk/..`, config],
    [`${ws}/out/../file.txt`, join(outside, "file.txt")],
    [`${ws}/rel/../file.txt`, join(outside, "file.txt")],
    [`${ws}/keys/../.aws/credentials`, join(home, ".aws/credentials")],
    [`${ws}/twice/hooks.json`, join(config, "hooks.json")],
    [`${ws}/sub/../sk/../hooks.json`, join(config, "hooks.json")],
    [`${ws}//sk/./../hooks.json`, join(config, "hooks.json")],
    [`${ws}/sub/../plain.txt`, join(ws, "plain.txt")],
    [`${ws}/plain.txt`, join(ws, "plain.txt")],
  ];
  for (const [p, to] of cases) {
    expect([p, realOf(p)]).toEqual([p, to]);
    // The kernel agrees: the path as given and the resolved one are one file.
    expect([p, same(p)]).toEqual([p, true]);
  }
  // A file that does not exist yet lands where its folder really is.
  expect(realOf(`${ws}/sk/../new.json`)).toBe(join(config, "new.json"));
  expect(realOf(`${ws}/out/../made/new.txt`)).toBe(join(outside, "made/new.txt"));
  // A dangling link is followed (a write through it makes the file it names).
  symlinkSync(join(config, "made-by-link.json"), join(ws, "dangling"));
  expect(realOf(join(ws, "dangling"))).toBe(join(config, "made-by-link.json"));
  // A path the kernel refuses comes back as it was given, and opening that fails as the kernel says: a loop, more
  // links than it follows (a chain of 41 that ends at Keel's hooks file), a part after a file, a file named as a
  // folder, `..` after a part that does not exist. None of them is canonical.
  for (let i = 0; i < 41; i++) symlinkSync(i < 40 ? `mc${i + 1}` : join(config, "hooks.json"), join(ws, `mc${i}`));
  symlinkSync("plain.txt", join(ws, "to-file"));
  const refused: [string, string][] = [
    [`${ws}/loop-a/x`, "ELOOP"], [`${ws}/mc0`, "ELOOP"],
    [`${ws}/plain.txt/x`, "ENOTDIR"], [`${ws}/plain.txt/`, "ENOTDIR"], [`${ws}/plain.txt/.`, "ENOTDIR"], [`${ws}/plain.txt/..`, "ENOTDIR"], [`${ws}/plain.txt/../sk/../hooks.json`, "ENOTDIR"], [`${ws}/to-file/`, "ENOTDIR"],
    [`${ws}/missing/../sk/../hooks.json`, "ENOENT"], [`${ws}/missing/..`, "ENOENT"],
  ];
  for (const [p, code] of refused) {
    let got = "opened";
    try { statSync(realOf(p)); } catch (e) { got = (e as NodeJS.ErrnoException).code ?? "failed"; }
    let kernel = "opened";
    try { statSync(p); } catch (e) { kernel = (e as NodeJS.ErrnoException).code ?? "failed"; }
    expect([p, realOf(p), got, kernel, canonical(realOf(p))]).toEqual([p, p, code, code, false]);
  }
  // A chain the kernel follows (40 links) is followed.
  expect(realOf(`${ws}/mc1`)).toBe(join(config, "hooks.json"));
  // What the walk answers for a path the kernel takes is canonical; a path with a link, a dot or a doubled slash in it is not.
  for (const p of [join(config, "hooks.json"), join(ws, "plain.txt"), join(ws, "new/deep/file.txt"), "/"]) expect([p, canonical(p)]).toEqual([p, true]);
  for (const p of [`${ws}/sk/../hooks.json`, `${ws}/sk`, `${ws}/sk/x`, `${ws}//plain.txt`, `${ws}/./plain.txt`, `${ws}/plain.txt/`, "plain.txt", `${ws}/new/../x`]) expect([p, canonical(p)]).toEqual([p, false]);
  // A relative path starts at the folder given, and `..` in it is walked the same way.
  expect(realOf(atCwd(ws, "sk/../hooks.json"))).toBe(join(config, "hooks.json"));
  expect(atCwd(ws, "./sub//x.txt")).toBe(join(ws, "sub/x.txt"));
  expect(atCwd(ws, "sub/x.txt")).toBe(join(ws, "sub/x.txt"));
});

const facts = (mode: Mode) => ({ mode, workspace: ws, sandboxed: false, rules: [], tool: "t", home, config: [config] });
const how = (d: ReturnType<typeof decide>) => ("allow" in d ? "allow" : "deny" in d ? "deny" : d.ask.ownerOnly ? "owner" : `ask-${d.ask.risk}`);
const tool = (list: Tool[], name: string) => list.find((t) => t.name === name)!;
const patch = (body: string) => `*** Begin Patch\n${body}\n*** End Patch`;
// Every family's writers of one path, as [label, tool, input].
const writers = (p: string): [string, Tool, any][] => [
  ["Write", tool(claudeTools, "Write"), { file_path: p, content: "written\n" }],
  ["Edit", tool(claudeTools, "Edit"), { file_path: p, old_string: "{}", new_string: "{\"x\":1}" }],
  ["NotebookEdit", tool(claudeTools, "NotebookEdit"), { notebook_path: p, new_source: "x", edit_mode: "insert", cell_type: "code" }],
  ["write_file", tool(geminiTools, "write_file"), { file_path: p, content: "written\n" }],
  ["replace", tool(geminiTools, "replace"), { file_path: p, old_string: "{}", new_string: "{\"x\":1}" }],
  ["apply_patch add", tool(gptTools, "apply_patch"), { input: patch(`*** Add File: ${p}\n+written`) }],
  ["apply_patch update", tool(gptTools, "apply_patch"), { input: patch(`*** Update File: ${p}\n@@\n-{}\n+{"x":1}`) }],
  ["apply_patch delete", tool(gptTools, "apply_patch"), { input: patch(`*** Delete File: ${p}`) }],
  ["apply_patch move", tool(gptTools, "apply_patch"), { input: patch(`*** Update File: plain.txt\n*** Move to: ${p}\n@@\n-plain\n+moved`) }],
];

test("a chain of more links than the kernel follows is refused by the open, and never judged as a file of the workspace's", () => {
  // ch0 -> ch1 -> ... -> ch40 -> Keel's hooks file: 41 links. The kernel follows 40 and refuses the path.
  for (let i = 0; i <= 40; i++) symlinkSync(i === 40 ? join(config, "hooks.json") : `ch${i + 1}`, join(ws, `ch${i}`));
  const given = `${ws}/ch0`;
  expect(() => openSync(given, "r")).toThrow(/ELOOP/);
  const walked = realOf(given);
  expect(walked).toBe(given); // as it was given: not a link part way down the chain
  expect(() => openSync(walked, "r")).toThrow(/ELOOP/);
  expect(() => openSync(walked, "w")).toThrow(/ELOOP/);
  expect(readFileSync(join(config, "hooks.json"), "utf8")).toBe("{}\n");
  // One link fewer is a path the kernel opens, and it is judged where it lands.
  expect(realOf(`${ws}/ch1`)).toBe(join(config, "hooks.json"));
  expect(statSync(`${ws}/ch1`).ino).toBe(statSync(join(config, "hooks.json")).ino);
  // The same with a folder at the chain's end and a new file under it, and with a relative path.
  for (let i = 0; i <= 40; i++) symlinkSync(i === 40 ? config : `dh${i + 1}`, join(ws, `dh${i}`));
  expect(realOf(`${ws}/dh0/new.json`)).toBe(`${ws}/dh0/new.json`);
  expect(() => openSync(realOf(`${ws}/dh0/new.json`), "w")).toThrow(/ELOOP/);
  expect(existsSync(join(config, "new.json"))).toBe(false);
  expect(realOf(`${ws}/dh1/new.json`)).toBe(join(config, "new.json"));
});

test("a write through a workspace link followed by `..` is judged where it lands: every family's tools, absolute and relative", () => {
  for (const spelled of [`${ws}/sk/../hooks.json`, "sk/../hooks.json", `${ws}/twice/hooks.json`, `${ws}/sub/../sk/../hooks.json`]) {
    for (const [label, t, input] of writers(spelled)) {
      const cls = landing(classify(t, input, ws));
      // Keel's own configuration: the owner's alone in every asking mode, never an edit in the session's folder.
      for (const mode of ["ask", "auto-edits", "auto", "reviewer"] as Mode[]) expect([spelled, label, mode, how(decide(cls, facts(mode)))]).toEqual([spelled, label, mode, "owner"]);
    }
  }
  // A folder outside the workspace reached the same way is an edit outside it: a card in Auto edits, not a run.
  for (const spelled of [`${ws}/out/../file.txt`, "out/../file.txt", "rel/../file.txt"]) {
    for (const [label, t, input] of writers(spelled).filter(([l]) => l !== "apply_patch move")) {
      expect([spelled, label, how(decide(landing(classify(t, input, ws)), facts("auto-edits")))]).toEqual([spelled, label, "ask-low"]);
    }
  }
  // A plain path inside stays what it was.
  for (const [label, t, input] of writers("sub/../plain.txt").filter(([l]) => l !== "apply_patch move")) {
    expect([label, how(decide(landing(classify(t, input, ws)), facts("auto-edits")))]).toEqual([label, "allow"]);
  }
  // A command whose plain shape writes there is judged the same way.
  const shell = (command: string) => how(decide({ kind: "shell", command, cwd: ws }, { ...facts("auto-edits"), own: () => ({ home, config: [config], land: (x: string) => [realOf(x)] }) }));
  expect(shell("echo x >> sk/../hooks.json")).toBe("owner");
  expect(shell(`cp evil.json ${ws}/sk/../hooks.json`)).toBe("owner");
});

test("a file tool opens the path that was judged: what it writes and reads is the file the kernel reaches", async () => {
  const ctx = () => ({ cwd: ws, seen: new Map<string, number>(), signal: new AbortController().signal, session: { id: "s" } }) as unknown as ToolContext;
  const text = (r: any) => (typeof r.content === "string" ? r.content : JSON.stringify(r.content));
  // Writes: each lands in the folder outside (where the gate judged it), and nothing appears in the workspace.
  for (const [label, t, input] of [
    ["Write", tool(claudeTools, "Write"), { file_path: `${ws}/out/../w1.txt`, content: "one\n" }],
    ["write_file", tool(geminiTools, "write_file"), { file_path: "out/../w2.txt", content: "two\n" }],
  ] as [string, Tool, any][]) {
    const name = input.file_path.split("/").pop()!;
    const judged = landing(classify(t, input, ws));
    expect([label, judged.kind === "edit" && judged.paths.includes(join(outside, name))]).toEqual([label, true]);
    const r = await t.run(input, ctx());
    expect([label, r.is_error ?? false, existsSync(join(outside, name)), existsSync(join(ws, name))]).toEqual([label, false, true, false]);
  }
  // apply_patch refuses a file that lands outside the workspace unless the gate cleared it: it names where it lands.
  const add = await tool(gptTools, "apply_patch").run({ input: patch(`*** Add File: ${ws}/out/../w3.txt\n+three`) }, ctx());
  expect([add.is_error, text(add).includes(join(outside, "w3.txt")), existsSync(join(outside, "w3.txt")), existsSync(join(ws, "w3.txt"))]).toEqual([true, true, false, false]);
  // Edits: the file changed is the one outside.
  const c = ctx();
  await tool(claudeTools, "Read").run({ file_path: `${ws}/out/../file.txt` }, c);
  const edit = await tool(claudeTools, "Edit").run({ file_path: `${ws}/out/../file.txt`, old_string: "outside", new_string: "edited" }, c);
  expect([edit.is_error ?? false, readFileSync(join(outside, "file.txt"), "utf8")]).toEqual([false, "edited\n"]);
  // Reads: every family's reader returns the file the kernel reaches, under either spelling.
  for (const [label, t, input] of [
    ["Read", tool(claudeTools, "Read"), { file_path: `${ws}/keys/../.aws/credentials` }],
    ["Read, relative", tool(claudeTools, "Read"), { file_path: "keys/../.aws/credentials" }],
    ["read_file", tool(geminiTools, "read_file"), { file_path: "keys/../.aws/credentials" }],
  ] as [string, Tool, any][]) {
    const cx = ctx();
    const r = await t.run(input, cx);
    expect([label, text(r).includes("KEELMARK-aws")]).toEqual([label, true]);
    // What the tool remembers having read is the resolved file: the path a gate judges.
    expect([label, [...cx.seen.keys()]]).toEqual([label, [join(home, ".aws/credentials")]]);
  }
  // view_image: the same walk (the file is not an image; the refusal names the resolved path).
  const img = await tool(gptTools, "view_image").run({ path: `${ws}/keys/../.aws/credentials` }, ctx());
  expect(text(img)).toContain(join(home, ".aws/credentials"));
});

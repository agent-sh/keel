import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandLine, commandWords, DESCRIPTION_SHOWN, isFactName, isWriter, MemoryStore, parseFact } from "./memory-store.ts";

test("a fact is read as the store prints it: its own lines, the frontmatter flat, the body", () => {
  const f = parseFact("code-word", `# whose: code-word is agent note (2026-11-21)
---
name: code-word
description: "The code \\"word\\": heron"
type: design_decision
scope: user
source:
  harness: claude
  host: x
  kind: observed
created: "2026-11-21"
---

The code word is heron.
It was chosen for a test.`);
  expect(f.head).toEqual(["whose: code-word is agent note (2026-11-21)"]);
  expect(f.meta).toEqual({ name: "code-word", description: 'The code "word": heron', type: "design_decision", scope: "user", "source.harness": "claude", "source.host": "x", "source.kind": "observed", created: "2026-11-21" });
  expect(f.body).toBe("The code word is heron.\nIt was chosen for a test.");
  expect(f.replaced_by).toBeUndefined();
  // Text with no frontmatter is its body whole.
  expect(parseFact("x", "just words")).toMatchObject({ head: [], meta: {}, body: "just words" });
});

test("a replaced fact is read from its own part of the answer, not from the fact that replaced it", () => {
  const f = parseFact("old-fact", `# whose: new-fact is your words (2026-11-20)
old-fact was superseded by new-fact; the newer fact first, then the old one.

---
name: new-fact
description: The newer one
type: user_standard
scope: projects/other
source:
  kind: user
---

The newer body.
--- the old fact, old-fact ---
---
name: old-fact
description: The old one
type: design_decision
scope: user
superseded_by: new-fact
source:
  kind: observed
---

The old body.`);
  expect(f.meta).toMatchObject({ name: "old-fact", type: "design_decision", scope: "user", "source.kind": "observed" });
  expect(f.body).toBe("The old body.");
  expect(f.replaced_by).toBe("new-fact");
  expect(f.head).toEqual(["whose: new-fact is your words (2026-11-20)", "old-fact was superseded by new-fact; the newer fact first, then the old one."]);
});

test("a fact's name is the store's slug, a writer one of its writers' shape, and a command is quoted as a shell takes it", () => {
  for (const ok of ["code-word", "a", "keel-bun-e2e-2", "9-lives"]) expect(isFactName(ok)).toBe(true);
  for (const bad of ["--help", "-x", "", "a b", "a/b", "a;b", "Has_Upper.dot", "has.dot", "under_score", "The deploy token X lives in the vault at corp", "a".repeat(201), 3, null]) expect(isFactName(bad)).toBe(false);
  for (const ok of ["claude", "codex", "pi"]) expect(isWriter(ok)).toBe(true);
  for (const bad of ["", "Claude", "a b", "--x", "x;y", undefined]) expect(isWriter(bad)).toBe(false);
  expect(commandLine(["tacit", "add", "--desc", "it's a word", "name-1"])).toBe(`tacit add --desc 'it'\\''s a word' name-1`);
});

test("a store that is missing, slow or failing is said, within the wait, from a folder that is gone too", async () => {
  expect(await new MemoryStore(() => null, tmpdir()).search("anything")).toEqual({ state: "absent", ms: 0, hits: [] });
  expect((await new MemoryStore(() => null, tmpdir()).fact("code-word")).state).toBe("absent");
  const dir = mkdtempSync(join(tmpdir(), "keel-memory-store-"));
  try {
    const bin = join(dir, "store.sh");
    writeFileSync(bin, `#!/usr/bin/env bash\ncase "$1" in search) sleep 5 ;; fact) echo "fact: not found: $2" >&2; exit 1 ;; *) echo "add: refused: no" >&2; exit 2 ;; esac\n`);
    chmodSync(bin, 0o755);
    const store = new MemoryStore(() => bin, dir, () => "claude", { read: 150, write: 2000, confirm: 2000 });
    const t0 = performance.now();
    expect((await store.search("words", { cwd: join(dir, "not-there") })).state).toBe("slow");
    expect(performance.now() - t0).toBeLessThan(2000);
    expect((await store.fact("gone")).state).toBe("missing");
    // A correction of a fact the store no longer holds makes no command to confirm.
    expect(await store.preview("gone", "what is right")).toEqual({ state: "missing", error: undefined });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a correction runs the arguments that were shown, once, and only while the confirmation is fresh", async () => {
  const dir = mkdtempSync(join(tmpdir(), "keel-memory-confirm-"));
  try {
    const bin = join(dir, "store.sh"), log = join(dir, "calls"), type = join(dir, "type");
    writeFileSync(type, "design_decision");
    // \`fact\` answers with whatever type the file holds now; \`add\` logs its arguments, one a line.
    writeFileSync(bin, `#!/usr/bin/env bash
case "$1" in
  fact) printf -- '---\\nname: %s\\ntype: %s\\nscope: %s\\n---\\n\\nbody\\n' "$2" "$(cat ${JSON.stringify(type)})" "$([ "$2" = dash-scope ] && echo -- -rf || echo user)" ;;
  add)
    if [ "$2" = --help ]; then printf 'Usage of add:\\n  -body string\\n    \\tbody\\n  -harness string\\n    \\twriter harness, required: claude, codex, pi (the owner writes in the app)\\n  -kind string\\n    \\tsource kind\\n  -scope string\\n    \\tscope\\n  -type string\\n    \\ttype\\n' >&2; exit 2; fi
    if [ "$3" = keel ]; then echo 'add: unknown harness "keel"' >&2; exit 2; fi
    printf '%s\\n' "$@" >> ${JSON.stringify(log)}; echo "pushed to the store"; echo "added inbox/claude@x/$\{@: -1}.md" ;;
  search) printf '[{"Name":"long-one","Description":"%s","Score":0.0000030048780487804886},{"Name":"Not A Slug","Description":"x"}]' "$(head -c 900 /dev/zero | tr '\\0' 'd')"; printf '%s\\n' "$#" "$\{@: -1}" > ${JSON.stringify(join(dir, "query"))} ;;
esac
`);
    chmodSync(bin, 0o755);
    const store = new MemoryStore(() => bin, dir, () => "codex", { read: 2000, write: 2000, confirm: 150 });
    const text = "it's   $(touch nope) --flag\n; second line";
    const shown = await store.preview("code-word", text, { session: "s1" });
    expect(shown.state).toBe("confirm");
    expect(shown.command).toBe(`store.sh add --harness codex --kind user --type design_decision --scope user --desc 'it'\\''s $(touch nope) --flag ; second line' --body 'Corrects code-word, which the owner marked wrong in Keel. it'\\''s $(touch nope) --flag ; second line' code-word-correction`);
    expect(shown.words).toEqual(commandWords(["store.sh", "add", "--harness", "codex", "--kind", "user", "--type", "design_decision", "--scope", "user", "--desc", "it's $(touch nope) --flag ; second line", "--body", "Corrects code-word, which the owner marked wrong in Keel. it's $(touch nope) --flag ; second line", "code-word-correction"]));
    expect(shown.words!.join(" ")).toBe(shown.command!);
    expect(shown.writer).toContain("its writer codex: it has no writer for Keel");
    // The fact changes between the preview and the confirmation: what runs is what was shown.
    writeFileSync(type, "user_standard");
    expect(await store.confirm("no-such-id")).toEqual({ state: "expired", ms: 0 });
    expect(existsSync(log)).toBe(false);
    const sent = await store.confirm(shown.id);
    expect(sent).toMatchObject({ state: "ok", name: "code-word", session: "s1", page: true, where: "inbox/claude@x/code-word-correction.md" });
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["add", "--harness", "codex", "--kind", "user", "--type", "design_decision", "--scope", "user", "--desc", "it's $(touch nope) --flag ; second line", "--body", "Corrects code-word, which the owner marked wrong in Keel. it's $(touch nope) --flag ; second line", "code-word-correction"]);
    // The same confirmation again runs nothing.
    expect((await store.confirm(shown.id)).state).toBe("expired");
    expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(14);
    // One that waited past its time runs nothing either.
    const late = await store.preview("code-word", "later");
    await Bun.sleep(200);
    expect(await store.confirm(late.id)).toMatchObject({ state: "expired", name: "code-word" });
    expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(14);

    // The request that asked for the command is kept with it: one that came from no page stays so.
    const scripted = await store.preview("code-word", "from a script", { page: false });
    expect(await store.confirm(scripted.id)).toMatchObject({ state: "ok", page: false });
    // A scope that would read as an option is left out, not passed on.
    expect((await store.preview("dash-scope", "x")).command).toBe("store.sh add --harness codex --kind user --type user_standard --desc x --body 'Corrects dash-scope, which the owner marked wrong in Keel. x' dash-scope-correction");
    // The store names its writers in its own help; a writer it lacks is said when the note is refused.
    expect(await store.writers()).toEqual(["claude", "codex", "pi"]);
    const lacking = new MemoryStore(() => bin, dir, () => "keel", { read: 2000, write: 2000, confirm: 2000 });
    const refused = await lacking.confirm((await lacking.preview("code-word", "x")).id);
    expect(refused).toMatchObject({ state: "failed", no_writer: "keel" });

    // A search: the query is one argument; a long description is cut for the list; only slug names are results.
    const found = await store.search("  two   words ");
    expect(readFileSync(join(dir, "query"), "utf8").trim().split("\n")).toEqual(["6", "two words"]);
    expect(found.hits.map((h) => h.name)).toEqual(["long-one"]);
    expect(found.hits[0]).toMatchObject({ cut: true, score: 0.0000030048780487804886 });
    expect(found.hits[0]!.description).toHaveLength(DESCRIPTION_SHOWN);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

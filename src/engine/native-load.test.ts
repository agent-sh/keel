// A prompt rendered to be compared with the kept one, or to be shown, is not a load of the model's
// native memory: the sweep counts a load when a prompt that carries the memory is stored.
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ownEnv, tempTree } from "../../test/env.ts";
import type { Session } from "../core/types.ts";
import { nativeContext, slugOf } from "./native-memory.ts";
import { sessionParts } from "./turn.ts";

test("rendering the session's parts notes no load and hands the memory back for the caller to note", () => {
  const home = tempTree("native-load-");
  ownEnv({ KEEL_IMPORT_HOME: home, CLAUDE_CONFIG_DIR: undefined, CLAUDE_CODE_DISABLE_AUTO_MEMORY: undefined });
  const cwd = join(home, "work", "app");
  mkdirSync(cwd, { recursive: true });
  const dir = join(home, ".claude", "projects", slugOf(cwd), "memory");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "MEMORY.md"), "- [Note](note.md): a hook\n");
  const noted: string[] = [];
  const before = nativeContext.loaded;
  nativeContext.loaded = (s) => { noted.push(s.id); };
  try {
    const out = sessionParts(cwd, Date.now(), undefined, undefined, { family: "claude", top: true, session: { id: "s1" } as Session });
    expect(noted).toEqual([]);
    expect(out.native?.system).toBe("claude");
    expect(out.parts.find((p) => p.name === "native memory")?.text).toContain("a hook");
  } finally { nativeContext.loaded = before; }
});

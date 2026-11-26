// A tool call that reads the model's own harness's memory is a row of the memory meter and of the native log.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ownEnv, tempTree } from "../../test/env.ts";
import { Store } from "../core/store.ts";
import { allHooks } from "../engine/hooks.ts";
import { nativeContext, slugOf } from "../engine/native-memory.ts";
import { memoryMeter } from "./memory-meter.ts";
import { nativeLog, wireNativeLog } from "./native-log.ts";

const home = tempTree("native-log-");
ownEnv({ KEEL_IMPORT_HOME: home, CLAUDE_CODE_DISABLE_AUTO_MEMORY: undefined, CLAUDE_CODE_PROJECT_DIR_NAME: undefined, CLAUDE_CONFIG_DIR: undefined, CODEX_HOME: undefined });
const wired = { ...nativeContext };
const hooksAtStart = allHooks().length;
afterAll(() => { nativeContext.store = wired.store; nativeContext.loaded = wired.loaded; allHooks().length = hooksAtStart; });

test("a Read or a shell command on the auto memory folder is one meter row with the tokens it carried, and a write is none", () => {
  const store = new Store(join(home, "state"));
  afterAll(() => store.db.close());
  wireNativeLog(store, () => false);
  const cwd = join(home, "work", "app");
  mkdirSync(cwd, { recursive: true });
  const dir = join(home, ".claude", "projects", slugOf(cwd), "memory");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "MEMORY.md"), "- [a](a.md)\n");
  const s = store.createSession({ model: "claude-x", workspace: cwd, title: "t" });
  const log = nativeLog(store);
  const text = "x".repeat(4000);
  const rows = () => memoryMeter(store).report({ session: s.id }).paths.find((p) => p.path === "native_read");

  // A Read of the index.
  log.after(s, { name: "Read" }, { file_path: join(dir, "MEMORY.md") }, { is_error: false, content: text });
  expect(rows()).toMatchObject({ asked: 1, recalls: 1 });
  expect(rows()!.tokens).toBeGreaterThan(500);
  // A shell command that names the folder; a failed read; a call elsewhere; a write.
  log.after(s, { name: "Bash", kind: "shell" }, { command: `cat ${dir}/a.md` }, { is_error: false, content: "short" });
  log.after(s, { name: "Read" }, { file_path: join(dir, "b.md") }, { is_error: true, content: "no such file" });
  log.after(s, { name: "Read" }, { file_path: join(cwd, "src.ts") }, { is_error: false, content: text });
  log.after(s, { name: "Write", kind: "edit" }, { file_path: join(dir, "c.md"), content: "x" }, { is_error: false, content: "ok" });
  expect(rows()).toMatchObject({ asked: 2 });
  // A command that only names the folder where no reader's file can be told (a pipe) is a look, not a read: no bytes.
  log.after(s, { name: "Bash", kind: "shell" }, { command: `ls ${dir} | wc -l` }, { is_error: false, content: "3" });
  expect(rows()).toMatchObject({ asked: 2 });
  // The headline of what recall did does not count a read the model chose to make.
  expect(memoryMeter(store).report({ session: s.id }).total.asked).toBe(0);
  // The sweep's own log keeps its rows: two reads, a write and the look.
  const logged = store.db.query<{ action: string }, []>("SELECT action FROM native_memory_log WHERE action != 'loaded' ORDER BY id").all().map((r) => r.action);
  expect(logged).toEqual(["read", "read", "wrote", "looked"]);
});

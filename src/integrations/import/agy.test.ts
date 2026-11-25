// Antigravity's command line store as it is laid out on disk: the list in conversation_summaries.db,
// the transcript under brain/<id>/.system_generated/logs, a prompt's media in .user_uploaded.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agySessions, readAgy } from "./agy.ts";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

function store() {
  const home = mkdtempSync(join(tmpdir(), "keel-agy-"));
  const cli = join(home, "antigravity-cli");
  mkdirSync(cli, { recursive: true });
  const db = new Database(join(cli, "conversation_summaries.db"), { create: true });
  db.exec("CREATE TABLE `conversation_summaries` (`conversation_id` text,`title` text NOT NULL DEFAULT \"\",`preview` text NOT NULL DEFAULT \"\",`step_count` integer NOT NULL DEFAULT 0,`last_modified_time` datetime NOT NULL,`workspace_uris` text NOT NULL,`parent_conversation_id` text NOT NULL DEFAULT \"\",`last_user_input_time` datetime NOT NULL, PRIMARY KEY (`conversation_id`))");
  const t = Date.now() - 60_000;
  const go = (ms: number) => new Date(ms).toISOString().replace("T", " ").replace("Z", "000000+00:00");
  const row = db.query("INSERT INTO conversation_summaries (conversation_id, title, preview, last_modified_time, workspace_uris, parent_conversation_id, last_user_input_time) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const cwd = join(home, "project");
  row.run("aaaa1111-0000-4000-8000-000000000001", "Quince notes", "Which fruit?", go(t + 9000), JSON.stringify([`file://${cwd}`]), "", go(t));
  row.run("aaaa1111-0000-4000-8000-000000000002", "Child", "", go(t + 5000), JSON.stringify([`file://${cwd}`]), "aaaa1111-0000-4000-8000-000000000001", go(t));
  db.close();
  const at = (i: number) => go(t + i * 1000);
  const dir = (id: string) => { const d = join(cli, "brain", id, ".system_generated", "logs"); mkdirSync(d, { recursive: true }); return d; };
  const up = join(cli, "brain", "aaaa1111-0000-4000-8000-000000000001", ".user_uploaded");
  mkdirSync(up, { recursive: true });
  writeFileSync(join(up, "shot.png"), PNG);
  const main = [
    { step_index: 0, type: "USER_INPUT", source: "USER_EXPLICIT", status: "DONE", created_at: at(0), content: "<USER_REQUEST>Which fruit is in the notes?</USER_REQUEST>", media: [{ mime_type: "image/png", uri: "/Users/someone/.gemini/antigravity/brain/x/.user_uploaded/shot.png" }, { mime_type: "audio/wav", uri: "/Users/someone/.gemini/antigravity/brain/x/.user_uploaded/voice.wav" }] },
    { step_index: 1, type: "PLANNER_RESPONSE", source: "MODEL", status: "DONE", created_at: at(1), model: "agy-model-a", input_tokens: 10, output_tokens: 5, thinking: "look", tool_calls: [{ name: "run_command", args: { CommandLine: "cat notes.md" } }, { name: "run_command", args: { CommandLine: "cat gone.md" } }, { name: "view_file", args: { AbsolutePath: "/x" } }] },
    { step_index: 2, type: "RUN_COMMAND", source: "MODEL", status: "DONE", created_at: at(2), exit_code: 0, content: "quince" },
    { step_index: 3, type: "RUN_COMMAND", source: "MODEL", status: "DONE", created_at: at(3), exit_code: 1, content: "cat: gone.md: No such file" },
    { step_index: 4, type: "GENERIC", source: "MODEL", status: "RUNNING", created_at: at(4), content: "recorded while it ran" },
    { step_index: 5, type: "PLANNER_RESPONSE", source: "MODEL", status: "ERROR", created_at: at(5), model: "agy-model-a", error: "quota exceeded" },
    { step_index: 6, type: "PLANNER_RESPONSE", source: "MODEL", status: "DONE", created_at: at(6), model: "agy-model-b", content: "The fruit is quince." },
    { step_index: 7, type: "ERROR_MESSAGE", source: "SYSTEM", status: "DONE", created_at: at(7), error: "stray error" },
  ];
  writeFileSync(join(dir("aaaa1111-0000-4000-8000-000000000001"), "transcript_full.jsonl"), main.map((r) => JSON.stringify(r)).join("\n") + "\n");
  writeFileSync(join(dir("aaaa1111-0000-4000-8000-000000000002"), "transcript_full.jsonl"), JSON.stringify({ step_index: 0, type: "PLANNER_RESPONSE", status: "DONE", created_at: at(0), model: "agy-model-a", content: "child done" }) + "\n");
  return { home, cwd };
}

test("an Antigravity conversation lists with its folder, model and subagent, and reads with its failures as failures", async () => {
  const { home, cwd } = store();
  const rows = agySessions(home);
  const main = rows.find((r) => r.id.endsWith("1"))!;
  expect(main).toMatchObject({ harness: "agy", title: "Quince notes", cwd, kind: "interactive", model: "agy-model-b" });
  expect(rows.find((r) => r.id.endsWith("2"))).toMatchObject({ kind: "subagent", parent_id: main.id });

  const r = await readAgy(main);
  expect(r.counts).toMatchObject({ prompts: 1, tool_calls: 3, thoughts_dropped: 1 });
  const user = r.events.find((e) => e.kind === "user")!;
  // The image is read from the conversation's upload folder; the audio is named as not carried.
  expect(user.data.images[0]).toMatchObject({ type: "image", media_type: "image/png" });
  expect(user.data.images[1].text).toContain("voice.wav");
  const results = r.events.filter((e) => e.kind === "tool_result").flatMap((e) => e.data.results);
  expect(results.map((x: any) => [x.is_error ?? false, String(x.content).slice(0, 30)])).toEqual([
    [false, "quince"],
    [true, "cat: gone.md: No such file\n[exit code 1]".slice(0, 30)],
    // A step recorded while it still ran is no failure.
    [false, "recorded while it ran"],
  ]);
  // The model request that failed is a note with its words; the stray error step has no call to answer.
  expect(r.events.some((e) => e.kind === "note" && String(e.data.text).includes("quota exceeded"))).toBe(true);
  expect(r.events.filter((e) => e.kind === "assistant").map((e) => e.data.model)).toEqual(["agy-model-a", "agy-model-b"]);
  expect(r.notes.join(" ")).toContain("agy-model-a, agy-model-b");
});

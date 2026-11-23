import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../core/store.ts";
import { ScriptedProvider } from "../providers/scripted.ts";
import { askedFor, askJudge, judgePrompt, PARENT_MESSAGES } from "./judge.ts";

// A parent that moves its agent's work in a later message (a scratch folder
// given after the task) is read by the judge too, the newest few, so a call on
// the moved folder is not taken for one nobody asked for.
test("the judge of an agent's call reads its task and the newest messages its parent sent since", () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "judge-"));
  const store = new Store(join(dir, "state"));
  store.migrate("ALTER TABLE sessions ADD COLUMN parent_id TEXT");
  const root = store.createSession({ model: "m:x", workspace: dir, title: "Lead" });
  const kid = store.createSession({ model: "m:x", workspace: dir, title: "Agent" });
  store.db.query("UPDATE sessions SET parent_id = ? WHERE id = ?").run(root.id, kid.id);
  store.append(root.id, "user", { text: "clean up the probe folders when done" });
  store.append(kid.id, "user", { kind: "task", agent_id: "ag-1", text: "Task:\nbuild the probe in scratch/a" });
  store.append(kid.id, "assistant", { blocks: [{ type: "text", text: "working" }] });
  for (let i = 1; i <= PARENT_MESSAGES + 2; i++) {
    store.append(kid.id, "user", { kind: "steer", agent_id: "ag-1", text: `Message from the session that started you:\nmove to scratch/m${i}` });
  }
  store.append(kid.id, "user", { kind: "wait", text: "[harness] a job ended" });

  const a = askedFor(store, kid.id);
  expect(a.owner).toEqual(["- clean up the probe folders when done"]);
  expect(a.task).toBe("Task:\nbuild the probe in scratch/a");
  // The newest four, oldest first, without the delivery's heading.
  expect(a.parent).toEqual([3, 4, 5, 6].map((i) => `- move to scratch/m${i}`));

  const p = judgePrompt({ session: { ...store.session(kid.id)!, workspace: dir }, tool: "Bash", kind: "exec", summary: "rm -rf scratch/m6", input: {}, mode: "reviewer" } as any, a);
  expect(p.text).toContain("The newest messages its parent session sent it since the task");
  expect(p.text).toContain("- move to scratch/m6");
  expect(p.text).not.toContain("scratch/m2");

  // A session of the owner's own has no task and no parent's messages.
  expect(askedFor(store, root.id)).toEqual({ owner: ["- clean up the probe folders when done"] });
});

// A judge model that thinks before it answers (adaptive thinking runs at a high effort when the
// model offers no low one) gives its verdict: the request leaves it the model's own output limit.
test("a judge that thinks before its verdict has the room to give it", async () => {
  const provider = new ScriptedProvider();
  const listed = (await provider.list()).find((m) => m.model === "stand-in")!;
  const text = "The owner's recent messages (oldest first):\n- write the marker\n\nThe action: tool Write (write)\njudge-thinks.txt";
  for (const efforts of [[], ["low", "high"], ["medium", "high"]]) {
    const info = { ...listed, id: "scripted:stand-in", provider: "scripted", efforts };
    const providers = { resolve: async () => ({ provider, info }) } as any;
    const r = await askJudge(providers, info.id, { system: "Judge the action.", text }, "judge-thinks");
    expect([efforts, r.v?.decision]).toEqual([efforts, "allow"]);
  }
});

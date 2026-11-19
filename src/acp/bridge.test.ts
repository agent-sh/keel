import { expect, test } from "bun:test";
import { permissionRequest } from "./bridge.ts";

test("an editor's permission request carries the card's reason", () => {
  const card = { session_id: "s", call_id: "c", tool: "Bash", summary: "git push --force", input: { command: "git push --force" }, risk: "high", why: "the command rewrites or deletes history on a remote", suggest: [] };
  const r = permissionRequest(card, "Bash");
  expect(r.toolCall.content).toEqual([{ type: "content", content: { type: "text", text: "High risk: the command rewrites or deletes history on a remote." } }]);
  expect(r.options.map((o: any) => o.optionId)).toEqual(["once", "deny"]);
  const low = permissionRequest({ ...card, risk: "low", why: undefined, notice: "Reviewer unavailable: no reviewer is set up. The owner answers this one.", suggest: [{ kind: "shell", pattern: "git push *" }] }, "Bash");
  expect(low.toolCall.content[0].content.text).toContain("Reviewer unavailable");
  expect(low.options.map((o: any) => o.optionId)).toEqual(["once", "always", "deny"]);
});

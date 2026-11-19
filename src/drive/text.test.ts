import { expect, test } from "bun:test";
import { decide, type Facts } from "../safety/policy.ts";
import { harnessCommand, outsideText, pickChoice, promptHash } from "./text.ts";

test("what a delivery drops is dropped first, so a hidden command is found", () => {
  const t = outsideText("\u0001!touch x");
  expect(t.text).toBe("!touch x");
  expect(t.changed).toBe(1);
  expect(harnessCommand(t.text, "claude")).toContain("shell command");
  expect(outsideText("a\u200bb\rc\r\nd").text).toBe("ab\nc\nd");
  expect(harnessCommand(outsideText("ok /permissions").text, "claude")).toContain("command to the session's harness");
  expect(() => outsideText("\u200b\u0007 ")).toThrow();
});

test("mentions: @ for every harness, $ only for Codex, addresses and env names are text", () => {
  expect(harnessCommand("read @src/main.ts", "claude")).toContain("@ mention");
  expect(harnessCommand("mail me@example.com", "claude")).toBeUndefined();
  expect(harnessCommand("run $deploy now", "codex")).toContain("$ mention");
  expect(harnessCommand("[$app](app://x)", "codex")).toContain("$ mention");
  expect(harnessCommand("echo $HOME and $path", "codex")).toBeUndefined();
  expect(harnessCommand("run $deploy now", "claude")).toBeUndefined();
  expect(harnessCommand("fine\n  -- --dangerously-skip-permissions", "codex")).toContain("flags");
});

test("an option decides the answer; a contradicting decision is refused; the hash covers the menu", () => {
  const p = { id: "r1", body: "rm -rf build", choices: [{ value: "1", label: "Yes" }, { value: "2", label: "Yes, and don't ask again" }, { value: "3", label: "No, and tell Claude" }] };
  expect(pickChoice(p, "deny").value).toBe("3");
  expect(() => pickChoice(p, "allow")).toThrow(); // two options start with yes
  expect(() => pickChoice(p, "deny", "2")).toThrow();
  expect(pickChoice(p, "allow", "2").allows).toBe(true);
  const changed = { ...p, choices: [...p.choices.slice(0, 2), { value: "3", label: "Yes, always" }] };
  expect(promptHash(changed)).not.toBe(promptHash(p));
});

test("driving: only a drive answer covers a send; what is the owner's no mode covers", () => {
  const base: Facts = { mode: "ask", workspace: "/w", sandboxed: false, rules: [], tool: "keel__session_message" };
  const send = { kind: "drive" as const, target: "claude:a", resource: "keel__session_message:claude:a", shown: "hi" };
  const rule = (pattern: string) => ({ id: pattern, kind: "tool" as const, pattern, scope: "/w", lifetime: "always" as const, created: 0 });
  expect(decide(send, base)).toHaveProperty("ask");
  expect(decide(send, { ...base, rules: [rule("keel__session_message")] })).toHaveProperty("ask");
  expect(decide(send, { ...base, rules: [rule("drive:claude:a")] })).toEqual({ allow: true });
  expect(decide(send, { ...base, mode: "full-auto" })).toEqual({ allow: true });
  expect(decide(send, { ...base, mode: "read-only" })).toHaveProperty("deny");
  const owner = { ...send, owner: "a line that starts with !" };
  const d = decide(owner, { ...base, mode: "full-auto", rules: [rule("drive:*")] }) as any;
  expect(d.ask.risk).toBe("high");
  expect(decide(owner, { ...base, rules: [rule("keel__session_message:*")] })).toEqual({ allow: true });
});

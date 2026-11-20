import { expect, test } from "bun:test";
import { redact } from "./admin.ts";

// A report keeps Keel's own placeholders: they hold no value, and the text
// after one (the rest of a path) is what the reader needs.
test("a report redacts keyed values and leaves a secret's placeholder", () => {
  const mark = "[secret:" + "0a1b2c3d]";
  expect(redact(`{"workdir":"/srv/${mark}/work/lane","cmd":"ls"}`)).toBe(`{"workdir":"/srv/${mark}/work/lane","cmd":"ls"}`);
  expect(redact("password: " + "hunter2hunter2 next")).toBe("password: [redacted] next");
  expect(redact("secret=" + "0a1b2c3d4e5f")).toBe("secret=[redacted]");
});

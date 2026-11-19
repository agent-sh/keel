import { expect, test } from "bun:test";
import { splitEndpoint } from "./config.ts";

// A providers.toml entry moves to its own file with its comments; the rest of
// the owner's file stays byte for byte, the entry kept there as comments.
test("an endpoint moves out of providers.toml with its comments, the rest untouched", () => {
  const text = `# My providers
[[endpoint]]
id = "lab"
# the lab box, ask before changing
label = "Lab"
base_url = "http://127.0.0.1:8000/v1"
key_env = "LAB_KEY"

[endpoint.model."qwen-32b"]
context = 32768 # its real window

# The second one
[[endpoint]]
id = "other"
base_url = "http://127.0.0.1:9000/v1"

[mcp]
x = 1
`;
  const { file, rest } = splitEndpoint(text, "lab", "2026-11-19");
  expect(file).toBe(`# Moved from providers.toml by Keel on 2026-11-19. Edit freely.
# the lab box, ask before changing
label = "Lab"
base_url = "http://127.0.0.1:8000/v1"
key_env = "LAB_KEY"

[model."qwen-32b"]
context = 32768 # its real window
`);
  expect(rest).toContain("# Moved to endpoints/lab.toml by Keel on 2026-11-19");
  expect(rest).toContain('# id = "lab"');
  expect(rest).toContain("# the lab box, ask before changing");
  expect(rest.endsWith(text.slice(text.indexOf("# The second one")))).toBe(true);
  expect((Bun.TOML.parse(rest) as any).endpoint.map((e: any) => e.id)).toEqual(["other"]);
  expect(() => splitEndpoint(text, "none")).toThrow(/no \[\[endpoint\]\]/);
});

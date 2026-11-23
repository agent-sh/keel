import { expect, test } from "bun:test";
import { checkValue, fillContent, hookRefusal, optionEnv, parseUserConfig, resolve, serverRefusal, substitute } from "./options.ts";

test("userConfig is read as the reference says: strict options, typed defaults, fixed choices", () => {
  const ok = parseUserConfig({
    api_endpoint: { type: "string", title: "API endpoint", description: "Your endpoint", required: true },
    tone: { type: "string", title: "Tone", description: "Voice", options: ["neutral", "warm"], default: "neutral" },
    retries: { type: "number", title: "Retries", description: "", min: 1, max: 5, default: 3 },
    hosts: { type: "string", title: "Hosts", description: "", multiple: true, default: ["a", "b"] },
  });
  expect(ok.problems).toEqual([]);
  expect(Object.keys(ok.specs)).toEqual(["api_endpoint", "tone", "retries", "hosts"]);
  const bad = parseUserConfig({
    "1st": { type: "string", title: "x", description: "" },
    a: { type: "text", title: "A", description: "" },
    b: { type: "string", description: "" },
    c: { type: "string", title: "C", description: "", options: ["x"] },
    d: { type: "string", title: "D", description: "", options: ["x", "y"], sensitive: true, default: "x" },
    e: { type: "number", title: "E", description: "", max: 2, default: 9 },
    f: { type: "string", title: "F", description: "", options: ["x", "x"], required: true },
  });
  expect(bad.problems).toEqual([
    "userConfig.1st: a key is letters, digits and underscores, and does not start with a digit",
    "userConfig.a: type must be one of string, number, boolean, directory or file",
    "userConfig.b: title is required, a string",
    "userConfig.c: with options, set a default among them or required: true",
    "userConfig.d: options are for a string that is not multiple or sensitive",
    "userConfig.e: its default is above 2",
    "userConfig.f: an option is listed twice",
  ]);
  expect(parseUserConfig([]).problems).toEqual(["userConfig is not an object of options"]);
});

test("a value is checked against its option, and empty is no value", () => {
  const n = { type: "number" as const, title: "N", description: "", min: 1, max: 5 };
  expect(checkValue(n, "3")).toEqual({ value: 3 });
  expect(checkValue(n, "9").error).toBe("is above 5");
  expect(checkValue(n, "")).toEqual({ empty: true });
  expect(checkValue({ type: "boolean", title: "B", description: "" }, false)).toEqual({ value: false });
  expect(checkValue({ type: "string", title: "S", description: "", multiple: true }, "a\n\n b ")).toEqual({ value: ["a", "b"] });
  expect(checkValue({ type: "string", title: "T", description: "", options: ["x"] }, "y").error).toBe("is not one of x");
});

test("values fill references, the hooks' environment, and a sensitive one never reaches a model's text", () => {
  const specs = parseUserConfig({
    url: { type: "string", title: "URL", description: "", required: true },
    token: { type: "string", title: "Token", description: "", sensitive: true },
    hosts: { type: "string", title: "Hosts", description: "", multiple: true, default: ["a", "b"] },
  }).specs;
  expect(resolve(specs, {}).missing).toEqual(["url"]);
  const { text, missing } = resolve(specs, { url: "https://x.test", token: "s3cret" });
  expect(missing).toEqual([]);
  expect(text).toEqual({ url: "https://x.test", token: "s3cret", hosts: "a,b" });
  expect(substitute({ args: ["--url=${user_config.url}"], env: { T: "${user_config.token}", N: "${user_config.none}" } }, text)).toEqual({ args: ["--url=https://x.test"], env: { T: "s3cret", N: "" } });
  expect(optionEnv(text)).toEqual({ CLAUDE_PLUGIN_OPTION_URL: "https://x.test", CLAUDE_PLUGIN_OPTION_TOKEN: "s3cret", CLAUDE_PLUGIN_OPTION_HOSTS: "a,b" });
  expect(fillContent("Use ${user_config.url} with ${user_config.token}; ${user_config.other}", specs, text)).toBe("Use https://x.test with [token: a sensitive setting, not shown]; ${user_config.other}");
});

test("a field that runs through a shell takes no reference", () => {
  expect(hookRefusal({ type: "command", command: "printf ok", args: ["${user_config.url}"] })).toBeNull();
  expect(hookRefusal({ type: "command", command: "printf $CLAUDE_PLUGIN_OPTION_URL" })).toBeNull();
  expect(hookRefusal({ type: "command", command: "curl ${user_config.url}" })).toContain("shell-form hook command");
  expect(hookRefusal({ type: "command", command: "${user_config.bin}", args: [] })).toContain("not in the program it runs");
  expect(hookRefusal({ type: "http", url: "${user_config.url}" })).toContain("not in an http hook");
  expect(serverRefusal({ url: "${user_config.url}", headersHelper: "get-token ${user_config.who}" })).toContain("headersHelper runs through a shell");
  expect(serverRefusal({ command: "x", env: { A: "${user_config.url}" } })).toBeNull();
});

import { expect, test } from "bun:test";
import { join } from "node:path";
import { secretEnvNames } from "./env-secret.ts";
import { splitEnv } from "./closed-env.ts";

test("every key a provider reads from the environment is one that goes", () => {
  const names = ["OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "OPENROUTER_API_KEY", "FIREWORKS_API_KEY", "GLM_API_KEY", "KIMI_API_KEY", "NVIDIA_API_KEY", "DASHSCOPE_API_KEY", "LITELLM_API_KEY", "META_API_KEY",
    "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "AWS_BEARER_TOKEN_BEDROCK", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "OTEL_EXPORTER_OTLP_HEADERS", "OTEL_EXPORTER_OTLP_LOGS_HEADERS", "KEEL_TOKEN"];
  expect(secretEnvNames(Object.fromEntries(names.map((n) => [n, "v"])))).toEqual(names);
  expect(secretEnvNames({ ANTHROPIC_DEFAULT_MODEL: "m", ANTHROPIC_BASE_URL: "https://x.test", AWS_REGION: "r", AWS_PROFILE: "p", KEEL_DEFAULT_MODEL: "m" })).toEqual([]);
});

test("names that carry a secret go, plain ones stay", () => {
  const env = {
    PATH: "/usr/bin", HOME: "/home/x", SSH_AUTH_SOCK: "/run/agent", OPENAI_API_KEY: "a", AWS_BEARER_TOKEN_BEDROCK: "b", AWS_SECRET_ACCESS_KEY: "c",
    OTEL_EXPORTER_OTLP_HEADERS: "x-key=1", HTTPS_PROXY: "http://user:pw@proxy:3128", CUSTOM: "Authorization: Bearer abcdefghij", LANG: "C.UTF-8",
    GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraheader", GIT_CONFIG_VALUE_0: "Authorization: Basic abc",
  };
  const { kept, held } = splitEnv(env);
  expect(Object.keys(held).sort()).toEqual(["AWS_BEARER_TOKEN_BEDROCK", "AWS_SECRET_ACCESS_KEY", "CUSTOM", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "HTTPS_PROXY", "OPENAI_API_KEY", "OTEL_EXPORTER_OTLP_HEADERS"]);
  expect(Object.keys(kept).sort()).toEqual(["HOME", "LANG", "PATH", "SSH_AUTH_SOCK"]);
  expect(secretEnvNames({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "x" })).toEqual([]);
});

const linux = process.platform === "linux" && typeof (process as { execve?: unknown }).execve === "function";

// The program starts as the daemon does, with keys in its environment, and a child of it reads its environ.
async function run(env: Record<string, string>) {
  const p = Bun.spawn([process.execPath, join(import.meta.dir, "closed-env-fixture.ts")], {
    env: { PATH: process.env.PATH!, HOME: process.env.HOME!, TEST_API_KEY: "sekrit", TEST_TOKEN: "sekrit2", TEST_PLAIN: "visible", ...env }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return JSON.parse(out.trim().split("\n").pop()!) as Record<string, unknown>;
}

test.skipIf(!linux)("a child of the daemon reads its environ and finds no key; the daemon and what it starts still have them", async () => {
  const got = await run({});
  expect(got.samePid).toBe(true);
  expect(got.childEnvText).toBe(false);
  expect(got.childReadsNames).not.toContain("TEST_API_KEY");
  expect(got.childReadsNames).not.toContain("TEST_TOKEN");
  expect(got.childReadsNames).toContain("TEST_PLAIN");
  expect(got.startedWith).not.toContain("TEST_API_KEY");
  // In memory, and in what the daemon starts without naming an environment.
  expect(got.inProcess).toBe("sekrit");
  expect(got.tokenInProcess).toBe("sekrit2");
  expect(got.plain).toBe("visible");
  expect(got.startedChild).toBe("sekrit||");
  expect(got.stdin).toBe("/dev/null");
  expect(got.marker).toBeNull();
});

test.skipIf(!linux)("the same start under a unit that set the collector's variable", async () => {
  const got = await run({ BUN_GC_TIMER_DISABLE: "1" });
  expect(got.samePid).toBe(true);
  expect(got.childEnvText).toBe(false);
  expect(got.inProcess).toBe("sekrit");
  expect(got.startedChild).toBe("sekrit||");
});

test.skipIf(!linux)("an environment with no secret is started as it is", async () => {
  const got = await run({ TEST_API_KEY: "", TEST_TOKEN: "" });
  expect(got.samePid).toBe(true);
  expect(got.startedWith).toContain("TEST_PLAIN");
});

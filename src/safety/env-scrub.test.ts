import { expect, test } from "bun:test";
import { ENV_SECRET, PROXY_NAMES, scrubbedEnv, secretEnvNames } from "./env-secret.ts";

test("a name that ends in PAT carries a secret, PATH and others do not", () => {
  for (const n of ["SNOWFLAKE_CORTEX_PAT", "CLARIFAI_PAT", "PAT"]) expect([n, ENV_SECRET.test(n)]).toEqual([n, true]);
  for (const n of ["PATH", "PATCH_LEVEL", "PATTERN", "COMPAT"]) expect([n, ENV_SECRET.test(n)]).toEqual([n, false]);
  expect(secretEnvNames({ CLARIFAI_PAT: "x" })).toEqual(["CLARIFAI_PAT"]);
});

test("a program the daemon starts gets its environment without secrets, plus what it listed and what it was set", () => {
  const from = { PATH: "/bin", OPENAI_API_KEY: "a", GH_TOKEN: "b", HTTPS_PROXY: "http://u:pw@proxy:3128", PLAIN: "p" };
  expect(scrubbedEnv(from)).toEqual({ PATH: "/bin", PLAIN: "p" });
  expect(scrubbedEnv(from, ["GH_TOKEN"], { EXTRA_TOKEN: "given", GONE: undefined })).toEqual({ PATH: "/bin", PLAIN: "p", GH_TOKEN: "b", EXTRA_TOKEN: "given" });
  expect(scrubbedEnv(from, PROXY_NAMES).HTTPS_PROXY).toBe("http://u:pw@proxy:3128");
});

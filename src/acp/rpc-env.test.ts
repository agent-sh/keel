import { expect, test } from "bun:test";
import { ownEnv } from "../../test/env.ts";
import { AcpConnection } from "./rpc.ts";

ownEnv({ ACP_TEST_API_KEY: "fake-key", ACP_TEST_PLAIN: "plain" });

// The agent says its environment on stderr and ends; the request it was asked fails with that.
async function seen(pass?: string[]): Promise<string> {
  const c = new AcpConnection(["sh", "-c", 'read l; printf "key=%s plain=%s" "$ACP_TEST_API_KEY" "$ACP_TEST_PLAIN" >&2; exit 3'], { cwd: "/", pass });
  return (await c.request("initialize", {}).catch((e: Error) => e.message));
}

test("an ACP agent whose entry sets no env_vars gets the whole environment, a provider-shaped key included", async () => {
  expect(await seen()).toContain("key=fake-key plain=plain");
});

test("an entry that sets env_vars gets the environment without secrets, plus only the names it lists", async () => {
  expect(await seen([])).toContain("key= plain=plain");
  expect(await seen(["ACP_TEST_API_KEY"])).toContain("key=fake-key plain=plain");
});

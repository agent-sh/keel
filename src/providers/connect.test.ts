// The words a failed connection test shows, the check that keeps a credential
// out of an endpoint file, and the file round trip: pure logic the e2e only
// reaches one case of.
import { expect, test } from "bun:test";
import { checkEndpoint, endpointToml, type EndpointConfig } from "./config.ts";
import { explain, wireOfPackage } from "./connect.ts";
import { wireBase } from "./endpoint.ts";

const listing = { url: "http://127.0.0.1:8000/models", wire: "chat_completions" as const, keyless: true, step: "listing" as const };

test("a failed test names the problem and the change that fixes it", () => {
  expect(explain({ code: "ConnectionRefused", message: "Unable to connect." }, listing).problem).toBe("Nothing answers at 127.0.0.1:8000.");
  expect(explain({ code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND x" }, listing).fix).toContain("spelling");
  // A base URL without its version: the fix says /v1.
  expect(explain({ status: 404, message: "Not Found" }, listing).fix).toContain("/v1");
  expect(explain({ status: 200, message: "not JSON", contentType: "text/html", body: "<!doctype html>" }, { ...listing, url: "https://x.dev/v1/models" }).problem).toContain("web page");
  expect(explain({ status: 401, message: "bad key" }, { ...listing, keyless: false, keyWhere: "$X_KEY" }).problem).toContain("$X_KEY");
  expect(explain({ status: 401, message: "no key" }, listing).fix).toContain("environment variable or a keyring entry");
  expect(explain({ status: 404, message: "model not found" }, { ...listing, step: "model", model: "m1" }).problem).toContain("m1");
  expect(explain({ status: 503, message: "Loading model" }, { ...listing, step: "model" }).problem).toContain("loading");
});

test("an endpoint names its key and never holds one", () => {
  const ok: EndpointConfig = { id: "lab", base_url: "http://127.0.0.1:8000/v1", key_env: "LAB_KEY", headers: { "x-title": "Keel", authorization: "Bearer {keyring:lab-key}" } };
  expect(checkEndpoint(ok)).toEqual([]);
  expect(checkEndpoint({ ...ok, headers: { authorization: "Bearer sk-abcdefghijklmnopqrstuvwxyz" } }).join(" ")).toContain("plain text");
  expect(checkEndpoint({ ...ok, headers: { "x-api-key": "hunter2hunter2" } }).join(" ")).toContain("plain text");
  expect(checkEndpoint({ ...ok, base_url: "https://u:p@h.dev/v1" }).join(" ")).toContain("user and password");
  expect(checkEndpoint({ ...ok, base_url: "https://h.dev/v1?api_key=abc" }).join(" ")).toContain("credential");
  expect(checkEndpoint({ ...ok, key_env: "sk-abcdefghijklmnopqrstuvwxyz0123" }).length).toBeGreaterThan(0);
  expect(checkEndpoint({ ...ok, id: "Bad Id" }).length).toBe(1);
});

test("an endpoint file reads back as written", () => {
  const e: EndpointConfig = {
    id: "lab", label: "Lab \"one\"", wire: "anthropic_messages", base_url: "https://h.dev", key_cred: "lab-key", billing: "free",
    headers: { "x-title": "Keel" }, models: ["a/b"], price: { input: 0, output: 0 },
    model: { "a/b:latest": { context: 32768, tools: true, price: { input: 0.2, output: 0.8 } } },
  };
  const { id: _id, ...rest } = e;
  expect(Bun.TOML.parse(endpointToml(e))).toEqual(rest as any);
});

test("bases and wires", () => {
  expect(wireBase("anthropic_messages", "https://api.minimax.io/anthropic/v1/")).toBe("https://api.minimax.io/anthropic");
  expect(wireBase("gemini_generate_content", "https://g.dev/v1beta")).toBe("https://g.dev");
  expect(wireBase("chat_completions", "http://127.0.0.1:8000/v1/")).toBe("http://127.0.0.1:8000/v1");
  expect(wireOfPackage("@ai-sdk/openai-compatible")).toBe("chat_completions");
  expect(wireOfPackage("@ai-sdk/anthropic")).toBe("anthropic_messages");
  expect(wireOfPackage("@ai-sdk/amazon-bedrock")).toBeNull();
});

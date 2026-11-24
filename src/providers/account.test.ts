import { expect, test } from "bun:test";
import { accountState, classOfText, errorClass } from "../admin/classes.ts";
import { classify } from "./http.ts";
import { shutWords } from "./account.ts";

test("an account out of credit, suspended or signed out is an account state in each provider's words", () => {
  // An ACP route's gateway, its words alone (no status).
  expect(accountState(new Error("Your account has no available balance. The API key is suspended for billing"))).toBe("billing");
  // OpenAI's: insufficient_quota is a 429, a billing limit a 400; Anthropic's credit balance a 400; a gateway's 402.
  expect(classify("p", 429, new Headers(), JSON.stringify({ error: { message: "You exceeded your current quota, please check your plan and billing details.", code: "insufficient_quota" } })).kind).toBe("quota");
  expect(accountState(classify("p", 429, new Headers(), JSON.stringify({ error: { message: "You exceeded your current quota, please check your plan and billing details.", code: "insufficient_quota" } })))).toBe("billing");
  expect(classify("p", 400, new Headers(), JSON.stringify({ error: { message: "Billing hard limit has been reached", code: "billing_hard_limit_reached" } })).kind).toBe("quota");
  expect(classify("p", 400, new Headers(), JSON.stringify({ error: { message: "Your credit balance is too low to access the Anthropic API." } })).kind).toBe("quota");
  expect(classify("p", 403, new Headers(), JSON.stringify({ error: { message: "The API key is suspended for billing" } })).kind).toBe("quota");
  expect(accountState({ status: 402, message: "Payment Required" })).toBe("billing");
  // The same as stored text, read back (a turn's error event).
  expect(classOfText("P: HTTP 429: You exceeded your current quota, please check your plan and billing details.")).toBe("quota");
  expect(classOfText("P: HTTP 400: Your credit balance is too low to access the Anthropic API.")).toBe("quota");
  // Signed out: an ACP agent's own words.
  expect(accountState(new Error("Authentication required"))).toBe("auth");
  expect(accountState(new Error("Codex needs you to sign in with its own login first (ChatGPT)"))).toBe("auth");
  // Not an account state: a plan's usage window that passes, a rate limit, a server fault.
  expect(accountState({ kind: "quota", status: 429, message: "You have reached your usage limit; resets at 5pm" })).toBeUndefined();
  expect(errorClass({ status: 429, message: "Rate limit reached for requests" })).toBe("rate_limit");
  expect(accountState({ status: 500, message: "internal server error" })).toBeUndefined();
});

// Billing is read only as a provider's phrase or error code, a 403 is an account state only in
// words of billing, suspension or a sign-in, and a 402 that is a web page is not the provider's.
test("an error that only names billing, a permission refusal and a proxy's page are not an account out of credit", () => {
  const at = (status: number, body: unknown) => classify("P", status, new Headers(), typeof body === "string" ? body : JSON.stringify(body));
  expect(accountState(at(400, { type: "error", error: { type: "invalid_request_error", message: "tools.3.custom.input_schema.properties.billing_address: invalid type" } }))).toBeUndefined();
  expect(at(400, { type: "error", error: { type: "invalid_request_error", message: "tools.3.custom.input_schema.properties.billing_address: invalid type" } }).kind).toBe("invalid");
  expect(classOfText("P: HTTP 400: tools.3.custom.input_schema.properties.billing_address: invalid type")).toBe("invalid_request");
  // A permission refusal: not the provider's sign-in; one for a model shuts that model ("access").
  expect(accountState(at(403, { type: "error", error: { type: "permission_error", message: "Your API key does not have permission to use the specified resource." } }))).toBe("access");
  expect(accountState(at(403, { message: "You don't have access to the model with the specified model ID." }))).toBe("access");
  expect(accountState(at(403, { message: "Request blocked by the organization's policy." }))).toBeUndefined();
  expect(accountState(at(401, { error: { message: "invalid x-api-key" } }))).toBe("auth");
  // A proxy's page with a 402 is not the provider's word on the account; the provider's own 402 is.
  expect(accountState(at(402, "<html>Payment Required</html>"))).toBeUndefined();
  expect(accountState({ status: 402, message: "P: HTTP 402: <html>Payment Required</html>" })).toBeUndefined();
  expect(accountState(at(402, { type: "error", error: { type: "billing_error", message: "Your billing information is invalid." } }))).toBe("billing");
  expect(accountState(at(400, { type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing" } }))).toBe("billing");
  expect(accountState(at(429, { error: { message: "You have reached your usage limit" } }))).toBeUndefined();
});

test("a shut route is one line: who, what, the provider's words", () => {
  expect(shutWords({ kind: "billing", label: "ACP agents", route: "acp:opencode/gw", message: "No available balance.\nmore" })).toBe("ACP agents (opencode/gw) is out of credit or suspended for billing: No available balance.");
  expect(shutWords({ kind: "auth", label: "OpenAI", route: "openai", message: "invalid api key" })).toBe("OpenAI refuses its sign-in: invalid api key");
  expect(shutWords(undefined)).toBeUndefined();
});

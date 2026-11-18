import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { verifySignature } from "./loops.ts";

// The Standard Webhooks reference vector (the spec's libraries test this one).
const SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
const ID = "msg_p5jXN8AQM9LWM0D4loKWxJek";
const TS = 1614265330;
const BODY = '{"test": 2432232314}';
const SIG = "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=";
const at = TS * 1000;

const std = (p: Record<string, string>) => new Headers({ "webhook-id": ID, "webhook-timestamp": String(TS), "webhook-signature": SIG, ...p });

test("Standard Webhooks: the reference vector holds, among other signatures", () => {
  expect(verifySignature(SECRET, BODY, std({}), at)).toEqual({ id: `std:${ID}` });
  expect(verifySignature(SECRET, BODY, std({ "webhook-signature": `v1,bm9wZQ== ${SIG}` }), at)).toEqual({ id: `std:${ID}` });
});

test("Standard Webhooks: a changed body, an old timestamp or a dotted id is refused", () => {
  expect(verifySignature(SECRET, `${BODY} `, std({}), at)).toHaveProperty("error");
  expect(verifySignature(SECRET, BODY, std({}), at + 301_000)).toHaveProperty("error");
  expect(verifySignature(SECRET, BODY, std({ "webhook-id": "a.b" }), at)).toHaveProperty("error");
  expect(verifySignature(SECRET, BODY, new Headers(), at)).toHaveProperty("error");
});

test("GitHub: sha256= hex HMAC keyed by the secret's text, with a delivery id", () => {
  const sig = `sha256=${createHmac("sha256", SECRET).update(BODY).digest("hex")}`;
  expect(verifySignature(SECRET, BODY, new Headers({ "x-hub-signature-256": sig, "x-github-delivery": "d1" }))).toEqual({ id: "gh:d1" });
  expect(verifySignature(SECRET, BODY, new Headers({ "x-hub-signature-256": sig }))).toHaveProperty("error");
  expect(verifySignature(SECRET, "{}", new Headers({ "x-hub-signature-256": sig, "x-github-delivery": "d1" }))).toHaveProperty("error");
});

// What a dev server gets from the portal: the page's request, without the
// owner's credentials for Keel.
import { expect, test } from "bun:test";
import { upHeaders, withoutOwn } from "./portal-proxy.ts";

test("a dev server behind the portal never gets the daemon's own credentials: the sign-in cookie, the API key, the authorization", () => {
  const req = new Request("http://127.0.0.1:1/portal/s/3000/k/", {
    headers: { cookie: "theme=dark; keel_token=SECRET-TOKEN; sid=abc", "x-api-key": "SECRET-KEY", authorization: "Bearer SECRET", "user-agent": "t", accept: "text/html" },
  });
  const h = upHeaders(req);
  expect(h.get("cookie")).toBe("theme=dark; sid=abc");
  expect([h.get("x-api-key"), h.get("authorization")]).toEqual([null, null]);
  expect([h.get("user-agent"), h.get("accept")]).toEqual(["t", "text/html"]);
  expect(JSON.stringify([...h])).not.toContain("SECRET");
  // The cookie alone, as a socket's headers take it: nothing when only the daemon's own was there.
  expect(withoutOwn("keel_token=SECRET-TOKEN")).toBeUndefined();
  expect(withoutOwn("KEEL_TOKEN = x;a=1")).toBe("a=1");
  expect(withoutOwn("a=1; keel_token=x; b=keel_token=y")).toBe("a=1; b=keel_token=y");
  expect(withoutOwn(null)).toBeUndefined();
  expect(upHeaders(new Request("http://127.0.0.1:1/", { headers: { cookie: "keel_token=x" } })).has("cookie")).toBe(false);
});

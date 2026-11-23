import { expect, test } from "bun:test";
import { siteOf } from "./tools.ts";

test("a page's address is split at the site the browser goes to", () => {
  expect(siteOf("https://mcp.example.com/connect?id=1", "mcp.example.com")).toEqual(["https://", "mcp.example.com", "/connect?id=1"]);
  // A name before an @ sign is not the site, even when it reads as one.
  expect(siteOf("https://bank.example@evil.test/login", "evil.test")).toEqual(["https://bank.example@", "evil.test", "/login"]);
  expect(siteOf("https://evil.test@evil.test/", "evil.test")).toEqual(["https://evil.test@", "evil.test", "/"]);
  // The site's name in the path or the query is not the site.
  expect(siteOf("https://a.test/https://b.test", "b.test")).toEqual(["https://a.test/https://b.test", "", ""]);
  expect(siteOf("http://[::1]:8080/x", "[::1]")).toEqual(["http://", "[::1]", ":8080/x"]);
  expect(siteOf("https://only.test", "only.test")).toEqual(["https://", "only.test", ""]);
});

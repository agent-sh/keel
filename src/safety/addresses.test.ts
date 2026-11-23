import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { READ_WHOLE_CHARS } from "../engine/reader.ts";
import { fetchFor } from "../tools/web.ts";
import { AddressBook, HOST_CAP, addressOf, dataIn, encodedAs, fetchedAddresses, ownerAddresses, readerAnswered, sendShown, urlsIn, wholeOf, type WebUse } from "./addresses.ts";

const FETCH: WebUse = { fetches: (i) => [i.url], links: true };
const SEARCH: WebUse = { search: true };
const READERS: WebUse = { fetches: (i) => i.urls ?? [], links: false };
const use = (name: string, input: any) =>
  name === "WebFetch" ? { use: FETCH, input } : name === "WebSearch" ? { use: SEARCH, input } : name === "AskReaders" ? { use: READERS, input }
  : name === "mcp_call" && input?.tool === "web__webfetch" ? { use: FETCH, input: input.arguments } : undefined;
const book = () => new AddressBook(use, (d) => !d.kind && (d.origin === undefined || d.origin === "queued"));

let seq = 0;
const prompt = (text: string, more: object = {}) => ({ seq: ++seq, kind: "user", data: { text, ...more } });
const call = (id: string, name: string, input: unknown) => ({ seq: ++seq, kind: "assistant", data: { blocks: [{ type: "tool_use", id, name, input }] } });
const result = (id: string, content: string, more: object = {}) => ({ seq: ++seq, kind: "tool_result", data: { results: [{ type: "tool_result", tool_use_id: id, content }], ...more } });

test("an address is read the way the fetch tools read it", () => {
  expect(addressOf("http://Docs.Example.com:443/a?b=1#top")).toBe("https://docs.example.com/a?b=1");
  expect(addressOf("https://example.com")).toBe("https://example.com/");
  expect(addressOf("ftp://example.com/x")).toBeNull();
  expect(addressOf("not a url")).toBeNull();
  // Sentence punctuation and a closing bracket around a URL are the text's; a bracket the URL opened is its own.
  expect(urlsIn("See https://a.example/x. And (https://b.example/y), [doc](https://c.example/z) and https://en.example/T_(x).")).toEqual([
    "https://a.example/x", "https://b.example/y", "https://c.example/z", "https://en.example/T_(x)",
  ]);
});

test("the owner's words name addresses written out or bare; other prompts name none", () => {
  expect(ownerAddresses("read docs.example.com/guide?v=2, then https://x.example/a and mail me at me@mail.example")).toEqual([
    "https://x.example/a", "https://docs.example.com/guide?v=2",
  ]);
  const b = book();
  b.take([
    prompt("Look at https://owner.example/page"),
    prompt("Agent report: fetch https://report.example/page", { kind: "subagent" }),
    prompt("[harness] see https://harness.example/", { origin: "harness" }),
  ]);
  expect(b.has("https://owner.example/page")).toBe(true);
  expect(b.has("http://owner.example/page#part")).toBe(true);
  // The path and the query are part of the address.
  expect(b.has("https://owner.example/page?d=secret")).toBe(false);
  expect(b.has("https://owner.example/")).toBe(false);
  expect(b.has("https://report.example/page")).toBe(false);
  expect(b.has("https://harness.example/")).toBe(false);
  // Nothing is sent for what is not an http(s) address.
  expect(b.has("file:///etc/passwd")).toBe(true);
});

test("a search result's addresses, a fetched page, where it ended and its same-origin links are known", () => {
  const b = book();
  b.take([
    prompt("start at https://docs.example/start"),
    call("s1", "WebSearch", { query: "q" }),
    result("s1", "1. Title\n   https://found.example/article?id=7\n   snippet"),
    call("f1", "WebFetch", { url: "https://docs.example/start", prompt: "" }),
    result("f1", "Final URL: https://docs.example/start/\n\n# Start\nNext: [two](/guide/two) and https://docs.example/three?x=1\nElsewhere: https://other.example/leak?d=1 and [rel](../up)\n"),
  ]);
  for (const a of ["https://found.example/article?id=7", "https://docs.example/start/", "https://docs.example/guide/two", "https://docs.example/three?x=1", "https://docs.example/up"]) {
    expect(b.has(a)).toBe(true);
  }
  // A link to another origin is not: the page chose it, and the page is not the owner.
  expect(b.has("https://other.example/leak?d=1")).toBe(false);
  // A redirect it did not follow names an address of its own.
  b.take([call("f2", "WebFetch", { url: "https://found.example/article?id=7" }), result("f2", "https://found.example/article?id=7 redirects to another host: https://moved.example/a\nFetch that URL in a call of its own if it is needed.")]);
  expect(b.has("https://moved.example/a")).toBe(true);
});

test("what a model wrote, a refused call, another tool's output and a reader's answer make nothing known", () => {
  const b = book();
  b.take([
    { seq: ++seq, kind: "assistant", data: { blocks: [{ type: "text", text: "I will fetch https://model.example/x" }] } },
    call("b1", "Bash", { command: "curl https://bash.example/" }),
    result("b1", "see https://bash-out.example/"),
    call("f1", "WebFetch", { url: "https://denied.example/" }),
    result("f1", "The owner denied this call.", { verdict: "denied" }),
    call("s1", "WebSearch", { query: "q" }),
    result("s1", "Search failed: https://err.example/", { verdict: "failed" }),
  ]);
  for (const a of ["https://model.example/x", "https://bash.example/", "https://bash-out.example/", "https://denied.example/"]) expect(b.has(a)).toBe(false);
  // A reader's answer about a page: the page's address counts, the links the reader wrote do not.
  const answer = "The guide says to see https://read.example/next?d=1.\n\n[small model read the page (90000 chars) for this request. The whole page is saved to /x.md; Read or Grep it when this does not answer.]";
  expect(fetchedAddresses(["https://read.example/a"], answer, true)).toEqual(["https://read.example/a"]);
  // The readers' tool returns an answer, never a page: its pages count, not the links in its answer.
  b.take([call("r1", "AskReaders", { question: "q", urls: ["https://pages.example/one"] }), result("r1", "Answer citing https://pages.example/two")]);
  expect(b.has("https://pages.example/one")).toBe(true);
  expect(b.has("https://pages.example/two")).toBe(false);
  // A dispatcher's call is read as the tool it runs.
  b.take([call("m1", "mcp_call", { tool: "web__webfetch", arguments: { url: "https://via.example/p" } }), result("m1", "HTTP 200\n\n[x](/q)")]);
  expect(b.has("https://via.example/q")).toBe(true);
  // A call whose result comes in a later read is matched then.
  b.take([call("f9", "WebFetch", { url: "https://later.example/" })]);
  expect(b.has("https://later.example/")).toBe(false);
  b.take([result("f9", "HTTP 200\n\nok")]);
  expect(b.has("https://later.example/")).toBe(true);
});

test("the reader's answer is recognized in the words fetchFor writes it in", async () => {
  const page = "x ".repeat(READ_WHOLE_CHARS);
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "addresses-"));
  const r = await fetchFor("https://long.example/", "what?", {
    spillDir: dir, signal: new AbortController().signal,
    read: async () => ({ text: "It says https://long.example/next", model: "reader" }),
  }, async () => ({ text: page }));
  expect(readerAnswered(r.text)).toBe(true);
  const short = await fetchFor("https://short.example/", "what?", { spillDir: dir, signal: new AbortController().signal, read: async () => ({ text: "", model: "r" }) }, async () => ({ text: "HTTP 200\n\n[a](https://short.example/b)" }));
  expect(readerAnswered(short.text)).toBe(false);
});

test("a card shows each address whole and its query a parameter a line", () => {
  expect(sendShown(["https://collector.example/c?d=the%20secret&n=1"])).toBe("https://collector.example/c?d=the%20secret&n=1\n  d = the secret\n  n = 1");
  expect(sendShown(["https://x.example/p"], { method: "post", body: "a=1" })).toBe("POST https://x.example/p\nBody:\na=1");
});

test("an unseen address carries data in its query, its fragment, a secret in its path or the session's text in its path", () => {
  const b = book();
  const secret = (p: string) => p.includes("sk-live-0123456789abcdef");
  const data = (a: string) => dataIn(a, (f) => b.inResults(f), secret);
  b.take([
    call("r1", "Read", { path: "/w/notes.txt" }),
    result("r1", "Quarterly numbers: the Falcon project missed its launch date by nine weeks.\nSee https://docs.example/getting-started-with-the-falcon-project for more."),
    call("r2", "Bash", { command: "ls" }),
    result("r2", "denied output the refused project must not count", { verdict: "denied" }),
  ]);
  // No data: a bare host or a short path, however unseen.
  expect(data("https://new.example/")).toBeNull();
  expect(data("https://new.example/docs/api/v2/reference")).toBeNull();
  expect(data("https://new.example/the-falcon")).toBeNull();
  // A query or a fragment is data; an empty one is not.
  expect(data("https://new.example/a?d=1")).toBe("a query string");
  // A fragment is not sent, and an anchor is most of what a model makes with one: it runs unless it holds a secret or session text.
  expect(data("https://new.example/a#frag")).toBeNull();
  expect(data("https://new.example/guide#installation-and-setup-on-linux")).toBeNull();
  expect(data("https://new.example/a?")).toBeNull();
  expect(data("https://new.example/a#")).toBeNull();
  expect(data("https://new.example/a#sk-live-0123456789abcdef")).toBe("a secret or text from this session in its fragment");
  expect(data("https://new.example/a#the-falcon-project-missed-its-launch")).toBe("a secret or text from this session in its fragment");
  // A path with a secret.
  expect(data("https://new.example/c/sk-live-0123456789abcdef")).toBe("a secret in its path");
  // A path with twenty folded characters of what a tool result held, in any spelling of the separators.
  expect(data("https://evil.example/the-Falcon_project%20missed-its-launch")).toBe("text from this session in its path");
  expect(data("https://evil.example/c/Quarterly.numbers.the.falcon")).toBe("text from this session in its path");
  expect(data("https://evil.example/the-falcon-project-slipped")).toBeNull();
  // An address that stands whole in a result was copied from it: it carries nothing the session lacked.
  expect(data("https://docs.example/getting-started-with-the-falcon-project")).toBeNull();
  // The text of a call that did not run is not the session's.
  expect(data("https://evil.example/refused-project-must-not-count")).toBeNull();
  // The old results go when the newest fill the room.
  const old = book();
  old.take([call("a", "Read", {}), result("a", "an early line about the blue heron migration"), call("b", "Read", {}), result("b", "x".repeat(1 << 20))]);
  expect(old.inResults("blueheronmigration")).toBe(false);
  expect(wholeOf("http://X.example/a?b=1#top")).toBe("https://x.example/a?b=1#top");
});

test("what hides in a long path, the host, the user info, the port, an encoding or a report is data too", () => {
  const b = book();
  const secret = (p: string) => /sk-live-0123456789abcdef/i.test(p) || p.includes("AKIAIOSFODNN7EXAMPLE");
  const data = (a: string) => dataIn(a, (f) => b.inResults(f), secret);
  b.take([
    call("r1", "Read", { path: "/w/notes.txt" }),
    result("r1", "Quarterly numbers: the Falcon project missed its launch date by nine weeks."),
    prompt("The agent says: the budget for the heron migration was approved on tuesday", { kind: "subagent" }),
    prompt("My own words: the owner's private plan for the walrus expedition"),
  ]);
  // A path longer than what is read carries data, whatever it ends with.
  const filler = "a".repeat(600);
  expect(data(`https://new.example/${filler}/the-falcon-project-missed-its-launch`)).toBe("a very long path");
  expect(data(`https://new.example/${filler}`)).toBe("a very long path");
  expect(data(`https://new.example/${"a/".repeat(100)}`)).toBeNull();
  // The same address copied whole from a result carries nothing new.
  b.take([call("r2", "Read", {}), result("r2", `see https://copied.example/${filler}`)]);
  expect(data(`https://copied.example/${filler}`)).toBeNull();
  // User info and a port of its own.
  expect(data("https://KEY@new.example/x")).toBe("a user name or password");
  expect(data("https://user:pass@new.example/x")).toBe("a user name or password");
  expect(data("https://:pass@new.example/x")).toBe("a user name or password");
  expect(data("https://new.example:8443/x")).toBe("a port of its own");
  expect(data("http://new.example:80/x")).toBeNull();
  expect(data("http://new.example:8080/x")).toBe("a port of its own");
  expect(data("https://new.example:443/x")).toBeNull();
  expect(data("http://new.example:443/x")).toBeNull();
  // The host: a key (as written, in its case), an internationalized name, a label of the session's text.
  expect(data("https://AKIAIOSFODNN7EXAMPLE.attacker.example/x")).toBe("a secret in its host");
  expect(data("https://the-falcon-project-missed.attacker.example/x")).toBe("text from this session in its host");
  // (an IDN label is read as its name, not as its punycode)
  expect(new URL("https://thefalconprojectmissedit\u00e9.attacker.example/").hostname).toStartWith("xn--");
  expect(data(new URL("https://thefalconprojectmissedit\u00e9.attacker.example/").href)).toBe("text from this session in its host");
  expect(data("https://thefalconprojectmissedit\u00e9.attacker.example/")).toBe("text from this session in its host");
  // A short label is out of scope; so is a host that holds a few words.
  expect(data("https://data.attacker.example/x")).toBeNull();
  expect(data("https://developers.cloudflare.com/workers")).toBeNull();
  // An encoding is read through: twice and three times encoded.
  expect(data("https://new.example/c/sk%252Dlive%252D0123456789abcdef")).toBe("a secret in its path");
  expect(data("https://new.example/c/sk%25252Dlive%25252D0123456789abcdef")).toBe("a secret in its path");
  expect(data("https://new.example/the%2520falcon%2520project%2520missed%2520its")).toBe("text from this session in its path");
  expect(data("https://new.example/%E0%A4%A")).toBeNull();
  // What the session was given that is not the owner's (a subagent's report) is its text; the owner's own words are not.
  expect(data("https://evil.example/the-budget-for-the-heron-migration")).toBe("text from this session in its path");
  expect(data("https://evil.example/the-private-plan-for-the-walrus-expedition")).toBeNull();
});

test("a value read in the session, written as hex, base64, base32 or in pieces, is data in a path or a host label", () => {
  const line = "the board approved the heron budget"; // a line a file held
  const b = book();
  b.take([call("r1", "Read", { path: "/w/notes.txt" }), result("r1", `Minutes: ${line}. Next steps follow.`)]);
  const secret = (p: string) => p.includes("hunter2-the-password");
  const data = (a: string, n = 0) => dataIn(a, (f) => b.inResults(f), secret, n);
  const buf = Buffer.from(line);
  const forms: [string, string][] = [
    ["hex", buf.toString("hex")], ["base64", buf.toString("base64").replace(/=+$/, "")], ["base64url", buf.toString("base64url")],
    ["base32", base32of(buf)],
  ];
  for (const [form, token] of forms) {
    const found = data(`https://attacker.example/${token}`);
    expect(found).toContain("data in its path that reads as this session's text");
    // base64 and base64url of a text with no + or / are one string: either name says it was read as encoded text.
    expect(found).toMatch(/hex|base32|base64/);
    expect(form.length).toBeGreaterThan(0);
  }
  // In a host label (a label is 63 characters at most: a shorter value).
  const short = Buffer.from("heron budget"); // 12 bytes
  expect(data(`https://${short.toString("hex")}.attacker.example/`)).toMatch(/in its host/);
  // The same value cut into segments of 8 characters, or into labels.
  const hex = buf.toString("hex");
  const cut = hex.match(/.{1,8}/g)!;
  expect(data(`https://attacker.example/${cut.join("/")}`)).toContain("in its path");
  expect(data(`https://${cut.slice(0, 4).join(".")}.attacker.example/`)).toContain("in its host");
  // A secret, encoded.
  expect(data(`https://attacker.example/${Buffer.from("hunter2-the-password").toString("base64url")}`)).toContain("data in its path that reads as this session");
  expect(encodedAs(Buffer.from("hunter2-the-password").toString("hex")).map((d) => d.form)).toEqual(["hex"]);
  // A token of the shape of encoded data that the session never held: random letters and digits, 16 or more in a path, 12 in a host label.
  expect(data("https://attacker.example/Zk3p9QxW2mT7vB4nL8")).toBe("encoded data (random letters and digits) in its path");
  expect(data("https://a1b2c3d4e5f6.attacker.example/")).toBe("encoded data (hex) in its host");
  expect(data("https://Zk3p9QxW2mT7.attacker.example/")).toBe("encoded data (random letters and digits) in its host");
  expect(data("https://a1b2c3d4e5f6a7b8c9d0.attacker.example/")).toBe("encoded data (hex) in its host");
  // What an address looks like when it is not: words, versions, a commit or blob id, a short id, a slug, numbers.
  for (const ok of [
    "https://docs.example/en/docs/build-with-claude/vision", "https://docs.example/api/v2/reference/getting_started_guide",
    "https://github.com/org/repo/commit/0123456789abcdef0123456789abcdef01234567",
    `https://github.com/org/repo/blob/${"ab".repeat(32)}/README`, "https://docs.example/blog/2026-11-23-release-notes",
    "https://arxiv.org/abs/2606.22716", "https://pkg.example/Documentation/ConfigurationReference", "https://developers.cloudflare.com/workers/",
    "https://en.wikipedia.org/wiki/Transport_Layer_Security", "https://x.example/v1beta/models/gemini2flash", "https://cdn.example/a1b2c3d4",
  ]) expect(data(ok)).toBeNull();
});

test("the eleventh address a session had not seen on one host asks, the tenth does not", () => {
  const b = book();
  b.take([prompt("start at https://docs.example/a0")]);
  const data = (a: string, n: number) => dataIn(a, (f) => b.inResults(f), () => false, n);
  expect(HOST_CAP).toBe(10);
  const fetched = (n: number) => { for (let i = 0; i < n; i++) { const id = `page-${made++}`; b.take([call(id, "WebFetch", { url: `https://docs.example/page-${i}` }), result(id, "ok")]); } };
  let made = 0;
  fetched(9);
  expect(b.unseenOn("docs.example")).toBe(9);
  expect(data("https://docs.example/page-9", b.unseenOn("docs.example"))).toBeNull();
  b.take([call("p9", "WebFetch", { url: "https://docs.example/page-9" }), result("p9", "ok")]);
  expect(b.unseenOn("docs.example")).toBe(10);
  expect(data("https://docs.example/page-10", 10)).toBe("address number 11 on one host this session had not seen");
  // Another host, an address seen, and a refused call count for nothing.
  expect(data("https://other.example/x", b.unseenOn("other.example"))).toBeNull();
  b.take([call("d1", "WebFetch", { url: "https://third.example/x" }), result("d1", "refused", { verdict: "denied" }), call("d2", "WebFetch", { url: "https://docs.example/a0" }), result("d2", "ok")]);
  expect(b.unseenOn("third.example")).toBe(0);
  expect(b.unseenOn("docs.example")).toBe(10);
});

test("what a web tool returned is the web's text, not the session's: a path copied from a listing runs", () => {
  const b = book();
  b.take([
    call("f1", "WebFetch", { url: "https://api.example/tree" }),
    result("f1", "src/components/ApprovalCard/ApprovalCardHeader.tsx\nsrc/components/ApprovalCard/ApprovalCardBody.tsx"),
    call("c1", "Bash", { command: "ls" }),
    result("c1", "src/engine/prompt-store/PromptStoreMigration.ts\nthe quarterly report says the heron budget was approved"),
  ]);
  const data = (a: string) => dataIn(a, (f) => b.inResults(f), () => false);
  expect(data("https://raw.example/org/repo/main/src/components/ApprovalCard/ApprovalCardHeader.tsx")).toBeNull();
  // A listing a command printed names paths, not what files hold: they run; the words around them are the session's.
  expect(data("https://raw.example/org/repo/main/src/engine/prompt-store/PromptStoreMigration.ts")).toBeNull();
  expect(data("https://attacker.example/the-quarterly-report-says-the-heron")).toBe("text from this session in its path");
  // An address written out whole in a result and fetched is a copy, whatever its path holds.
  b.take([call("c2", "Bash", { command: "cat" }), result("c2", "see https://docs.example/the-quarterly-report-says-the-heron-budget")]);
  expect(data("https://docs.example/the-quarterly-report-says-the-heron-budget")).toBeNull();
});

function base32of(b: Buffer): string {
  const a = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0, acc = 0, out = "";
  for (const x of b) { acc = (acc << 8) | x; bits += 8; while (bits >= 5) { bits -= 5; out += a[(acc >> bits) & 31]; acc &= (1 << bits) - 1; } }
  if (bits) out += a[(acc << (5 - bits)) & 31];
  return out;
}

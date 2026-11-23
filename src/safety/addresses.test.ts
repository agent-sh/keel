import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { READ_WHOLE_CHARS } from "../engine/reader.ts";
import { fetchFor } from "../tools/web.ts";
import { AddressBook, addressOf, dataIn, fetchedAddresses, ownerAddresses, readerAnswered, sendShown, urlsIn, wholeOf, type WebUse } from "./addresses.ts";

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

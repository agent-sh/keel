import { expect, test } from "bun:test";
import { MAX_KEYS, ProvenanceBook, ago, extractTargets, fetchReaches, held, inputTargets, outsideCommand, plainFetcher, refusalOf, serverOf, shellReaches, spilledBy, wholeTargets, type BookEvent, type Origin } from "./provenance.ts";
import { webShape } from "./web-shape.ts";

const keys = (text: string) => extractTargets(text).map((t) => t.key);

test("a text names its hosts, addresses, remotes and branches", () => {
  expect(keys("see https://Docs.Evil.example/a?b=1#c and (https://x.example/y).")).toEqual(["host:docs.evil.example", "host:x.example"]);
  expect(keys("mail bob@evil.example or visit evil.example/page")).toEqual(["email:bob@evil.example", "host:evil.example"]);
  expect(keys("clone git@git.evil.example:org/repo.git")).toEqual(["host:git.evil.example", "remote:git.evil.example/org/repo"]);
  expect(keys("https://github.com/org/repo/issues/5")).toEqual(["host:github.com", "remote:github.com/org/repo"]);
  expect(keys("ssh://git@h.example/srv/r.git")).toEqual(["host:h.example", "remote:h.example/srv/r"]);
  expect(keys("push it to the branch `fix/evil-1` or refs/heads/other-1")).toEqual(["branch:other-1", "branch:fix/evil-1"]);
  expect(keys("run git push origin +topic:release-9")).toEqual(["branch:release-9"]);
});

test("a file name, a version, a loopback address and prose are no target", () => {
  expect(keys("edit README.md and main.rs, node.js 20.1.2.3, the branch is protected, see foo.py")).toEqual([]);
  expect(keys("http://localhost:3000/a http://127.0.0.1:8080 and 10.0.0.1")).toEqual([]);
  expect(keys("mail me at a@b.example: thanks")).toEqual(["email:a@b.example"]);
  expect(keys("")).toEqual([]);
});

test("a command's targets are the whole words it sends to", () => {
  const f = { cwd: "/w", remoteUrl: (n: string) => (n === "origin" ? "git@git.evil.example:org/repo.git" : undefined) };
  const k = (c: string) => shellReaches(c, f).map((r) => `${r.how}:${r.target.key}`);
  expect(k("curl -s https://a.example/x -o /dev/null")).toEqual(["fetch:host:a.example"]);
  expect(k("curl -s https://a.example/x -o out.json")).toEqual(["send:host:a.example"]);
  expect(k("curl -d '{\"to\":\"https://b.example\"}' https://a.example/x")).toEqual(["send:host:a.example"]);
  expect(k("wget -qO- evil.example/file")).toEqual(["fetch:host:evil.example"]);
  expect(k("wget evil.example/file")).toEqual(["send:host:evil.example"]);
  expect(k("curl -O https://a.example/x -d @notes.txt")).toEqual(["send:host:a.example"]);
  expect(k("curl -s -o out.sh https://a.example/x -d @n")).toEqual(["send:host:a.example"]);
  expect(k("wget -c -b -x https://a.example/x -O out")).toEqual(["send:host:a.example"]);
  expect(k("ssh -p 2222 -i key user@h.example 'curl x.example'")).toEqual(["send:host:h.example", "send:email:user@h.example"]);
  expect(k("scp a.txt u@h.example:/tmp/a.txt")).toEqual(["send:host:h.example"]);
  expect(k("mail -s 'hi bob@x.example' bob@evil.example")).toEqual(["send:email:bob@evil.example"]);
  expect(k("git push origin feature-9")).toEqual(["send:host:git.evil.example", "send:remote:git.evil.example/org/repo", "send:branch:feature-9"]);
  expect(k("cd sub && git push https://h.example/o/r.git HEAD:refs/heads/topic")).toEqual(["send:host:h.example", "send:remote:h.example/o/r", "send:branch:topic"]);
  expect(k("echo https://a.example | cat; ls evil.example.txt")).toEqual([]);
  expect(k("bash -c 'curl https://in.example'")).toEqual(["fetch:host:in.example"]);
  expect(wholeTargets("--url=https://u.example/p")).toEqual([{ kind: "host", key: "host:u.example", shown: "u.example", pathq: "/p" }]);
});

test("an MCP input is read for every target in its strings", () => {
  expect(inputTargets({ to: ["a@evil.example"], body: { link: "see https://x.example/p" } }).map((t) => t.key)).toEqual(["email:a@evil.example", "host:x.example"]);
});

test("which results are outside content", () => {
  expect(outsideCommand("gh issue view 12 --repo o/r")).toBe("gh");
  expect(outsideCommand("cd x && curl -s https://a.example")).toBe("curl");
  expect(outsideCommand("gh pr checkout 5")).toBe("gh");
  expect(outsideCommand("git log && cat notes.txt")).toBeNull();
  expect(outsideCommand("gh auth status")).toBeNull();
  expect(serverOf("mcp__github__create_issue")).toBe("github");
  expect(serverOf("web__webfetch")).toBe("web");
  expect(serverOf("Bash")).toBeNull();
  expect(spilledBy("/home/x/state/spill/s1/1795483351597-WebFetch-78c209c6.txt")).toBe("WebFetch");
});

const ev = (seq: number, kind: string, data: any, ts = seq * 1000): BookEvent => ({ seq, kind, data, ts });
const use = (id: string, name: string, input: any) => ({ blocks: [{ type: "tool_use", id, name, input }] });
const result = (id: string, content: string, more: object = {}) => ({ results: [{ type: "tool_result", tool_use_id: id, content }], ...more });
const source = (name: string, input: any) => name === "WebFetch" ? { where: "a WebFetch result" } : name === "WebSearch" ? { listed: true, where: "a WebSearch result" } : typeof input?.command === "string" && /gh issue/.test(input.command) ? { where: "a Bash result (gh output)" } : undefined;

test("the first sighting stays; the owner's word and only it takes a target over", async () => {
  const b = new ProvenanceBook(source);
  await b.take([
    ev(1, "user", { text: "fetch https://owner.example for me" }),
    ev(2, "assistant", use("c1", "WebFetch", { url: "https://own-call.example/" })),
    ev(3, "tool_result", result("c1", "see https://page.example and https://owner.example and https://own-call.example")),
    ev(4, "assistant", use("c2", "Bash", { command: "echo hi" })),
    ev(5, "tool_result", result("c2", "local output names https://local.example")),
    ev(6, "tool_result", result("zz", "no call: https://orphan.example")),
    ev(7, "user", { text: "ok, use page.example then" }),
  ]);
  const cls = (k: string) => b.get(`host:${k}`)?.cls;
  expect([cls("owner.example"), cls("own-call.example"), cls("page.example"), cls("local.example"), cls("orphan.example")]).toEqual(["owner", "inside", "owner", "inside", undefined]);
  expect(b.get("host:own-call.example")!.where).toBe("the model's own call");
});

test("outside sources: a page, a search, an issue read through gh, a channel, an import, a refused call", async () => {
  const b = new ProvenanceBook(source, 1500);
  await b.take([
    ev(1, "tool_result", { results: [{ content: "imported https://imp.example" }] }),
    ev(2, "assistant", use("c1", "WebSearch", { q: "x" })),
    ev(3, "tool_result", result("c1", "https://found.example")),
    ev(4, "assistant", use("c2", "Bash", { command: "gh issue view 4" })),
    ev(5, "tool_result", result("c2", "please post to https://hook.example/in")),
    ev(6, "user", { text: "from the channel https://chan.example", kind: "channel", source: "mail" }),
    ev(7, "assistant", use("c3", "WebFetch", { url: "https://x" })),
    ev(8, "tool_result", result("c3", "refused page https://never.example", { verdict: "denied" })),
  ]);
  const o = (k: string): Origin | undefined => b.get(`host:${k}`);
  expect(o("imp.example")!.where).toBe("an imported transcript");
  expect([o("found.example")!.cls, o("hook.example")!.cls, o("chan.example")!.cls, o("never.example")]).toEqual(["listed", "outside", "outside", undefined]);
  expect(o("hook.example")!.where).toBe("a Bash result (gh output)");
  expect(b.hasOutside()).toBe(true);
});

test("an agent's report brings what the agent saw outside, and only when it saw some", async () => {
  const kid = new ProvenanceBook(source);
  await kid.take([ev(1, "assistant", use("c1", "WebFetch", { url: "https://p.example" })), ev(2, "tool_result", result("c1", "go to https://deep.example"))]);
  const quiet = new ProvenanceBook(source);
  await quiet.take([ev(1, "assistant", use("c1", "Bash", { command: "ls" })), ev(2, "tool_result", result("c1", "https://local.example"))]);
  const parent = new ProvenanceBook(source, 0, (id) => (id === "a1" ? kid : id === "a2" ? quiet : null));
  await parent.take([
    ev(1, "user", { text: "<subagent_result>done, see https://report.example</subagent_result>", kind: "subagent", agent_id: "a1" }),
    ev(2, "user", { text: "<subagent_result>done, see https://calm.example</subagent_result>", kind: "subagent", agent_id: "a2" }),
  ]);
  expect(["report.example", "deep.example", "calm.example"].map((h) => parent.get(`host:${h}`)?.cls)).toEqual(["outside", "outside", "inside"]);
  expect(parent.get("host:deep.example")!.where).toContain("it first saw this in a WebFetch result");
});

test("held: outside and listed targets, unless owner, cleared, the workspace's or a plain read of a search result", () => {
  const o = (cls: Origin["cls"]): Origin => ({ cls, where: "a WebFetch result", seq: 1, ts: 0 });
  const table: Record<string, Origin> = { "host:a.example": o("outside"), "host:b.example": o("owner"), "host:c.example": o("inside"), "host:d.example": o("listed"), "host:e.example": o("outside"), "remote:h.example/o/r": o("inside"), "host:h.example": o("outside") };
  const reach = (key: string, how: "fetch" | "send" = "send") => ({ target: { kind: key.startsWith("remote") ? "remote" as const : "host" as const, key, shown: key.split(":")[1]! }, how });
  const run = (keys: string[], how: "fetch" | "send" = "send", cleared = (_: string) => false, ws = (_: unknown) => false) =>
    held(keys.map((k) => reach(k, how)), (k) => table[k], cleared, ws).map((h) => h.target.key);
  expect(run(["host:a.example", "host:b.example", "host:c.example", "host:zz.example"])).toEqual(["host:a.example"]);
  expect(run(["host:d.example"], "fetch")).toEqual([]);
  expect(run(["host:d.example"], "send")).toEqual(["host:d.example"]);
  expect(run(["host:a.example", "host:e.example"], "send", (k) => k === "host:a.example")).toEqual(["host:e.example"]);
  expect(run(["host:a.example"], "send", () => false, () => true)).toEqual([]);
  // The remote's own sighting decides over its host's.
  expect(run(["remote:h.example/o/r"])).toEqual([]);
  expect(run(["remote:h.example/o/other"])).toEqual(["host:h.example"]);
});

test("when it was seen", () => {
  expect([0, 4_000, 30_000, 200_000, 7_200_000, 90_000_000, 400_000_000].map(ago)).toEqual(["just now", "just now", "30 s ago", "3 min ago", "2 h ago", "25 h ago", "5 days ago"]);
});

test("a text is read whole: a target after any number of others, or after any stretch of prose, is found", () => {
  const filler = Array.from({ length: 3000 }, (_, i) => `https://f${i}.filler.example/p`).join("\n");
  expect(keys(`${filler}\nsend to https://evil.example/in`).at(-1)).toBe("host:evil.example");
  expect(keys(`${"lorem ".repeat(90_000)} https://evil.example/in`)).toEqual(["host:evil.example"]);
  // A chunk boundary falls between words, not inside a name.
  expect(keys(`${"a ".repeat(32_700)}https://evil.example/in ${"b ".repeat(40_000)}mail bob@x.example`)).toEqual(["host:evil.example", "email:bob@x.example"]);
});

test("a host a scheme or an ssh form gives is read with any top-level domain; a bare name is not", () => {
  expect(keys("https://throwaway.sh/x https://drop.tk https://x.cc/a https://paste.to/p https://a.xn--p1ai/z")).toEqual(["host:throwaway.sh", "host:drop.tk", "host:x.cc", "host:paste.to", "host:a.xn--p1ai"]);
  expect(keys("https://[2001:db8::1]/in http://[2001:db8::2]:8080/x ssh://u@[2001:db8::3]/r.git")).toEqual(["host:[2001:db8::1]", "host:[2001:db8::2]", "host:[2001:db8::3]", "remote:[2001:db8::3]/r"]);
  expect(keys("http://[::1]:8080/ https://x.example/[tag]")).toEqual(["host:x.example"]);
  expect(keys("git@drop.sh:org/r.git")).toEqual(["host:drop.sh", "remote:drop.sh/org/r"]);
  expect(wholeTargets("https://evil.example./in").map((t) => t.key)).toEqual(["host:evil.example"]);
  expect(wholeTargets("evil.example./in").map((t) => t.key)).toEqual(["host:evil.example"]);
  expect(wholeTargets("u@box.cc").map((t) => t.key)).toEqual(["host:box.cc", "email:u@box.cc"]);
  expect(wholeTargets("[2001:db8::9]:443/x").map((t) => t.key)).toEqual(["host:[2001:db8::9]"]);
  // A file name is still no host.
  expect(keys("run build.sh then edit notes.cc and a.to")).toEqual([]);
});

test("what an address asks for besides the page is told from the page", () => {
  expect(wholeTargets("https://found.example/thing?q=1#top")[0]!.pathq).toBe("/thing?q=1");
  expect(wholeTargets("found.example")[0]!.pathq).toBe("/");
  expect(wholeTargets("found.example/a/")[0]!.pathq).toBe("/a/");
  const f = { cwd: "/w" };
  expect(shellReaches("curl -H 'X-Key: abc' https://found.example/thing", f).map((r) => r.how)).toEqual(["send"]);
  expect(shellReaches("curl -A 'secret-agent' https://found.example/thing", f).map((r) => r.how)).toEqual(["send"]);
  expect(shellReaches("curl https://found.example/thing", f).map((r) => r.how)).toEqual(["fetch"]);
});

test("a search result's address covers a fetch of that address and the pages above it, nothing more", async () => {
  const b = new ProvenanceBook(source);
  await b.take([ev(1, "assistant", use("c1", "WebSearch", { q: "x" })), ev(2, "tool_result", result("c1", "https://found.example/a/thing?id=3 and https://found.example/b"))]);
  const k = "host:found.example";
  expect([b.covers(k, "/a/thing?id=3"), b.covers(k, "/a"), b.covers(k, "/"), b.covers(k, undefined), b.covers(k, "/b")]).toEqual([true, true, true, true, true]);
  expect([b.covers(k, "/a/thing?id=4"), b.covers(k, "/a/thing"), b.covers(k, "/other?d=1"), b.covers(k, "/c"), b.covers(k, "/a/thing/deeper"), b.covers("host:no.example", "/")]).toEqual([false, true, false, false, false, false]);
});

test("a book that lost sightings or could not read a text says so, and only for outside content", async () => {
  const b = new ProvenanceBook(source);
  const many = (n: number, from = 0) => Array.from({ length: n }, (_, i) => `https://h${from + i}.many.example/p`).join(" ");
  await b.take([ev(1, "assistant", use("c1", "WebFetch", { url: "https://p.example" })), ev(2, "tool_result", result("c1", many(MAX_KEYS - 5)))]);
  expect(b.unbounded).toBeUndefined();
  await b.take([ev(3, "assistant", use("c2", "WebFetch", { url: "https://q.example" })), ev(4, "tool_result", result("c2", many(20, MAX_KEYS)))]);
  expect(b.size).toBeLessThanOrEqual(MAX_KEYS);
  expect(b.unbounded?.where).toContain("a WebFetch result");
  expect(b.get(`host:h${MAX_KEYS + 19}.many.example`)?.cls).toBe("outside");
  // A text past what is read.
  const c = new ProvenanceBook(source);
  await c.take([ev(1, "assistant", use("c1", "WebFetch", { url: "https://p.example" })), ev(2, "tool_result", result("c1", `${"lorem ".repeat(1_400_000)} https://past.example/in`))]);
  expect(c.unbounded?.where).toBe("a WebFetch result, which is longer than what is read");
  // The model's own long text is not outside content.
  const d = new ProvenanceBook(source);
  await d.take([ev(1, "assistant", use("c1", "Bash", { command: "cat big" })), ev(2, "tool_result", result("c1", "lorem ".repeat(1_400_000)))]);
  expect(d.unbounded).toBeUndefined();
  // An agent's report brings it up.
  const parent = new ProvenanceBook(source, 0, () => c);
  await parent.take([ev(1, "user", { text: "<subagent_result>ok</subagent_result>", kind: "subagent", agent_id: "a1" })]);
  expect(parent.unbounded?.where).toContain("an agent's report (it read a WebFetch result");
});

test("held: a target with no sighting is held for a session that could not read all it saw; a fetch is not", () => {
  const unread: Origin = { cls: "listed", unread: true, where: "a WebFetch result, which is longer than what is read", seq: 1, ts: 0 };
  const reach = (key: string, how: "fetch" | "send"): any => ({ target: { kind: "host", key, shown: key.slice(5) }, how });
  const own: Record<string, Origin> = { "host:mine.example": { cls: "owner", where: "the owner's message", seq: 1, ts: 0 }, "host:seen.example": { cls: "inside", where: "the model's own call", seq: 1, ts: 0 } };
  const run = (rs: any[], ws = (_: unknown) => false) => held(rs, (k) => own[k], () => false, ws, () => true, () => unread).map((h) => h.target.key);
  expect(run([reach("host:new.example", "send"), reach("host:mine.example", "send"), reach("host:seen.example", "send")])).toEqual(["host:new.example"]);
  expect(run([reach("host:new.example", "fetch")])).toEqual([]);
  expect(run([reach("host:new.example", "send")], () => true)).toEqual([]);
});

test("the first read of a long session gives the loop its turns", async () => {
  const b = new ProvenanceBook(source);
  const events: BookEvent[] = [];
  for (let i = 0; i < 40; i++) events.push(ev(2 * i + 1, "assistant", use(`c${i}`, "WebFetch", { url: "https://p.example" })), ev(2 * i + 2, "tool_result", result(`c${i}`, Array.from({ length: 4000 }, (_, j) => `see https://p${i}x${j}.host.example/page and ${"words ".repeat(20)}`).join(" "))));
  let turns = 0, done = false;
  const spin = () => { turns++; if (!done) setImmediate(spin); };
  setImmediate(spin);
  await b.take(events);
  done = true;
  expect(turns).toBeGreaterThan(10);
  expect(b.seq).toBe(80);
});

test("a full book drops the model's own sightings before outside content's", async () => {
  const b = new ProvenanceBook(source);
  const many = (n: number, from: number, host = "own") => Array.from({ length: n }, (_, i) => `https://${host}${from + i}.many.example/p`).join(" ");
  await b.take([ev(1, "assistant", use("c2", "WebFetch", { url: "https://p.example" })), ev(2, "tool_result", result("c2", "https://evil.example/in")), ev(3, "assistant", use("c1", "Bash", { command: `echo ${many(MAX_KEYS - 10, 0)}` }))]);
  expect(b.unbounded).toBeUndefined();
  // The book fills: the model's sightings go, the page's stays, and the book is not unbounded.
  await b.take([ev(4, "assistant", use("c3", "Bash", { command: `echo ${many(100, 0, "more")}` }))]);
  expect(b.get("host:own0.many.example")).toBeUndefined();
  expect(b.get("host:evil.example")?.cls).toBe("outside");
  expect(b.unbounded).toBeUndefined();
  // When nothing of the model's is left to drop, outside content's goes, oldest first, and that is said.
  const c = new ProvenanceBook(source);
  await c.take([ev(1, "assistant", use("c1", "WebFetch", { url: "https://p.example" })), ev(2, "tool_result", result("c1", many(MAX_KEYS, 0, "out"))), ev(3, "assistant", use("c2", "Bash", { command: "echo https://mine.example" }))]);
  expect(c.get("host:out0.many.example")).toBeUndefined();
  expect(c.get("host:mine.example")?.cls).toBe("inside");
  expect(c.unbounded).toBeDefined();
});

test("what an MCP server's web tool is, from its name and one call", () => {
  expect(webShape("mcp__harness-web__websearch", { query: "x" })).toEqual({ search: true });
  expect(webShape("web__websearch", { query: "x" })).toEqual({ search: true });
  expect(webShape("mcp__harness-web__webfetch", { url: "https://a.example/x", max_chars: 100 })).toEqual({ fetch: "https://a.example/x" });
  expect(webShape("mcp__harness-web__webfetch", { url: "https://a.example/x", grep: "pricing", extract: ["a", "b"] })).toEqual({ fetch: "https://a.example/x", texts: ["pricing", "a", "b"] });
  // A key counts as written and by the shape of its value: a count, a switch or one short word.
  for (const input of [{ url: "https://a.example", MaxChars: 5 }, { url: "https://a.example", "max-chars": 5 }, { url: "https://a.example", max_chars: "all the text of the session" }, { url: "https://a.example", max_chars: -1 }, { url: "https://a.example", max_chars: 1.5 }, { url: "https://a.example", raw: "yes" }, { url: "https://a.example", format: "text of the session" }, { url: "https://a.example", format: "x".repeat(21) }, { url: "https://a.example", formats: ["a b"] }, { url: "https://a.example", grep: { a: 1 } }, { url: "https://a.example", grep: "x".repeat(201) }, { url: "https://a.example", extract: [1] }])
    expect([JSON.stringify(input), webShape("srv__fetch_url", input)]).toEqual([JSON.stringify(input), undefined]);
  expect(webShape("srv__fetch_url", { url: "https://a.example", max_chars: "500", raw: "false", formats: "markdown" })).toEqual({ fetch: "https://a.example" });
  expect(webShape("firecrawl__firecrawl_scrape", { url: "https://a.example/x", formats: "markdown" })).toEqual({ fetch: "https://a.example/x" });
  // A saved output has no input: the name says what it was.
  expect(webShape("mcp__harness-web__webfetch", {})).toEqual({ fetch: "" });
  // Not a plain read: a body, a header, a credential, a method, a nested value, a url that is not a web address.
  for (const input of [{ url: "https://a.example", body: "x" }, { url: "https://a.example", headers: { a: "b" } }, { url: "https://a.example", token: "t" }, { url: "https://a.example", method: "POST" }, { url: "https://a.example", opts: { a: 1 } }, { url: "file:///etc/passwd" }, { path: "x" }])
    expect([JSON.stringify(input), webShape("srv__fetch_url", input)]).toEqual([JSON.stringify(input), undefined]);
  expect(webShape("srv__fetch_url", { url: "https://a.example", method: "get" })).toBeUndefined();
  // The keys are an allowlist: any other key is not a plain read, and so is a name that does something besides read.
  for (const input of [{ url: "https://a.example", note: "x" }, { url: "https://a.example", referer: "https://b.example" }, { url: "https://a.example", user_agent: "x" }, { url: "https://a.example", proxy: "http://p.example" }, { url: "https://a.example", query: "q" }])
    expect([JSON.stringify(input), webShape("srv__fetch_url", input)]).toEqual([JSON.stringify(input), undefined]);
  for (const name of ["srv__post_url", "srv__fetch_and_post", "srv__upload_page", "srv__navigate", "srv__refetch_and_send", "srv__browser_fetch_write", "srv__search_issues", "srv__fetching"])
    expect([name, webShape(name, { url: "https://a.example" })]).toEqual([name, undefined]);
  // Neither: a tool that is not a search or a page read.
  expect(webShape("github__create_issue", { url: "https://a.example", title: "t" })).toBeUndefined();
  expect(webShape("mailer__send_message", { to: "a@b.example" })).toBeUndefined();
});

test("which commands read pages and send nothing", () => {
  expect(plainFetcher("curl -s https://a.example/x | head")).toBe(true);
  expect(plainFetcher("wget -qO- a.example")).toBe(true);
  expect(plainFetcher("curl -d x https://a.example")).toBe(false);
  expect(plainFetcher("curl -H 'X: 1' https://a.example")).toBe(false);
  expect(plainFetcher("curl -sd @f https://a.example")).toBe(false);
  expect(plainFetcher("curl https://a.example/$(cat f)")).toBe(false);
  expect(plainFetcher("curl -K cfg https://a.example")).toBe(false);
  expect(plainFetcher("gh issue view 4")).toBe(false);
  expect(plainFetcher("cat notes.txt")).toBe(false);
});

test("a page's text and a search's are the web's; a reader's answer, an issue and a send are not", async () => {
  const src = (name: string, input: any) => {
    if (name === "page") return { linked: true, where: "a page result" };
    if (name === "search") return { listed: true, where: "a search result" };
    if (typeof input?.command === "string") return { where: "a Bash result (gh output)" };
    return undefined;
  };
  const b = new ProvenanceBook(src);
  await b.take([
    ev(1, "assistant", use("c1", "page", { url: "https://p.example" })),
    ev(2, "tool_result", result("c1", "links: https://linked.example/a")),
    ev(3, "assistant", use("c2", "page", { url: "https://q.example" })),
    ev(4, "tool_result", result("c2", "the page was long.\n\n[some-model read the page (90000 chars) for this request]\nit mentions https://summed.example/a")),
    ev(5, "assistant", use("c3", "search", { q: "x" })),
    ev(6, "tool_result", result("c3", "https://found.example/a")),
    ev(7, "assistant", use("c4", "Bash", { command: "gh issue view 1" })),
    ev(8, "tool_result", result("c4", "https://issue.example/a and https://found.example/b")),
  ]);
  const c = (k: string) => b.get(`host:${k}`)?.cls;
  expect([c("linked.example"), c("summed.example"), c("found.example"), c("issue.example")]).toEqual(["listed", "outside", "listed", "outside"]);
  // An outside sighting becomes the web's when a search lists the host later; the owner's word and the model's stay.
  await b.take([ev(9, "assistant", use("c5", "search", { q: "y" })), ev(10, "tool_result", result("c5", "https://issue.example/c"))]);
  expect(c("issue.example")).toBe("listed");
});

test("held: a plain read of a host a page linked or a search listed goes on; a read that carries data, and every send, is held", () => {
  const o = (cls: Origin["cls"]): Origin => ({ cls, where: "a page result", seq: 1, ts: 0 });
  const table: Record<string, Origin> = { "host:l.example": o("listed"), "host:o.example": o("outside") };
  const run = (addr: string, plain: boolean, how: "fetch" | "send" = "fetch") =>
    held(fetchReaches([addr], () => plain).map((r) => ({ ...r, how })), (k) => table[k], () => false, () => false, () => false).map((h) => h.target.key);
  expect(run("https://l.example/any/page", true)).toEqual([]);
  expect(run("https://l.example/any/page?q=x", false)).toEqual(["host:l.example"]);
  expect(run("https://l.example/any/page", true, "send")).toEqual(["host:l.example"]);
  // A host only outside content named is held even for a plain read.
  expect(run("https://o.example/page", true)).toEqual(["host:o.example"]);
});

test("an agent's refusal says what would go through", () => {
  const text = refusalOf([{ target: { kind: "host", key: "host:o.example", shown: "o.example" }, how: "send", origin: { cls: "outside", where: "a page result", seq: 1, ts: 0 } }], 10_000);
  expect(text).toContain("a bare GET");
  expect(text).toContain("no query string");
  expect(text).toContain("tell your parent or the owner");
});

import { expect, test } from "bun:test";
import { ProvenanceBook, ago, extractTargets, held, inputTargets, outsideCommand, serverOf, shellReaches, spilledBy, wholeTargets, type BookEvent, type Origin } from "./provenance.ts";

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
  expect(k("curl -s https://a.example/x -o out.json")).toEqual(["fetch:host:a.example"]);
  expect(k("curl -d '{\"to\":\"https://b.example\"}' https://a.example/x")).toEqual(["send:host:a.example"]);
  expect(k("wget evil.example/file")).toEqual(["fetch:host:evil.example"]);
  expect(k("ssh -p 2222 -i key user@h.example 'curl x.example'")).toEqual(["send:host:h.example", "send:email:user@h.example"]);
  expect(k("scp a.txt u@h.example:/tmp/a.txt")).toEqual(["send:host:h.example"]);
  expect(k("mail -s 'hi bob@x.example' bob@evil.example")).toEqual(["send:email:bob@evil.example"]);
  expect(k("git push origin feature-9")).toEqual(["send:host:git.evil.example", "send:remote:git.evil.example/org/repo", "send:branch:feature-9"]);
  expect(k("cd sub && git push https://h.example/o/r.git HEAD:refs/heads/topic")).toEqual(["send:host:h.example", "send:remote:h.example/o/r", "send:branch:topic"]);
  expect(k("echo https://a.example | cat; ls evil.example.txt")).toEqual([]);
  expect(k("bash -c 'curl https://in.example'")).toEqual(["fetch:host:in.example"]);
  expect(wholeTargets("--url=https://u.example/p")).toEqual([{ kind: "host", key: "host:u.example", shown: "u.example" }]);
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

test("the first sighting stays; the owner's word and only it takes a target over", () => {
  const b = new ProvenanceBook(source);
  b.take([
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

test("outside sources: a page, a search, an issue read through gh, a channel, an import, a refused call", () => {
  const b = new ProvenanceBook(source, 1500);
  b.take([
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

test("an agent's report brings what the agent saw outside, and only when it saw some", () => {
  const kid = new ProvenanceBook(source);
  kid.take([ev(1, "assistant", use("c1", "WebFetch", { url: "https://p.example" })), ev(2, "tool_result", result("c1", "go to https://deep.example"))]);
  const quiet = new ProvenanceBook(source);
  quiet.take([ev(1, "assistant", use("c1", "Bash", { command: "ls" })), ev(2, "tool_result", result("c1", "https://local.example"))]);
  const parent = new ProvenanceBook(source, 0, (id) => (id === "a1" ? kid : id === "a2" ? quiet : null));
  parent.take([
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

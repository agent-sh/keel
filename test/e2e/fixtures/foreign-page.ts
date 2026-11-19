#!/usr/bin/env bun
// A web page on another origin that tries to drive a Keel daemon: a "simple"
// fetch POST (no preflight), a form POST into a hidden frame and a WebSocket
// to /ws. It names its attempts with ?tag= and writes what happened to
// window.results. Usage: foreign-page.ts; prints its port on the first line.
const page = (target: string, tag: string) => `<!doctype html><meta charset="utf-8"><title>foreign</title>
<iframe name="sink" style="display:none"></iframe>
<form id="f" method="POST" action="${target}/api/sessions" enctype="text/plain" target="sink">
  <input type="hidden" name='{"title":"${tag}-form","x":"' value='"}'>
</form>
<pre id="out"></pre>
<script>
window.results = {};
const done = (k, v) => { results[k] = v; document.getElementById("out").textContent = JSON.stringify(results, null, 1); };
fetch("${target}/api/sessions", { method: "POST", mode: "no-cors", headers: { "content-type": "text/plain" }, body: JSON.stringify({ title: "${tag}-fetch" }) })
  .then(() => done("fetch", "sent"), (e) => done("fetch", "error " + e));
document.getElementById("f").submit();
document.querySelector("iframe").addEventListener("load", () => done("form", "sent"));
const ws = new WebSocket("${target.replace(/^http/, "ws")}/ws");
ws.onopen = () => { done("ws", "open"); ws.close(); };
ws.onerror = () => done("ws", "refused");
</script>`;

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req) {
    const q = new URL(req.url).searchParams;
    return new Response(page(q.get("target") ?? "", q.get("tag") ?? "foreign"), { headers: { "content-type": "text/html" } });
  },
});
process.stdout.write(`${server.port}\n`);

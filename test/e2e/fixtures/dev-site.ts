import { mkdirSync, writeFileSync } from "node:fs";

// A dev server with a socket, the way a hot-reload server has one: it greets,
// and echoes what the page sends with the protocol it agreed on.
export function writeSite(SITE: string) {
  mkdirSync(SITE, { recursive: true });
  writeFileSync(`${SITE}/index.html`, '<html><head><title>site</title><link rel="stylesheet" href="/style.css"></head><body><h1>Portal works</h1><script src="/app.js"></script></body></html>');
  writeFileSync(`${SITE}/style.css`, "h1{color:rgb(13, 148, 136)}");
  writeFileSync(`${SITE}/app.js`, [
    'fetch("/data.json").then(r=>r.json()).then(d=>{document.body.insertAdjacentHTML("beforeend","<p id=d>"+d.msg+"</p>")});',
    'var w=new WebSocket("ws://"+location.host+"/hmr","test-hmr");',
    'w.onmessage=function(e){document.body.insertAdjacentHTML("beforeend","<p class=ws>"+e.data+"</p>");if(String(e.data).startsWith("hello"))w.send("ping "+w.protocol)};',
  ].join("\n"));
  writeFileSync(`${SITE}/data.json`, '{"msg":"fetched through the portal"}');
  writeFileSync(`${SITE}/serve.ts`, [
    "Bun.serve({ hostname: '127.0.0.1', port: Number(process.argv[2]),",
    "  fetch(req, s) { const u = new URL(req.url);",
    "    if (u.pathname === '/hmr') return s.upgrade(req, { headers: { 'sec-websocket-protocol': 'test-hmr' } }) ? undefined : new Response('no', { status: 400 });",
    "    return new Response(Bun.file(import.meta.dir + (u.pathname === '/' ? '/index.html' : u.pathname))); },",
    "  websocket: { open(ws) { ws.send('hello from the dev server'); }, message(ws, m) { ws.send('echo ' + m); } } });",
  ].join("\n"));
}

#!/usr/bin/env bun
// A stand-in for the fetch program the web tools hand a page fetch to
// (harness-webfetch-cli, KEEL_WEBFETCH_BIN), for the e2e: it takes the one
// request Keel writes on stdin, asks the spec's local server (WEB_STANDIN)
// for the page with the address it was asked for in a header, and answers as
// the program does. Nothing leaves this machine.
const text = await new Response(Bun.stdin.stream()).text();
const req = JSON.parse(text.split("\n").find((l) => l.trim()) ?? "{}");
const url = String(req.params?.params?.url ?? "");
const r = await fetch(`${process.env.WEB_STANDIN}/page`, { headers: { "x-standin-url": url } });
const body = await r.text();
console.log(JSON.stringify({ id: req.id, result: { kind: "ok", output: body, body_markdown: body, meta: { final_url: url, status: r.status } } }));

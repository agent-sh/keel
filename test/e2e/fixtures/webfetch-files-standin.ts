#!/usr/bin/env bun
// A stand-in for the fetch program (KEEL_WEBFETCH_BIN) over the spec's local server (WEB_STANDIN): a page it
// answers as the program does, a file (a type that is not text) with the program's own refusal by type, which
// is what the real program says of a PDF, an image or an archive.
const text = await new Response(Bun.stdin.stream()).text();
const req = JSON.parse(text.split("\n").find((l) => l.trim()) ?? "{}");
const url = new URL(String(req.params?.params?.url ?? ""));
const r = await fetch(`${process.env.WEB_STANDIN}${url.pathname}`);
const type = r.headers.get("content-type") ?? "";
if (!/^text\//.test(type)) {
  const bytes = (await r.arrayBuffer()).byteLength;
  console.log(JSON.stringify({ id: req.id, result: { kind: "error", error: { code: "UNSUPPORTED_CONTENT_TYPE", message: `Content-type '${type}' is not supported. Use bash(curl -o file <url>) to download binary content.`, meta: { bytes, contentType: type, url: url.href } } } }));
} else {
  const body = await r.text();
  console.log(JSON.stringify({ id: req.id, result: { kind: "ok", output: body, body_markdown: body, meta: { final_url: url.href, status: r.status, content_type: type } } }));
}

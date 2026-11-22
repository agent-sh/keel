// A stand-in language server for the cases a real one cannot be forced into:
// `slow` answers a diagnostics request after a pause, `flood` pours log
// messages once a document opens and answers nothing, `crash` exits when one opens, `push`
// answers by pushing (no version). Each line of a document that holds the
// word ERROR is one error diagnostic.
//   bun lsp-standin.ts <slow|flood|crash|push|plain> [pause ms]
const mode = process.argv[2] ?? "plain";
const pause = Number(process.argv[3] ?? 1200);
const docs = new Map<string, string>();
const enc = new TextEncoder();

function send(m: Record<string, unknown>) {
  const body = enc.encode(JSON.stringify({ jsonrpc: "2.0", ...m }));
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

const diagnose = (uri: string) =>
  (docs.get(uri) ?? "").split("\n").flatMap((line, i) => (line.includes("ERROR") ? [{
    range: { start: { line: i, character: line.indexOf("ERROR") }, end: { line: i, character: line.indexOf("ERROR") + 5 } },
    severity: 1, code: "STAND1", source: "standin", message: `the line says ERROR (${line.trim().slice(0, 40)})`,
  }] : []));

function opened(uri: string) {
  if (mode === "crash") process.exit(3);
  if (mode === "flood") {
    // Far more than a loading server ever says, in pieces that keep coming.
    const line = { method: "window/logMessage", params: { type: 3, message: "x".repeat(200) } };
    const pour = () => { for (let i = 0; i < 5000; i++) send(line); setTimeout(pour, 5); };
    pour();
  }
  if (mode === "push") send({ method: "textDocument/publishDiagnostics", params: { uri, diagnostics: diagnose(uri) } });
}

function handle(m: any) {
  switch (m.method) {
    case "initialize":
      return send({ id: m.id, result: { capabilities: { textDocumentSync: 1, ...(mode === "push" ? {} : { diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: false } }) }, serverInfo: { name: "standin", version: mode } } });
    case "textDocument/didOpen":
      docs.set(m.params.textDocument.uri, m.params.textDocument.text);
      return opened(m.params.textDocument.uri);
    case "textDocument/didChange":
      docs.set(m.params.textDocument.uri, m.params.contentChanges.at(-1).text);
      return opened(m.params.textDocument.uri);
    case "textDocument/diagnostic": {
      const answer = () => send({ id: m.id, result: { kind: "full", items: diagnose(m.params.textDocument.uri) } });
      if (mode === "flood") return; // it only pours: no answer comes
      return mode === "slow" ? void setTimeout(answer, pause) : answer();
    }
    case "shutdown":
      return send({ id: m.id, result: null });
    case "exit":
      process.exit(0);
  }
  if (m.id !== undefined && m.method) send({ id: m.id, error: { code: -32601, message: "not supported" } });
}

let buf = Buffer.alloc(0);
process.stdin.on("data", (chunk: Buffer) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const head = buf.indexOf("\r\n\r\n");
    if (head < 0) return;
    const len = Number(/content-length: (\d+)/i.exec(buf.subarray(0, head).toString())?.[1] ?? 0);
    if (buf.length < head + 4 + len) return;
    const msg = JSON.parse(buf.subarray(head + 4, head + 4 + len).toString());
    buf = buf.subarray(head + 4 + len);
    handle(msg);
  }
});
process.stdin.on("end", () => process.exit(0));

// Incremental stream decoders. Bytes arrive in arbitrary pieces (a plugin's
// chunks end inside characters and events); each decoder hands out whole events.

export type SseEvent = { event?: string; data: string };

const MAX_EVENT = 24 * 1024 * 1024;

export class SseDecoder {
  private text = new TextDecoder();
  private buf = "";
  private data: string[] = [];
  private event: string | undefined;

  push(bytes: Uint8Array | string): SseEvent[] {
    this.buf += typeof bytes === "string" ? bytes : this.text.decode(bytes, { stream: true });
    if (this.buf.length > MAX_EVENT) throw new Error("stream event over 24 MiB");
    const out: SseEvent[] = [];
    let nl: number;
    while ((nl = this.buf.search(/\r\n|\r|\n/)) >= 0) {
      const line = this.buf.slice(0, nl);
      const len = this.buf.startsWith("\r\n", nl) ? 2 : 1;
      // A lone CR at the end may be the first half of CRLF: wait for more.
      if (len === 1 && this.buf[nl] === "\r" && nl === this.buf.length - 1) break;
      this.buf = this.buf.slice(nl + len);
      this.line(line, out);
    }
    return out;
  }

  finish(): SseEvent[] {
    const out: SseEvent[] = [];
    if (this.buf) this.line(this.buf, out);
    this.buf = "";
    this.line("", out);
    return out;
  }

  private line(line: string, out: SseEvent[]) {
    if (line === "") {
      if (this.data.length) out.push({ event: this.event, data: this.data.join("\n") });
      this.data = [];
      this.event = undefined;
      return;
    }
    if (line.startsWith(":")) return;
    const i = line.indexOf(":");
    const field = i < 0 ? line : line.slice(0, i);
    let value = i < 0 ? "" : line.slice(i + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") this.data.push(value);
    else if (field === "event") this.event = value;
  }
}

// One JSON array streamed element by element (the Gemini streaming method
// without `alt=sse`): `[`, values separated by `,`, `]`.
export class JsonArrayDecoder {
  private text = new TextDecoder();
  private buf = "";
  private pos = 0;
  private state: "start" | "value" | "sep" | "done" = "start";

  push(bytes: Uint8Array | string): SseEvent[] {
    this.buf += typeof bytes === "string" ? bytes : this.text.decode(bytes, { stream: true });
    const out: SseEvent[] = [];
    for (;;) {
      while (this.pos < this.buf.length && /\s/.test(this.buf[this.pos]!)) this.pos++;
      if (this.pos >= this.buf.length) break;
      const c = this.buf[this.pos]!;
      if (this.state === "start") {
        if (c !== "[") throw new Error("stream decode error: expected [");
        this.pos++;
        this.state = "value";
      } else if (this.state === "sep") {
        if (c === ",") { this.pos++; this.state = "value"; }
        else if (c === "]") { this.pos++; this.state = "done"; }
        else throw new Error("stream decode error: expected , or ]");
      } else if (this.state === "value") {
        if (c === "]") { this.pos++; this.state = "done"; continue; }
        const end = valueEnd(this.buf, this.pos);
        if (end < 0) break;
        out.push({ data: this.buf.slice(this.pos, end) });
        this.pos = end;
        this.state = "sep";
      } else throw new Error("stream decode error: data after ]");
    }
    if (this.pos > 65536) { this.buf = this.buf.slice(this.pos); this.pos = 0; }
    return out;
  }

  finish(): SseEvent[] {
    return [];
  }
}

// Index after the JSON value starting at `i`, or -1 when it is not complete yet.
function valueEnd(s: string, i: number): number {
  const first = s[i]!;
  if (first !== "{" && first !== "[" && first !== '"') {
    const m = /^[^,\]\s]+/.exec(s.slice(i));
    if (!m || i + m[0].length >= s.length) return -1;
    return i + m[0].length;
  }
  let depth = 0;
  let inStr = false;
  for (let j = i; j < s.length; j++) {
    const ch = s[j];
    if (inStr) {
      if (ch === "\\") j++;
      else if (ch === '"') { inStr = false; if (depth === 0) return j + 1; }
    } else if (ch === '"') inStr = true;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") { if (--depth === 0) return j + 1; }
  }
  return -1;
}

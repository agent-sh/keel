// The export redactor, in a module of its own: the helper an ssh machine runs
// (src/fleet/hands-main.ts) uses it without the rest of the export code.
//
// Secrets out of a file that leaves the machine's stores: well-known key and
// token shapes, and private key blocks. Each hit becomes [redacted].
const SECRET_SHAPES = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,})\b/g,
  /\b(AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\b(Bearer\s+)[A-Za-z0-9._~+/-]{20,}=*/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
];

export function redact(text: string): string {
  let out = text;
  for (const re of SECRET_SHAPES) out = out.replace(re, (m, p1) => (typeof p1 === "string" && /^Bearer\s+$/.test(p1) ? `${p1}[redacted]` : "[redacted]"));
  return out;
}

// Every string of a JSON value, redacted by itself (ids and keys stay).
export function redactDeep(v: any): any {
  if (typeof v === "string") return redact(v);
  if (Array.isArray(v)) return v.map(redactDeep);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === "id" || k === "tool_use_id" ? x : redactDeep(x)]));
  return v;
}

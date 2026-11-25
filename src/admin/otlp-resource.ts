// The OpenTelemetry resource of what the daemon exports (traces, metrics, events): Keel's own attributes,
// then OTEL_RESOURCE_ATTRIBUTES (comma separated key=value pairs, values and keys percent-encoded), then
// OTEL_SERVICE_NAME, which wins for service.name as the SDK rules say. A pair that does not parse is
// dropped alone and named; the others stand.

export type ResourceRead = { resource: Record<string, unknown>; dropped: string[] };

function decode(s: string): string | undefined {
  try { return decodeURIComponent(s); } catch { return undefined; }
}

// The pairs of one OTEL_RESOURCE_ATTRIBUTES value.
export function parseAttributes(text: string | undefined): { pairs: [string, string][]; dropped: string[] } {
  const pairs: [string, string][] = [], dropped: string[] = [];
  for (const raw of (text ?? "").split(",")) {
    const item = raw.trim();
    if (!item) continue;
    const at = item.indexOf("=");
    const key = at > 0 ? decode(item.slice(0, at).trim()) : undefined;
    const value = at > 0 ? decode(item.slice(at + 1).trim()) : undefined;
    if (!key || /\s/.test(key) || value === undefined) { dropped.push(item.length > 60 ? `${item.slice(0, 59)}…` : item); continue; }
    pairs.push([key, value]);
  }
  return { pairs, dropped };
}

export function resourceOf(env: Record<string, string | undefined>, base: Record<string, unknown>): ResourceRead {
  const { pairs, dropped } = parseAttributes(env.OTEL_RESOURCE_ATTRIBUTES);
  const resource = { ...base };
  for (const [k, v] of pairs) resource[k] = v;
  const name = env.OTEL_SERVICE_NAME?.trim();
  if (name) resource["service.name"] = name;
  return { resource, dropped };
}

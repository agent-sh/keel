#!/usr/bin/env bun
// Token counts of text variants on the real tokenizer (a one-token request:
// the local Bedrock route has no count endpoint): how much a format choice costs before a lever is
// run end to end. `bun scripts/bench/count.ts [model]` prints one line per probe.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AnthropicBedrock } from "@anthropic-ai/bedrock-sdk";
import { numbered } from "../../src/tools/files.ts";

for (const line of (() => { try { return readFileSync(join(homedir(), ".config/claude-code/bedrock.env"), "utf8"); } catch { return ""; } })().split("\n")) {
  const m = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
}
const model = Bun.argv[2] ?? "global.anthropic.claude-haiku-5-5";
const client = new AnthropicBedrock({
  baseURL: process.env.ANTHROPIC_BEDROCK_BASE_URL, skipAuth: process.env.CLAUDE_CODE_SKIP_BEDROCK_AUTH === "1", awsRegion: process.env.AWS_REGION ?? "us-east-1",
});

async function tokens(text: string): Promise<number> {
  const r = await client.messages.create({ model, max_tokens: 1, messages: [{ role: "user", content: text }] } as any);
  return r.usage.input_tokens;
}

const base = await tokens("x");
const probes: [string, string][] = [];
const src = readFileSync(join(import.meta.dir, "../../src/engine/turn.ts"), "utf8");
probes.push(["read: raw file", src]);
probes.push(["read: padded `     N\\t` (now)", numbered(src).body]);
probes.push(["read: compact `N\\t`", src.split("\n").map((l, i) => `${i + 1}\t${l}`).join("\n")]);
probes.push(["read: compact `N→`", src.split("\n").map((l, i) => `${i + 1}→${l}`).join("\n")]);
for (const [name, text] of probes) console.log(`${name.padEnd(36)} ${(await tokens(text)) - base}`);

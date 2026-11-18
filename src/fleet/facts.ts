// What this machine has, for the machines list and the placement of work:
// cores, load, memory, a GPU, the developer tools on PATH, the sandbox.
import { readFileSync } from "node:fs";
import { arch, cpus, freemem, hostname, loadavg, platform, totalmem } from "node:os";
import { sandboxStatus } from "../safety/sandbox.ts";
import pkg from "../../package.json";
import type { Facts } from "./db.ts";

export const VERSION: string = (pkg as any).version ?? "dev";

const TOOLS = ["git", "gh", "bun", "node", "python3", "uv", "go", "cargo", "rustc", "gcc", "clang", "make", "docker", "podman", "nvidia-smi", "rg", "jq"];

let gpu: { at: number; value?: string } | undefined;

async function gpuName(): Promise<string | undefined> {
  if (gpu && Date.now() - gpu.at < 10 * 60_000) return gpu.value; // GPUs do not come and go: read every 10 min
  let value: string | undefined;
  if (Bun.which("nvidia-smi")) {
    try {
      const p = Bun.spawn(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader"], { stdout: "pipe", stderr: "ignore" });
      const t = setTimeout(() => p.kill(), 3000);
      const out = await new Response(p.stdout).text();
      clearTimeout(t);
      value = out.trim().split("\n").filter(Boolean).join("; ") || undefined;
    } catch {}
  } else if (platform() === "darwin" && arch() === "arm64") value = "Apple Silicon (Metal)";
  gpu = { at: Date.now(), value };
  return value;
}

function memAvailableMb(): number {
  try {
    const m = readFileSync("/proc/meminfo", "utf8").match(/MemAvailable:\s+(\d+)/);
    if (m) return Math.round(Number(m[1]) / 1024);
  } catch {}
  return Math.round(freemem() / 1048576);
}

export async function localFacts(root?: string): Promise<Facts> {
  return {
    hostname: hostname(),
    os: platform() === "darwin" ? "macos" : platform(),
    arch: arch() === "x64" ? "x86_64" : arch() === "arm64" ? "aarch64" : arch(),
    cpus: cpus().length,
    load1: Math.round(loadavg()[0]! * 100) / 100,
    mem_total_mb: Math.round(totalmem() / 1048576),
    mem_available_mb: memAvailableMb(),
    gpu: await gpuName(),
    tools: TOOLS.filter((t) => Bun.which(t)),
    sandbox: sandboxStatus().available,
    keel_version: VERSION,
    root,
  };
}

// Free cores at the last check: the default size of a machine's job queue.
export const freeCores = (f: Facts) => Math.max(1, Math.floor(f.cpus - f.load1));

// A machine reached over ssh with nothing of Keel installed by the owner: the
// daemon holds one master connection per machine (its own control socket, the
// owner's ssh configuration otherwise as is, never a prompt), runs short
// commands over it (the facts, a folder listing), and for sessions puts a small
// helper there (src/fleet/hands-main.ts with a Bun runtime, under
// ~/.cache/keel-remote) that serves the hands on a unix socket, forwarded here
// to a socket in the daemon's state. The same design as Zed's remote server
// and VS Code's server, without a port on either side.
//
// On the remote, ~/.cache/keel-remote (KEEL_REMOTE_DIR, under the home) holds:
//   bun-<version>-<os>-<arch>/bun   the runtime (uploaded, or fetched there for another platform)
//   hands-<hash>.js                 the helper, one file per build
//   run-<hash>/                     its socket, pid and log (0700)
//   spill/                          the sessions' jobs and long outputs
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { readText } from "../core/proc.ts";
import type { Facts } from "./db.ts";
import { LinkError } from "./link.ts";
import { sshProgram } from "./sshconfig.ts";

declare const __KEEL_HANDS_JS__: string | undefined;

export const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const CONNECT_MS = 10_000; // ConnectTimeout 5 s, plus the login itself
const READ_MS = 10_000;
const TOOLS = ["git", "gh", "bun", "node", "python3", "uv", "go", "cargo", "rustc", "gcc", "clang", "make", "docker", "podman", "nvidia-smi", "rg", "jq"];

// What a machine is and has, in one round trip, through the login shell (the
// PATH its tools will have). key=value lines, read by parseProbe.
const PROBE = `echo "os=$(uname -s)"; echo "arch=$(uname -m)"; echo "host=$(hostname)"; echo "home=$HOME"
echo "mid=$(cat /etc/machine-id 2>/dev/null || ioreg -rd1 -c IOPlatformExpertDevice 2>/dev/null | awk -F'"' '/IOPlatformUUID/{print $4}')"
echo "cpus=$(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu)"
if [ -r /proc/loadavg ]; then echo "load=$(cut -d' ' -f1 /proc/loadavg)"; else echo "load=$(sysctl -n vm.loadavg | awk '{print $2}')"; fi
if [ -r /proc/meminfo ]; then awk '/^MemTotal/{print "memk="$2} /^MemAvailable/{print "availk="$2}' /proc/meminfo
else echo "memb=$(sysctl -n hw.memsize)"; vm_stat | awk '/page size of/{ps=$8} /Pages (free|inactive|purgeable|speculative):/{gsub(/\\./,"",$NF); n+=$NF} END{print "availb=" n*ps}'; fi
command -v nvidia-smi >/dev/null 2>&1 && echo "gpu=$(nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>/dev/null | paste -sd ';' -)"
[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] && echo "gpu=Apple Silicon (Metal)"
printf tools=; for t in ${TOOLS.join(" ")}; do command -v $t >/dev/null 2>&1 && printf '%s ' $t; done; echo
command -v bwrap >/dev/null 2>&1 && echo sandbox=1
[ -d "$HOME/${process.env.KEEL_REMOTE_DIR ?? ".cache/keel-remote"}" ] && echo "helper=$HOME/${process.env.KEEL_REMOTE_DIR ?? ".cache/keel-remote"}"
true`;

export const loginCommand = (script: string) => `exec "\${SHELL:-/bin/sh}" -lc ${q(script)}`;
export const PROBE_SCRIPT = PROBE;

export type Probe = Facts & { home: string; machine_id?: string; helper_dir?: string; platform: string };

export function parseProbe(out: string): Probe {
  const v: Record<string, string> = {};
  for (const l of out.split("\n")) { const i = l.indexOf("="); if (i > 0 && !(l.slice(0, i) in v)) v[l.slice(0, i)] = l.slice(i + 1).trim(); }
  const os = v.os === "Darwin" ? "macos" : (v.os ?? "").toLowerCase();
  const arch = v.arch === "arm64" ? "aarch64" : v.arch ?? "";
  const mb = (k: string, d: number) => (v[k] ? Math.round(Number(v[k]) / d) : undefined);
  return {
    hostname: v.host ?? "", os, arch, cpus: Number(v.cpus) || 1, load1: Number(v.load) || 0,
    mem_total_mb: mb("memk", 1024) ?? mb("memb", 1048576) ?? 0, mem_available_mb: mb("availk", 1024) ?? mb("availb", 1048576),
    gpu: v.gpu || undefined, tools: (v.tools ?? "").split(/\s+/).filter(Boolean), sandbox: v.sandbox === "1", keel_version: "ssh",
    home: v.home ?? "", machine_id: v.mid || undefined, helper_dir: v.helper || undefined,
    platform: `${os === "macos" ? "darwin" : os}-${arch === "x86_64" ? "x64" : arch}`,
  };
}

const localPlatform = () => `${process.platform}-${process.arch === "arm64" ? "aarch64" : "x64"}`;

// The helper's code: bundled with the binary at build time, else bundled from
// the source once per daemon process.
let bundle: Promise<{ text: string; hash: string }> | undefined;
export function handsBundle() {
  return (bundle ??= (async () => {
    let text: string;
    if (typeof __KEEL_HANDS_JS__ === "string") text = __KEEL_HANDS_JS__;
    else {
      const r = await Bun.build({ entrypoints: [join(import.meta.dir, "hands-main.ts")], target: "bun", minify: true });
      if (!r.success) throw new Error(`the ssh helper does not build: ${r.logs.map(String).join("; ")}`);
      text = await r.outputs[0]!.text();
    }
    return { text, hash: Bun.hash(text).toString(16).slice(0, 12) };
  })());
}

// Every master this process started, closed when it exits (each is its own ssh
// process and would outlive it).
const g = globalThis as { __keelSshMasters?: Set<Bun.Subprocess>; __keelSshExit?: boolean };
const masters = (g.__keelSshMasters ??= new Set());
if (!g.__keelSshExit) {
  g.__keelSshExit = true;
  process.on("exit", () => { for (const p of masters) try { p.kill(); } catch {} });
}

export type Installed = { runtime: string; helper: string; uploaded: string[]; dir: string };

export class SshLink {
  private proc?: Bun.Subprocess;
  private ready?: Promise<string>;
  private forwarded?: string;
  route?: string;
  probe?: Probe;
  installed?: Installed;

  constructor(readonly id: string, readonly routes: () => string[], private sockDir: string, private log: (msg: string) => void = () => {}) {}

  private ctl() { return join(this.sockDir, `${this.id}.ctl`); }

  // The master connection, on the first route that answers.
  async master(): Promise<string> {
    if (this.proc && this.proc.exitCode === null && this.route && existsSync(this.ctl())) return this.route;
    this.close();
    mkdirSync(this.sockDir, { recursive: true, mode: 0o700 });
    const errs: string[] = [];
    for (const alias of this.routes()) {
      rmSync(this.ctl(), { force: true });
      const proc = Bun.spawn([sshProgram(), "-N", "-M", "-S", this.ctl(), "-o", "ControlPersist=no", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5",
        "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "-o", "ForwardAgent=no", "-o", "StreamLocalBindUnlink=yes", "-o", "ExitOnForwardFailure=no", alias],
        { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
      masters.add(proc);
      proc.exited.then(() => { masters.delete(proc); if (this.proc === proc) { this.ready = undefined; this.forwarded = undefined; } });
      const deadline = Date.now() + CONNECT_MS;
      while (Date.now() < deadline && proc.exitCode === null && !existsSync(this.ctl())) await Bun.sleep(100);
      if (proc.exitCode === null && existsSync(this.ctl())) {
        this.proc = proc;
        this.route = alias;
        return alias;
      }
      proc.kill();
      const err = (await readText(proc.stderr)).trim().split("\n").filter(Boolean).pop();
      errs.push(`${alias}: ${err || (proc.exitCode === null ? "no answer within 10 s" : `ssh exited ${proc.exitCode}`)}`);
    }
    throw new LinkError(errs.join("; ") || "no ssh route");
  }

  close() {
    this.ready = undefined;
    this.forwarded = undefined;
    if (this.proc && this.proc.exitCode === null) this.proc.kill();
    this.proc = undefined;
  }

  // One command over the master. `script` runs in the login shell.
  async run(script: string, opts: { stdin?: Uint8Array; timeout?: number; signal?: AbortSignal } = {}): Promise<{ code: number; out: string; err: string }> {
    const alias = await this.master();
    const p = Bun.spawn([sshProgram(), "-S", this.ctl(), "-o", "ControlMaster=no", "-o", "BatchMode=yes", "-T", alias, loginCommand(script)],
      { stdin: opts.stdin ? new Blob([opts.stdin as BlobPart]) : "ignore", stdout: "pipe", stderr: "pipe", signal: opts.signal, timeout: opts.timeout ?? 60_000 });
    const [out, err, code] = await Promise.all([readText(p.stdout), readText(p.stderr), p.exited]);
    return { code, out, err };
  }

  async readFacts(): Promise<Probe> {
    const r = await this.run(PROBE, { timeout: 20_000 });
    if (r.code !== 0 || !/^os=/m.test(r.out)) throw new LinkError(`${this.route}: the facts did not come (${r.err.trim().split("\n").pop() || `exit ${r.code}`})`);
    return (this.probe = parseProbe(r.out));
  }

  // The helper there, started when it is not running; resolves to the local
  // socket that reaches it.
  private async start(): Promise<string> {
    const alias = await this.master();
    const p = this.probe ?? (await this.readFacts());
    if (!p.home?.startsWith("/")) throw new LinkError(`${alias}: no home directory reported`);
    const { text, hash } = await handsBundle();
    const base = `${p.home}/${process.env.KEEL_REMOTE_DIR ?? ".cache/keel-remote"}`;
    const runtime = `${base}/bun-${Bun.version}-${p.platform}/bun`;
    const helper = `${base}/hands-${hash}.js`;
    const runDir = `${base}/run-${hash}`;
    const remoteSock = `${runDir}/hands.sock`;
    const uploaded: string[] = [];
    const have = await this.run(`[ -x ${q(runtime)} ] && echo runtime; [ -f ${q(helper)} ] && echo helper; true`);
    if (!/runtime/.test(have.out)) {
      if (p.platform === localPlatform()) {
        // This process's own runtime (bun, or the keel binary, which runs as bun with BUN_BE_BUN=1).
        this.log(`uploading the Bun runtime to ${alias}`);
        const gz = Bun.gzipSync(new Uint8Array(await Bun.file(process.execPath).arrayBuffer()), { level: 1 });
        const r = await this.run(`mkdir -p ${q(runtime.slice(0, runtime.lastIndexOf("/")))} && gzip -dc > ${q(runtime)}.part && chmod 755 ${q(runtime)}.part && mv ${q(runtime)}.part ${q(runtime)}`, { stdin: gz, timeout: 10 * 60_000 });
        if (r.code !== 0) throw new LinkError(`${alias}: the runtime did not upload: ${r.err.trim() || `exit ${r.code}`}`);
      } else {
        // Another platform: that machine fetches the same Bun version for itself.
        const asset = `bun-${p.platform}`;
        const url = `https://github.com/oven-sh/bun/releases/download/bun-v${Bun.version}/${asset}.zip`;
        this.log(`fetching Bun ${Bun.version} for ${p.platform} on ${alias}`);
        const dir = runtime.slice(0, runtime.lastIndexOf("/"));
        const r = await this.run(`set -e; mkdir -p ${q(dir)}; cd ${q(dir)}; (curl -fsSL ${q(url)} -o b.zip || wget -qO b.zip ${q(url)}); (unzip -oq b.zip || python3 -m zipfile -e b.zip .); mv ${asset}/bun bun.part; chmod 755 bun.part; mv bun.part bun; rm -rf b.zip ${asset}`, { timeout: 10 * 60_000 });
        if (r.code !== 0) throw new LinkError(`${alias}: Bun ${Bun.version} for ${p.platform} could not be fetched there: ${r.err.trim().split("\n").pop() || `exit ${r.code}`}`);
      }
      uploaded.push(runtime);
    }
    if (!/helper/.test(have.out)) {
      const r = await this.run(`mkdir -p ${q(base)} && chmod 700 ${q(base)} && cat > ${q(helper)}.part && mv ${q(helper)}.part ${q(helper)}`, { stdin: new TextEncoder().encode(text) });
      if (r.code !== 0) throw new LinkError(`${alias}: the helper did not upload: ${r.err.trim() || `exit ${r.code}`}`);
      uploaded.push(helper);
    }
    // Detached from the ssh session (setsid, else nohup), so a dropped link
    // leaves it and its jobs running; a second start finds the first and exits.
    const cmd = `env BUN_BE_BUN=1 ${q(runtime)} ${q(helper)} --dir ${q(runDir)} --spill ${q(`${base}/spill`)} --version ${hash}`;
    const r = await this.run(`mkdir -p ${q(runDir)} && chmod 700 ${q(base)} ${q(runDir)} && cd "$HOME" && if [ -S ${q(remoteSock)} ] && kill -0 "$(cat ${q(runDir)}/hands.pid 2>/dev/null)" 2>/dev/null; then echo running; else if command -v setsid >/dev/null 2>&1; then setsid ${cmd} >> ${q(runDir)}/hands.log 2>&1 < /dev/null & else nohup ${cmd} >> ${q(runDir)}/hands.log 2>&1 < /dev/null & fi; echo started; fi; i=0; while [ ! -S ${q(remoteSock)} ] && [ $i -lt 150 ]; do sleep 0.1; i=$((i+1)); done; [ -S ${q(remoteSock)} ] || { echo "it did not open its socket within 15 s; its log:" >&2; tail -n 5 ${q(runDir)}/hands.log >&2; exit 1; }`);
    if (r.code !== 0) throw new LinkError(`${alias}: the helper did not start: ${r.err.trim() || `exit ${r.code}`}`);
    this.installed = { runtime, helper, uploaded, dir: base };
    if (uploaded.length) this.log(`installed on ${alias}: ${uploaded.join(", ")}`);
    const local = join(this.sockDir, `${this.id}-${hash}.sock`);
    if (this.forwarded !== remoteSock || !existsSync(local)) {
      if (this.forwarded) Bun.spawnSync([sshProgram(), "-S", this.ctl(), "-O", "cancel", "-L", `${local}:${this.forwarded}`, alias], { stdout: "ignore", stderr: "ignore" });
      rmSync(local, { force: true });
      const f = Bun.spawnSync([sshProgram(), "-S", this.ctl(), "-O", "forward", "-L", `${local}:${remoteSock}`, alias], { stdout: "pipe", stderr: "pipe" });
      if (f.exitCode !== 0) throw new LinkError(`${alias}: the forward to the helper failed: ${f.stderr.toString().trim()}`);
      this.forwarded = remoteSock;
    }
    // It answers once its socket is up (a fresh start takes a moment).
    const deadline = Date.now() + 15_000;
    for (;;) {
      try {
        const res = await fetch("http://keel/ping", { unix: local, signal: AbortSignal.timeout(3000) });
        if (res.ok) return local;
      } catch {}
      if (Date.now() > deadline) throw new LinkError(`${alias}: the helper does not answer (its log: ${runDir}/hands.log)`);
      await Bun.sleep(200);
    }
  }

  // One request to the helper. A link that dropped is opened again once; a
  // call that must survive a drop (`retryMs`) is asked again with the same id
  // until it answers, which reattaches to the run that went on there.
  async fetch(path: string, init: RequestInit & { timeout?: number; retryMs?: number; idempotent?: boolean } = {}): Promise<Response> {
    const until = Date.now() + (init.retryMs ?? 0);
    for (let attempt = 0; ; attempt++) {
      let sent = false;
      try {
        const sock = await (this.ready ??= this.start().catch((e) => { this.ready = undefined; throw e; }));
        const t = init.timeout ?? READ_MS;
        const signal = init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(t)]) : AbortSignal.timeout(t);
        const headers = new Headers(init.headers);
        if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
        sent = true;
        const r = await fetch(`http://keel${path}`, { ...init, headers, unix: sock, signal } as RequestInit);
        // Read here: a body cut by a dropped link is a failed attempt, not a short answer.
        const buf = await r.arrayBuffer();
        return new Response(buf, { status: r.status, headers: r.headers });
      } catch (e) {
        if (init.signal?.aborted) throw e;
        const msg = (e as Error).name === "TimeoutError" ? `no answer within ${(init.timeout ?? READ_MS) / 1000} s` : (e as Error).message;
        this.ready = undefined;
        // A request that may have run there is not sent twice, unless asking again is safe.
        const again = !sent || init.idempotent || init.retryMs;
        if (!again || (attempt >= 1 && Date.now() >= until)) throw e instanceof LinkError ? e : new LinkError(`${this.route ?? this.id}: ${msg}`);
        await Bun.sleep(Math.min(30_000, 500 * 2 ** attempt));
      }
    }
  }

  // The folders inside one folder there, for the folder picker (no helper needed).
  async dirs(path: string): Promise<{ path: string; dirs: { name: string; is_git: boolean }[]; is_git: boolean }> {
    const r = await this.run(`cd -- ${q(path)} 2>/dev/null || exit 3; pwd; [ -e .git ] && echo "G"; for d in */; do [ -d "$d" ] || continue; n=\${d%/}; if [ -e "$n/.git" ]; then echo "g	$n"; else echo "d	$n"; fi; done; true`, { timeout: 20_000 });
    if (r.code === 3) throw new LinkError(`not a folder there: ${path}`);
    if (r.code !== 0) throw new LinkError(`${this.route}: ${r.err.trim().split("\n").pop() || `exit ${r.code}`}`);
    const lines = r.out.split("\n").filter(Boolean);
    const dirs = lines.slice(1).filter((l) => /^[gd]\t/.test(l)).map((l) => ({ name: l.slice(2), is_git: l[0] === "g" })).filter((d) => d.name !== "*");
    return { path: lines[0] ?? path, is_git: lines[1] === "G", dirs: dirs.slice(0, 500) };
  }
}

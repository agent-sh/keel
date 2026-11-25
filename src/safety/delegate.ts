// Which approval cards the owner's helper may answer for him, decided here in
// code from the gate's own facts, never from the helper's words.
//
// The owner can let the helper answer other sessions' approval cards on his
// standing instruction (Settings > Helper > Answer approvals, on by default):
// allow what they ask unless it is really risky. The helper answers only a card
// on the allow-list (`offList`): one whose card shows its whole effect, and
// that effect stays in the session's folder on this machine. A list of what to
// refuse always misses a form; a list of what may pass does not grow by itself.
// The list, and nothing else:
//
// - a command whose every part is a program of the list, with arguments that
//   run no code: ls, cat, head, tail, grep, rg, find (no -exec, -delete or
//   file output), wc, sort (no output file or compressor), diff, stat, file,
//   jq, sed (no e or w command, its in-place files in the folder) and awk (no
//   system, pipe or output redirect, no program file); git's reading and local
//   commands (status, log, diff, show, branch, fetch, clone into the folder or
//   the cache, add, commit, checkout or switch of a local branch, stash);
//   curl and wget GET requests to a public host, with no redirect followed;
//   mkdir, cp and mv within the folder;
// - an edit or a write of files in the folder that are not executable and that
//   no runner reads as code (`codeFile`: tests, conftest.py, build and package
//   files, hooks, CI, agent instructions, installed packages);
// - an MCP tool whose server says readOnlyHint and does not say destructiveHint.
//
// Every other card is the owner's, named by its class where one is known and
// `unseen` otherwise. The classes, which come first whatever the list says:
//
// - provenance: outside content (a page, an issue, a tool server's answer)
//   named the call's target first. A guard against prompt injection: a model
//   never answers it, the helper included.
// - owner-only: the policy says only the owner allows it (Keel's own files, a
//   credential, what runs later outside the sandbox, another session's
//   prompt), a tool that confirms every call (sending a mail), a hook of his
//   that asks him, and a write with his account beyond his namespaces (a
//   repository or a package that is not his).
// - spend: renting machines or paying for something.
// - publish: an irreversible publication (a package, a release, a deploy, a
//   pushed tag, private words in a public place).
// - delete: an irreversible deletion, here or on another machine or service.
// - authority: power over his machines or the rules he has not given (leaving
//   the sandbox, root, services and schedules of the machine, a change on
//   another machine or a service, credentials sent out or read, sign-ins,
//   Keel's permissions and settings).
// - unseen: the card does not hold the whole request (its input was kept only
//   in part), or what it does is not on the list, so nobody but the owner can
//   stand behind an allow.
//
// The card as stored and the session's place in, a class or null out
// (delegate.test.ts). The place (`localPlace`) is what this machine's disk says
// of the paths: where links lead, which file is executable, which branch exists.
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { name as base, unwrap, type RiskRule } from "./risk-words.ts";
import { splitCommand, type Simple } from "./shell.ts";
import { isOwnPort } from "./net-proxy.ts";
import { privateHost } from "../core/hosts.ts";
import { contains, homeDir, realOf } from "../core/paths.ts";

// What made a one-call card (gate.ts askOnce): outside content named the target, a tool that confirms
// each call, private words in a public place, a hook of the owner's that asks.
export type Held = "provenance" | "confirm" | "words" | "hook";
// What the gate knew of why it asked, kept with the card (gate.ts card()).
// `owner_only`: the policy's onlyOwner. `account`: a write with the owner's account beyond his namespaces.
// `risks`: the classes of what makes a command high risk (risk-words.ts). `held`: a one-call card and what made it.
// `read_hint`: an MCP tool whose server says it only reads (readOnlyHint) and does not say it may destroy (destructiveHint).
export type CardFacts = { owner_only?: true; account?: string; risks?: RiskRule[]; held?: Held; read_hint?: true };

export type OwnerClass = "provenance" | "owner-only" | "spend" | "publish" | "delete" | "authority" | "unseen" | "helper";
export const CLASS_WORDS: Record<OwnerClass, string> = {
  provenance: "outside content named its target first",
  "owner-only": "only the owner allows it",
  spend: "it spends money or rents machines",
  publish: "it publishes something that cannot be taken back",
  delete: "it deletes something that cannot be brought back",
  authority: "it changes what may run on the machine or what the rules allow",
  unseen: "the card does not show its whole effect, or it is not on the list the helper may answer",
  helper: "it is the helper's own call",
};

// The card as the class is read from: what the gate stored.
export type CardIn = {
  tool: string; kind: string; summary: string; input: unknown; risk: "high" | "low";
  rule?: string; why?: string; once?: boolean; autoOwner?: boolean; cut?: boolean; input_len?: number; mine?: string;
  at?: { cwd?: string; sub?: string; shell?: string; away?: true };
  facts?: CardFacts;
};

// The rule words the policy gives what leaves the sandbox, reads credentials or is Keel's own (policy.ts).
const AUTHORITY_RULES = [/asks to leave the sandbox/, /reads credentials/, /Keel's own configuration/, /runs later, outside the sandbox/, /credential store/, /outside what the sandbox shows/, /runs as root/i, /acts in another session/];

// One class for a card, or null: the card is on the allow-list and the helper may judge it. The classes come first
// (they name why a card is the owner's); then the list: a card off it is the owner's, by the class of what took it
// off, else `unseen`. With no place (the session is gone), nothing is on the list.
export function ownerClass(a: CardIn, isHelperSession = false, place?: Place): { cls: OwnerClass; why: string } | null {
  const say = (cls: OwnerClass, detail?: string) => ({ cls, why: detail ? `${CLASS_WORDS[cls]}: ${detail}` : CLASS_WORDS[cls] });
  const f = a.facts ?? {};
  if (isHelperSession) return say("helper");
  if (f.held === "provenance") return say("provenance", a.why);
  if (f.held === "words") return say("publish", a.why);
  if (f.held === "confirm" || f.held === "hook" || a.once) return say("owner-only", a.why);
  if (f.owner_only || a.autoOwner) return say("owner-only", a.why);
  if (f.account !== undefined || a.mine) return say("owner-only", `a write beyond your accounts${f.account ? ` (${f.account})` : ""}`);
  if (a.input_len !== undefined || a.cut || isClipped(a.input)) return say("unseen");
  const rule = a.rule ?? "";
  const auth = AUTHORITY_RULES.find((r) => r.test(rule));
  if (auth) return say("authority", rule);
  // Driving another session (a message, an answer, a model command) or Keel itself (its sessions, machines, agents,
  // records): what it sets going is not on this card.
  const inner = a.tool === "mcp_call" && a.input && typeof a.input === "object" ? String((a.input as { tool?: unknown }).tool ?? "") : "";
  if (a.kind === "drive" || /^keel__/.test(a.tool) || /^keel__/.test(inner)) return say("authority", `it drives another session or Keel itself (${inner || a.tool})`);
  const risks = new Set(f.risks ?? []);
  // What the command or the tool says it does names the class first; the rules' risk classes after it.
  if (a.kind === "shell") {
    const hit = shellClass(a.summary);
    if (hit) return say(hit.cls, hit.what);
    const reach = keelReach(a.summary, true);
    if (reach) return say("authority", reach);
    // Code the card does not show (awk's program is read by the list instead).
    const hidden = hiddenCode(a.summary);
    if (hidden && !(offList(a, place) === null && /^(awk|gawk|mawk|nawk) /.test(hidden))) return say("unseen", hidden);
    if (risks.has("hidden")) return say("unseen", a.why);
  } else {
    // (An edit's strings are a file's text, which runs nothing by being written: where it lands is judged by the list.)
    const hit = toolClass(toolWords(a.tool, a.input)) ?? (a.kind === "edit" ? null : valuesClass(a.tool, a.input));
    if (hit) return say(hit.cls, hit.what);
  }
  if (risks.has("destroys")) return say("delete", a.why);
  // A change on another machine or a service (its deletions and the files there that run later are among it),
  // credentials sent out, a reach past the session on this machine.
  if (risks.has("remote") || risks.has("exposes") || risks.has("machine")) return say("authority", a.why);
  const off = offList(a, place);
  return off ? say(off.cls, off.what) : null;
}

const isClipped = (v: unknown) => !!v && typeof v === "object" && "_clipped" in (v as object);

// --- commands ------------------------------------------------------------------

// The simple commands of a line as the gate's own parser reads them (quotes taken off, a here-document's lines and
// what a substitution runs among them), each with the program it runs past assignments and wrappers (`run`) and
// the words before that (`pre`: the wrappers). Null: the parser cannot read the line.
type Part = { s: Simple; run: string[]; at: number; pre: string[]; deep?: true };
function partsOf(line: string): Part[] | null {
  const parts = splitCommand(line);
  if (!parts) return null;
  return parts.map((s) => { const r = unwrap(s.words); return { s, run: r.words, at: r.at, pre: s.words.slice(0, r.at), ...(r.deep ? { deep: true as const } : {}) }; });
}

// A rough split, for a line the parser cannot read: the class words are still looked for in it.
export function simpleCommands(line: string): string[][] {
  return line.split(/\|\||&&|[;|&\n]|\$\(|`|\(|\)/).map((part) => part.trim().split(/\s+/).map((w) => w.replace(/^['"]+|['"]+$/g, "")).filter(Boolean)).filter((w) => w.length);
}

const ROOT = new Set(["sudo", "doas", "pkexec", "su", "run0"]);
const MACHINE = new Set(["systemctl", "systemd-run", "loginctl", "crontab", "launchctl", "chsh", "passwd", "usermod", "useradd", "userdel", "groupadd", "visudo", "ufw", "iptables", "ip6tables", "nft", "modprobe", "insmod", "mount", "umount", "swapon", "sysctl", "update-alternatives", "ssh-add", "ssh-copy-id"]);
const PACKAGE_PUBLISH = new Set(["npm", "pnpm", "yarn", "bun", "cargo", "poetry", "uv", "hatch", "flit", "gem", "vsce", "ovsx", "twine", "helm", "deno", "jsr"]);
const CLOUD_RENT: Record<string, RegExp> = {
  vastai: /^(create|start|launch|rent|copy|transfer|deposit)$/,
  runpodctl: /^(create|start|deploy)$/,
  runpod: /^(create|start|deploy)$/,
  hcloud: /^create$/,
  doctl: /^create$/,
  "linode-cli": /^create$/,
  "vultr-cli": /^create$/,
  sky: /^(launch|start|up|exec)$/,
  modal: /^(run|deploy|serve)$/,
  lambda: /^(launch|create)$/,
  nebius: /^(create|start)$/,
  oci: /^(launch|create)$/,
};
const INFRA = new Set(["terraform", "tofu", "pulumi", "cdk", "cdktf"]);
// Clients that send a request to a service, and the ones that open a raw connection (what they send is not shown).
const HTTP_CLIENTS = new Set(["curl", "wget", "http", "https", "xh", "xhs", "httpie", "curlie", "grpcurl"]);
const RAW_CLIENTS = new Set(["nc", "ncat", "netcat", "socat", "telnet", "websocat", "wscat"]);

type Hit = { cls: OwnerClass; what: string } | null;

// The class of a command line the gate asked about, or null.
export function shellClass(line: string): Hit {
  const parts = partsOf(line);
  const list: { words: string[]; pre: string[] }[] = parts ? parts.map((x) => ({ words: x.run, pre: x.pre })) : simpleCommands(line).map((w) => ({ words: w, pre: [] }));
  for (const { words, pre } of list) {
    const lead = pre.map(base).find((w) => ROOT.has(w) || MACHINE.has(w));
    if (lead) return { cls: "authority", what: `${lead} ${ROOT.has(lead) ? "runs as root" : "changes the machine"} (${[...pre, ...words].join(" ").slice(0, 160)})` };
    if (!words.length) continue;
    const hit = wordsClass(words, line);
    if (hit) return hit;
  }
  return null;
}

function wordsClass(words: string[], line: string): Hit {
  const p = base(words[0]!);
  const args = words.slice(1);
  const said = words.join(" ").slice(0, 160);
  const has = (re: RegExp) => args.some((a) => re.test(a));
  // (git's command stands after its own options and their values: git -C . push.)
  const verb = (p === "git" ? gitCommand(args).verb : args.find((a) => !a.startsWith("-"))) ?? "";
  const method = methodOf(p, args);
  if (ROOT.has(p)) return { cls: "authority", what: `${p} runs as root (${said})` };
  if (MACHINE.has(p)) return { cls: "authority", what: said };
  // Sign-ins, secrets and keys of the owner's accounts.
  if ((p === "gh" || p === "glab") && /^(auth|secret|ssh-key|gpg-key|variable)$/.test(verb)) return { cls: "authority", what: said };
  if ((p === "aws" && verb === "configure") || (p === "gcloud" && verb === "auth") || (p === "az" && verb === "login") || (p === "npm" && /^(login|adduser|token|owner|access)$/.test(verb)) || (p === "git" && verb === "config" && has(/^--(global|system)$/))) return { cls: "authority", what: said };
  // Spend: renting machines, or infrastructure applied as written.
  if (CLOUD_RENT[p] && args.some((a) => CLOUD_RENT[p]!.test(a))) return { cls: "spend", what: said };
  if (p === "aws" && has(/^(run-instances|start-instances|request-spot-instances|request-spot-fleet|create-fleet|purchase-.*|create-capacity-reservation|create-cluster|create-db-instance|create-nodegroup)$/)) return { cls: "spend", what: said };
  if (p === "gcloud" && has(/^(create|start)$/) && has(/^(instances|tpus|clusters|tpu-vm|instance-groups|reservations)$/)) return { cls: "spend", what: said };
  if (p === "az" && has(/^(create|start)$/) && has(/^(vm|aks|vmss)$/)) return { cls: "spend", what: said };
  if (INFRA.has(p) && has(/^(apply|up|deploy)$/)) return { cls: "spend", what: said };
  if (INFRA.has(p) && has(/^destroy$/)) return { cls: "delete", what: said };
  // Publication that cannot be taken back.
  if (PACKAGE_PUBLISH.has(p) && has(/^(publish|unpublish|yank|push|release)$/)) return { cls: "publish", what: said };
  if (p === "twine" && verb === "upload") return { cls: "publish", what: said };
  if (p === "uv" && verb === "publish") return { cls: "publish", what: said };
  if (/^(changeset|semantic-release|release-it|goreleaser|np|lerna)$/.test(p) && (p !== "changeset" || has(/^publish$/)) && (p !== "lerna" || has(/^publish$/))) return { cls: "publish", what: said };
  if ((p === "docker" || p === "podman" || p === "buildah" || p === "skopeo") && /^(push|copy)$/.test(verb)) return { cls: "publish", what: said };
  if (p === "dotnet" && has(/^push$/) && has(/^nuget$/)) return { cls: "publish", what: said };
  if ((p === "gh" || p === "glab") && /^release$/.test(verb) && has(/^(create|upload|edit|delete)$/)) return { cls: "publish", what: said };
  if ((p === "gh" || p === "glab") && verb === "repo" && has(/^(delete|archive|rename|transfer)$/)) return { cls: "delete", what: said };
  if ((p === "gh" || p === "glab") && verb === "repo" && has(/^--visibility(=public)?$|^--public$/)) return { cls: "publish", what: said };
  if ((p === "gh" || p === "glab") && /^(workflow|run)$/.test(verb) && has(/^(run|rerun|enable)$/)) return { cls: "authority", what: said };
  if (/^(wrangler|vercel|netlify|firebase|flyctl|fly|railway|heroku|surge)$/.test(p) && has(/^(deploy|publish|--prod|release)$/)) return { cls: "publish", what: said };
  if (p === "git" && verb === "push") {
    if (has(/^--tags$|^--follow-tags$|^refs\/tags\//) || args.some((a, k) => k > 0 && /^v?\d+\.\d+/.test(a))) return { cls: "publish", what: said };
    if (has(/^(-d|--delete|--mirror|--prune|-f|--force|--force-with-lease.*|\+.*|:.*)$/)) return { cls: "delete", what: said };
  }
  // Deletion through a service's own client.
  if ((p === "gh" || p === "glab") && (has(/^delete$/) || method === "DELETE")) return { cls: "delete", what: said };
  if (HTTP_CLIENTS.has(p) && method === "DELETE") return { cls: "delete", what: said };
  if (p === "aws" && has(/^(rm|rb|delete-.*|terminate-instances)$/)) return { cls: "delete", what: said };
  if ((p === "gsutil" || p === "gcloud") && has(/^(rm|delete)$/)) return { cls: "delete", what: said };
  if ((p === "kubectl" || p === "helm") && /^(delete|uninstall)$/.test(verb)) return { cls: "delete", what: said };
  if ((p === "docker" || p === "podman") && (/^(rm|rmi)$/.test(verb) || has(/^prune$/) || (has(/^(volume|network|image|container)$/) && has(/^rm$/)))) return { cls: "delete", what: said };
  if (/^(dropdb|dropuser)$/.test(p)) return { cls: "delete", what: said };
  if (/^(psql|mysql|sqlite3|mongosh|redis-cli|valkey-cli)$/.test(p) && SQL_DROPS.test(line)) return { cls: "delete", what: said };
  // A write to a service: a request with a method or a body of its own (gh api's fields), or a raw connection.
  if ((HTTP_CLIENTS.has(p) || ((p === "gh" || p === "glab") && verb === "api")) && method && method !== "GET" && method !== "HEAD") return { cls: "authority", what: `writes to a service (${said})` };
  if (RAW_CLIENTS.has(p)) return { cls: "authority", what: `opens a raw connection (${said})` };
  // Keel's own command line: every command of it acts on Keel itself (its sessions, rules, settings and daemon).
  if (p === "keel") return { cls: "authority", what: `Keel's own command line (${said})` };
  return null;
}

// --- Keel's own API ------------------------------------------------------------------

// The routes of Keel's API that change what runs or what is allowed, or speak in a session: on any host (the
// daemon may be reached by a name of the network too).
const KEEL_API = /\/api\/(hooks|mcp|helper|settings|permissions|rules|grants|sandbox|approvals|secrets|vault|plugins|skills|agents|automation|config|ownfile)\b|\/api\/sessions\/[^/\s'"?]+\/(prompt|messages|permissions|steer|queue|approvals|settings)\b/;
// An address with its scheme, anywhere in a text: its host and port.
const ADDRESS = /\b([a-z][a-z0-9+.-]*):\/\/([^\s/'"?#\\]+)/gi;
// An HTTP client's options whose value is a file of its own, not where it sends.
const CLIENT_FILES = /^(-o|--output|--output-dir|-D|--dump-header|-c|--cookie-jar|--stderr|--trace|--trace-ascii|-O|--output-document|-a|--append-output)$/;
const hostPort = (authority: string): { host: string; port?: number } => {
  const at = authority.lastIndexOf("@");
  const hp = at >= 0 ? authority.slice(at + 1) : authority;
  const v6 = /^\[([^\]]*)\](?::(\d+))?$/.exec(hp);
  if (v6) return { host: v6[1]!, ...(v6[2] ? { port: Number(v6[2]) } : {}) };
  const k = hp.lastIndexOf(":");
  return k >= 0 && /^\d+$/.test(hp.slice(k + 1)) ? { host: hp.slice(0, k), port: Number(hp.slice(k + 1)) } : { host: hp };
};
// A host on this machine or a private network, or one of the daemon's own ports: Keel's API may answer there.
const reachesHere = (h: { host: string; port?: number }) => (h.host !== "" && privateHost(h.host)) || (h.port !== undefined && keelPorts.has(h.port));
// The daemon's own listeners (the network proxy's list; a test gives its own and puts it back).
export const keelPorts: { has: (port: number) => boolean } = { has: isOwnPort };

// How a text may reach Keel's own API, in words, or null: one of its routes named, an address on this machine or a
// private network, one of the daemon's ports, or (in a command) a request whose address an expansion makes.
export function keelReach(text: string, command = false): string | null {
  const api = KEEL_API.exec(text);
  if (api) return `it names Keel's own API (${api[0]})`;
  for (const m of text.matchAll(ADDRESS)) {
    if (m[1]!.toLowerCase() === "file") continue;
    const h = hostPort(m[2]!);
    if (reachesHere(h)) return `it reaches an address on this machine or a private network (${m[0].slice(0, 120)}), where Keel's API may answer`;
  }
  for (const m of text.matchAll(/(?<![\w.])(?::)?(\d{2,5})(?![\w.])/g)) if (keelPorts.has(Number(m[1]))) return `it names Keel's own port ${m[1]}`;
  if (!command) return null;
  for (const { s, run, at } of partsOf(text) ?? []) {
    const p = base(run[0] ?? "");
    if (!HTTP_CLIENTS.has(p) && !RAW_CLIENTS.has(p)) continue;
    const dyn = new Set(s.dyn ?? []);
    for (let k = 1; k < run.length; k++) {
      const a = run[k]!;
      if (CLIENT_FILES.test(a)) { k++; continue; }
      if (dyn.has(at + k)) return `${p} sends to an address an expansion makes (${run.join(" ").slice(0, 120)})`;
      if (/^(-K|--config)(=|$)/.test(a)) return `${p} reads its options from a file the card does not show`;
      if (a.startsWith("-") || a.includes("://")) continue;
      // A bare address (curl 127.0.0.1:8080/api, nc host 80): a word of a host's characters with a dot or a port,
      // or any word a raw client is given.
      const authority = a.split("/")[0]!;
      if (/^[\w.\-[\]:]+$/.test(authority) && (/[.:]/.test(authority) || RAW_CLIENTS.has(p)) && reachesHere(hostPort(authority))) return `${p} reaches an address on this machine or a private network (${a.slice(0, 120)})`;
    }
  }
  return null;
}

// Deletions in a database's own words.
const SQL_DROPS = /\b(drop\s+(table|database|schema|index|view|user|role|collection)|truncate\b|delete\s+from|alter\s+table\s+\S+\s+drop|flushall|flushdb|dropDatabase|dropCollection|deleteMany)\b/i;

// The method a request sends, upper case: the one an option names, POST for a body (curl's data, wget's post data,
// httpie's items, gh api's fields); undefined when nothing says.
function methodOf(p: string, args: string[]): string | undefined {
  let m: string | undefined;
  let body = false;
  const gh = p === "gh" || p === "glab";
  const httpie = /^(http|https|xh|xhs|httpie|curlie)$/.test(p);
  for (let k = 0; k < args.length; k++) {
    const a = args[k]!;
    if (/^(-X|--request|--method)$/.test(a)) { m = (args[k + 1] ?? "").toUpperCase(); k++; continue; }
    const glued = /^(?:-X|--request=|--method=)(\w+)$/.exec(a);
    if (glued) { m = glued[1]!.toUpperCase(); continue; }
    if (gh && (/^(-f|-F|--field|--raw-field|--input)$/.test(a) || /^(-f|-F)./.test(a) || /^--(field|raw-field|input)=/.test(a))) body = true;
    if (p === "curl" && (/^(-d|--data.*|-F|--form.*|-T|--upload-file|--json)$/.test(a) || /^(-d|-F|-T)./.test(a) || /^--(data|form|json|upload-file)[-=]/.test(a))) body = true;
    if (p === "wget" && /^--(post-data|post-file|body-data|body-file)(=|$)/.test(a)) body = true;
    // httpie's method word and items (key=value, key:=json, key@file, @file).
    if (httpie && /^(POST|PUT|PATCH|DELETE)$/.test(a)) m = a;
    if (httpie && !a.startsWith("-") && /^[^=:@/]+(==?|:=|@)|^@/.test(a) && !/^[^=]*==/.test(a) && !/^[a-z]+:\/\//i.test(a)) body = true;
  }
  return m ?? (body ? "POST" : undefined);
}

// --- code the card does not show ------------------------------------------------------

// Programs that run a file or code they are given, and the forms of them that run none.
const RUNS_CODE = /^(sh|bash|zsh|dash|ksh|fish|ash|mksh|python[0-9.]*|pypy[0-9.]*|node|nodejs|perl|ruby|php|lua(jit)?|Rscript|tsx|ts-node|esno|jiti|vite-node|osascript|pwsh|powershell|tclsh|julia|elixir|escript|guile|racket|runghc|runhaskell|groovy|expect|awk|gawk|mawk|nawk|eval|source|\.)$/;
const ASKS_ONLY = /^(--version|-V|-v|--help|-h|version|help)$/;
// python3 -m: the modules that run nothing of the project's but what they say.
const PY_MODULES = /^(pip|pip3|venv|ensurepip|pytest|py_compile|compileall|json\.tool)$/;
// A file of code by its name.
const SCRIPT_FILE = /\.(sh|bash|zsh|fish|ksh|py|pyw|js|mjs|cjs|ts|mts|cts|tsx|jsx|rb|pl|pm|php|lua|r|ps1|bat|cmd|tcl|exs?|jl|kts|groovy)$/i;
// A program named by a path: the system's own folders hold programs, anything else a script of the project.
const SYSTEM_BIN = /^\/(usr\/(local\/)?)?s?bin\/[^/]+$|^\/opt\/homebrew\/bin\/[^/]+$/;
// Build tools that run the recipes of a file the card does not show.
const RECIPES = /^(make|gmake|bmake|just|task|go-task|rake|mage|invoke|inv|nox|tox|ninja|scons|waf)$/;
// The package managers' own commands; any other word runs a script of the package (yarn build, pnpm dev).
const PNPM_OWN = /^(add|install|i|update|up|upgrade|remove|rm|un|uninstall|link|ln|unlink|import|rebuild|rb|prune|fetch|patch|patch-commit|audit|list|ls|outdated|why|licenses|publish|pack|init|store|config|c|root|bin|env|setup|doctor|cache|dedupe|approve-builds|self-update|help|login|logout|whoami|info|view|owner|tag|set|plugin|constraints|npm|global|check|autoclean|version|deploy)$/;
const NPM_SCRIPT = /^(run|run-script|rum|urn|exec|x|start|test|t|tst|stop|restart|explore|install-test|it|cit|install-ci-test)$/;
const BUN_OWN = /^(install|i|add|a|remove|rm|update|outdated|pm|build|test|init|link|unlink|upgrade|publish|patch|audit|info|why)$/;
const DENO_OWN = /^(fmt|lint|check|test|doc|info|upgrade|add|remove|compile|cache|types|bench|publish)$/;
// git's own commands: any other word is an alias or a program of the machine, which the card does not show.
const GIT_OWN = new Set(("add am annotate apply archive bisect blame branch bundle checkout cherry cherry-pick citool clean clone commit config count-objects describe diff difftool fetch format-patch fsck gc grep help init log ls-files ls-remote ls-tree maintenance merge merge-base mergetool mv notes pull push range-diff rebase reflog remote repack replace request-pull reset restore revert rev-list rev-parse rm shortlog show show-branch show-ref sparse-checkout stash status submodule switch tag worktree cat-file hash-object read-tree update-index update-ref write-tree symbolic-ref for-each-ref name-rev var verify-commit verify-tag whatchanged check-ignore check-attr check-ref-format checkout-index commit-tree diff-files diff-index diff-tree merge-file mktag mktree pack-objects prune prune-packed unpack-objects fast-export fast-import interpret-trailers column").split(" "));
// Programs whose first word says what they do.
const SUBCOMMANDS = /^(npm|pnpm|yarn|bun|deno|git|gh|glab|docker|podman|nerdctl|kubectl|helm|aws|gcloud|az|terraform|tofu|pulumi|cargo|go|uv|poetry|pip|pip3|keel|systemctl|brew|apt|apt-get|dnf|snap|flatpak|vastai|runpodctl|hcloud|doctl|wrangler|vercel|netlify|firebase|flyctl|fly|heroku|dotnet|gem|twine|hatch)$/;
// git's options before its command, and the ones that take the next word.
const GIT_VALUED = /^(-C|--git-dir|--work-tree|--namespace|--super-prefix|--list-cmds)$/;

// What of the line runs code the card does not show, in words, or null. Read by the gate's own parser; a line it
// cannot read, a part it cannot account for, or a program or a command word an expansion makes is not shown either.
export function hiddenCode(line: string): string | null {
  const parts = partsOf(line);
  if (!parts) return "the rules cannot split the command into what it runs";
  for (const { s, run, at, deep } of parts) {
    // (A here-document's lines run only through the command they feed, which is read itself.)
    if (s.heredoc) continue;
    if (s.unknown) return `the rules cannot read part of it (${s.text.slice(0, 120)})`;
    if (deep) return "it starts its program through more wrappers than the rules read";
    if (!run.length) continue;
    const said = run.join(" ").slice(0, 160);
    const dyn = new Set(s.dyn ?? []);
    if (dyn.has(at)) return `its program comes from an expansion (${said})`;
    const first = run[0]!;
    const p = base(first);
    const args = run.slice(1);
    // The command word of a program that has commands: an expansion there says nothing of what it does.
    const verbAt = args.findIndex((a) => !a.startsWith("-"));
    if (SUBCOMMANDS.test(p) && verbAt >= 0 && dyn.has(at + 1 + verbAt)) return `what it does comes from an expansion (${said})`;
    if ((first.includes("/") && !SYSTEM_BIN.test(first)) || SCRIPT_FILE.test(first)) return `it runs a script the card does not show (${said})`;
    if (args.length && args.every((a) => ASKS_ONLY.test(a))) continue;
    if (RUNS_CODE.test(p)) {
      if (/^python/.test(p) && args[0] === "-m" && PY_MODULES.test(args[1] ?? "")) continue;
      return args.length ? `${p} runs code it is given (${said})` : `${p} runs what it reads from its input (${said})`;
    }
    if (p === "bun" && !BUN_OWN.test(args[0] ?? "")) return `bun runs a file or a package script (${said})`;
    if (p === "deno" && !DENO_OWN.test(args[0] ?? "")) return `deno runs code (${said})`;
    if (RECIPES.test(p)) return `${p} runs recipes the card does not show (${said})`;
    if (p === "npm" && NPM_SCRIPT.test(verbOf(args))) return `npm runs a package script (${said})`;
    if ((p === "pnpm" || p === "yarn") && args.length && !PNPM_OWN.test(verbOf(args))) return `${p} runs a package script (${said})`;
    if (p === "git") {
      const g = gitCommand(args);
      if (g.config) return `git runs with configuration given for this call, which can name a program (${said})`;
      if (g.verb && !GIT_OWN.has(g.verb)) return `"git ${g.verb}" is not git's own command: an alias or another program (${said})`;
    }
    if ((p === "docker" || p === "podman" || p === "nerdctl") && /^(run|exec|build|buildx|start|create)$/.test(args[0] ?? "")) return `${p} runs an image's code (${said})`;
    if ((p === "docker" || p === "podman") && args[0] === "compose" && args.some((a) => /^(up|run|exec|build|start|restart|create)$/.test(a))) return `${p} compose runs images' code (${said})`;
    if ((p === "go" || p === "cargo" || p === "dotnet" || p === "swift" || p === "zig") && /^(run|script|generate)$/.test(args[0] ?? "")) return `${p} ${args[0]} runs the project's code (${said})`;
  }
  return null;
}

// The first word of a package manager's arguments that is not an option or an option's value.
function verbOf(args: string[]): string {
  for (let k = 0; k < args.length; k++) {
    const a = args[k]!;
    if (/^(--prefix|-C|--dir|--filter|-F|-w|--workspace|--cwd)$/.test(a)) { k++; continue; }
    if (!a.startsWith("-")) return a;
  }
  return "";
}
function gitCommand(args: string[]): { verb?: string; config?: true } {
  for (let k = 0; k < args.length; k++) {
    const a = args[k]!;
    if (a === "-c" || a.startsWith("--config-env") || a.startsWith("--exec-path=")) return { config: true };
    if (GIT_VALUED.test(a)) { k++; continue; }
    if (a.startsWith("-")) continue;
    return { verb: a };
  }
  return {};
}

// What the strings of a tool's input say, for a call the gate does not read as a command: each string read as a
// command line, a database's deletions, and code handed to a tool that runs commands.
const RUNS_WORDS = /(^|[^a-z])(shell|exec|execute|command|terminal|bash|script|eval|run_code|run_command|repl)([^a-z]|$)/i;
export function valuesClass(tool: string, input: unknown): Hit {
  const runs = RUNS_WORDS.test(tool) || (tool === "mcp_call" && RUNS_WORDS.test(String((input as { tool?: unknown } | undefined)?.tool ?? "")));
  for (const v of stringsOf(input)) {
    if (SQL_DROPS.test(v)) return { cls: "delete", what: `${tool}: ${v.slice(0, 160)}` };
    const hit = shellClass(v);
    if (hit) return hit;
    const reach = keelReach(v, runs);
    if (reach) return { cls: "authority", what: reach };
    if (runs) {
      const hidden = hiddenCode(v);
      if (hidden) return { cls: "unseen", what: hidden };
    }
  }
  return null;
}
// Every string in a value, deep (the first STRINGS_MAX of them).
const STRINGS_MAX = 500;
export function stringsOf(v: unknown, out: string[] = []): string[] {
  if (out.length >= STRINGS_MAX) return out;
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) stringsOf(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) stringsOf(x, out);
  return out;
}

// --- other tools -----------------------------------------------------------------

// A tool's name split into its words (an MCP call is named by the tool it calls), lower case.
export function toolWords(tool: string, input: unknown): string[] {
  const inner = tool === "mcp_call" && input && typeof input === "object" ? String((input as { tool?: unknown }).tool ?? "") : "";
  return `${tool} ${inner}`.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}
const SPEND_WORDS = new Set(["purchase", "buy", "checkout", "pay", "payment", "payments", "charge", "subscribe", "subscription", "rent", "rental", "order", "topup", "billing"]);
const RENTED = new Set(["instance", "instances", "pod", "pods", "vm", "vms", "droplet", "cluster", "gpu", "gpus", "machine", "machines", "server", "servers"]);
const PUBLISH_WORDS = new Set(["publish", "unpublish", "release", "deploy", "tweet", "broadcast"]);
const DELETE_WORDS = new Set(["delete", "remove", "destroy", "drop", "purge", "erase", "wipe", "terminate", "trash", "unlink", "rm", "rmdir"]);
const AUTHORITY_WORDS = new Set(["permission", "permissions", "grant", "revoke", "token", "tokens", "credential", "credentials", "secret", "secrets", "sandbox", "role", "roles", "acl", "policy", "policies", "invite", "collaborator", "collaborators"]);

export function toolClass(words: string[]): Hit {
  const what = words.join(" ");
  if (words.some((w) => SPEND_WORDS.has(w))) return { cls: "spend", what };
  if (words.some((w) => /^(create|launch|start|run|provision|scale)$/.test(w)) && words.some((w) => RENTED.has(w))) return { cls: "spend", what };
  if (words.some((w) => DELETE_WORDS.has(w))) return { cls: "delete", what };
  if (words.some((w) => PUBLISH_WORDS.has(w))) return { cls: "publish", what };
  if (words.some((w) => AUTHORITY_WORDS.has(w)) && !words.some((w) => /^(get|list|read|search|show|view|describe)$/.test(w))) return { cls: "authority", what };
  return null;
}

// --- the allow-list -----------------------------------------------------------------

// What this machine's disk says of a session's paths, for the list. `localPlace` reads the disk; a test may give its own.
// `workspace`: the session's folder where its links lead. `far`: its calls run on another machine. `cache`: the cache
// folder a clone may go to. `real`: a path where its links lead. `exec`: an existing file someone may execute.
// `branch`: a local branch of the repository a folder is in. `exists`: a path names a file or a folder.
export type Place = {
  workspace: string; far?: boolean; cache?: string; home: string;
  real(p: string): string; exec(p: string): boolean; branch(cwd: string, name: string): boolean; exists(p: string): boolean;
};

export function localPlace(workspace: string, far = false): Place {
  const home = homeDir();
  const cache = process.env.XDG_CACHE_HOME && process.env.XDG_CACHE_HOME.startsWith("/") ? process.env.XDG_CACHE_HOME : join(home, ".cache");
  return {
    workspace: far ? workspace : realOf(workspace), far, cache: realOf(cache), home,
    real: realOf,
    exec: (p) => { try { const st = statSync(p); return st.isFile() && (st.mode & 0o111) !== 0; } catch { return false; } },
    branch: localBranch,
    exists: existsSync,
  };
}

// Whether `name` is a local branch of the repository `cwd` is in: its ref file or its line in packed-refs.
export function localBranch(cwd: string, name: string): boolean {
  if (!/^[A-Za-z0-9._/-]+$/.test(name) || name.startsWith("-") || name.startsWith("/") || name.endsWith("/") || name.includes("..") || name.includes("//") || name.endsWith(".lock") || name === "HEAD") return false;
  try {
    let d = realOf(cwd);
    let gitdir: string | undefined;
    for (;;) {
      const g = join(d, ".git");
      if (existsSync(g)) {
        gitdir = statSync(g).isDirectory() ? g : resolve(d, /^gitdir:\s*(.+)$/m.exec(readFileSync(g, "utf8"))?.[1]?.trim() ?? "");
        break;
      }
      const up = dirname(d);
      if (up === d) return false;
      d = up;
    }
    const common = existsSync(join(gitdir, "commondir")) ? resolve(gitdir, readFileSync(join(gitdir, "commondir"), "utf8").trim()) : gitdir;
    const ref = join(common, "refs", "heads", name);
    if (existsSync(ref) && statSync(ref).isFile()) return true;
    const packed = join(common, "packed-refs");
    return existsSync(packed) && readFileSync(packed, "utf8").split("\n").some((l) => l.endsWith(` refs/heads/${name}`));
  } catch { return false; }
}

const off = (cls: OwnerClass, what: string): Hit => ({ cls, what });
const unseen = (what: string): Hit => off("unseen", what);

// Null: the card is on the list. Else why it is not, with the class that names it.
export function offList(a: CardIn, place?: Place): Hit {
  if (!place) return unseen("the session's folder is not known, so nothing can be shown to stay in it");
  if (place.far) return off("authority", "it runs on another machine");
  if (a.kind === "shell") return shellOffList(a.summary, a.at, place);
  if (a.kind === "edit") return editOffList(a, place);
  if (a.kind === "other" && a.facts?.read_hint) return null;
  return unseen(`${a.tool} is not among the tools whose whole effect a card shows`);
}

// --- files a runner reads as code

// Folders whose files something runs or reads as instructions: hooks, CI, Keel's and agents' own, editors' tasks,
// installed packages and environments, test folders a runner collects whole.
const CODE_DIRS = new Set([".git", ".github", ".gitlab", ".circleci", ".buildkite", ".husky", ".githooks", ".keel", ".claude", ".codex", ".cursor", ".gemini", ".opencode",
  ".vscode", ".idea", ".devcontainer", ".cargo", ".config", ".direnv", "node_modules", ".venv", "venv", "site-packages", "dist-packages", "__tests__", ".yarn", ".pnpm-store"]);
// Files a runner, a build, a package manager, a shell or an agent reads as code or as instructions by their name.
const CODE_NAMES = new RegExp("^(" + [
  "conftest\\.py", "test_.*\\.py", ".*_test\\.[a-z0-9]+", ".*\\.(test|spec|e2e|bench)\\.[a-z0-9]+", "pytest\\.ini", "tox\\.ini", "noxfile\\.py", "setup\\.(py|cfg)", "pyproject\\.toml",
  "sitecustomize\\.py", "usercustomize\\.py", ".*\\.pth", "manage\\.py",
  "(GNU)?[Mm]akefile", ".*\\.mk", "[Jj]ustfile", "\\.justfile", "Taskfile\\.ya?ml", "Rakefile", "Gemfile", ".*\\.gemspec", "magefile\\.go", "build\\.rs", "Cargo\\.toml", "go\\.mod", "go\\.work",
  "CMakeLists\\.txt", ".*\\.cmake", "meson\\.build", "BUILD(\\.bazel)?", "WORKSPACE(\\.bazel)?", "MODULE\\.bazel", ".*\\.bzl", "build\\.gradle(\\.kts)?", "settings\\.gradle(\\.kts)?", "gradlew(\\.bat)?", "pom\\.xml",
  "package\\.json", "deno\\.jsonc?", "bunfig\\.toml", "\\.npmrc", "\\.yarnrc(\\.ya?ml)?", "\\.pnpmfile\\.c?js", ".*\\.config\\.[cm]?[jt]s", "\\..*rc\\.[cm]?[jt]s", "Gruntfile\\.[jt]s", "[Gg]ulpfile\\.[jt]s",
  "Dockerfile.*", ".*\\.dockerfile", "Containerfile.*", "(docker-)?compose(\\..*)?\\.ya?ml", "Jenkinsfile", "\\.gitlab-ci\\.ya?ml", "\\.travis\\.ya?ml", "azure-pipelines\\.ya?ml", "\\.pre-commit-config\\.ya?ml",
  "\\.gitattributes", "\\.gitmodules", "\\.envrc", "\\.env(\\..*)?", "\\.(bash|zsh|profile|bash_profile|zprofile|zshenv|bashrc|zshrc|inputrc)", ".*\\.(sh|bash|zsh|fish|ps1|bat|cmd)",
  "AGENTS\\.md", "CLAUDE\\.md", "GEMINI\\.md", "\\.mcp\\.json", "\\.cursorrules",
].join("|") + ")$");

// Why a path (relative to the session's folder) is a file a runner reads as code, or null.
export function codeFile(rel: string): string | null {
  const parts = rel.split("/").filter((p) => p && p !== ".");
  const dir = parts.slice(0, -1).find((p) => CODE_DIRS.has(p)) ?? (parts.length && CODE_DIRS.has(parts[parts.length - 1]!) ? parts[parts.length - 1] : undefined);
  if (dir) return `a file under ${dir}/`;
  const name = parts[parts.length - 1] ?? "";
  return CODE_NAMES.test(name) ? name : null;
}

// A path a command or an edit writes, judged where its links lead: in the session's folder, not a runner's code,
// not an executable file.
function writeOffList(path: string, place: Place, who: string): Hit {
  const real = place.real(path);
  if (!contains(place.workspace, real)) return off("authority", `${who} writes outside the session's folder (${path})`);
  const code = codeFile(relative(place.workspace, real)) ?? codeFile(basename(path));
  if (code) return unseen(`${who} writes ${code}, which a runner reads as code`);
  if (place.exec(real)) return unseen(`${who} writes an executable file (${path})`);
  return null;
}

// A path as a command gives it, absolute: `~` is the home folder; `~user` is not read.
function pathAt(cwd: string, p: string, place: Place): string | null {
  if (p === "~" || p.startsWith("~/")) return join(place.home, p.slice(1));
  if (p.startsWith("~")) return null;
  return resolve(cwd, p);
}

// --- edits

function editOffList(a: CardIn, place: Place): Hit {
  // The gate's card of an edit names its files as absolute paths, one a line.
  const paths = a.summary.split("\n").map((p) => p.trim()).filter(Boolean);
  if (!paths.length) return unseen("the edit names no file");
  for (const p of paths) {
    if (!p.startsWith("/")) return unseen(`the edit names a path the rules cannot place (${p})`);
    const hit = writeOffList(p, place, "the edit");
    if (hit) return hit;
  }
  const text = stringsOf(a.input).join("\n");
  if (/^(\*\*\* Delete File:|deleted file mode)/m.test(text)) return off("delete", "the edit deletes a file");
  if (/^(new file mode|new mode|old mode) \d*7[0-7][0-7]\b|^(new file mode|new mode) 1007/m.test(text) || /^(new file mode|new mode) 12/m.test(text)) return unseen("the edit makes a file executable or a link");
  if (/(^|\n)\+?#!/.test(text)) return unseen("the edit writes a script line (#!), which makes it a program");
  return null;
}

// --- commands

// The programs that only read and show, and the options of them that run code or write a file.
const READS = new Set(["ls", "cat", "head", "tail", "grep", "egrep", "fgrep", "rg", "find", "wc", "sort", "diff", "stat", "file", "jq"]);
const FIND_ACTS = /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/;

function shellOffList(line: string, at: CardIn["at"], place: Place): Hit {
  if (at?.shell) return unseen(`it runs in ${at.shell}, which the rules do not read as bash`);
  if (at?.away) return off("authority", "it runs outside the session's folder");
  const cwd = at?.cwd ? place.real(at.cwd) : place.workspace;
  if (!contains(place.workspace, cwd)) return off("authority", "it runs outside the session's folder");
  const parts = partsOf(line);
  if (!parts) return unseen("the rules cannot split the command into what it runs");
  let any = false;
  for (const { s, run, pre, deep } of parts) {
    // (A here-document's lines run only through the command they feed, which is judged itself.)
    if (s.heredoc) continue;
    if (s.unknown) return unseen(`the rules cannot read part of it (${s.text.slice(0, 120)})`);
    if (deep || pre.length) return unseen(`it runs a program through a wrapper or with variables set before it (${s.text.slice(0, 120)})`);
    if (s.redirects) return unseen(`it writes through a redirect (${s.text.slice(0, 120)})`);
    if (s.dyn?.length) return unseen(`a word of it comes from an expansion or a pattern (${s.text.slice(0, 120)})`);
    if (!run.length) continue;
    any = true;
    const hit = partOffList(run, cwd, place);
    if (hit) return hit;
  }
  return any ? null : unseen("it runs nothing of the list");
}

const SYSTEM_PROGRAM = /^\/(usr\/(local\/)?)?s?bin\/[^/]+$/;

function partOffList(run: string[], cwd: string, place: Place): Hit {
  const first = run[0]!;
  if (first.includes("/") && !SYSTEM_PROGRAM.test(first)) return unseen(`it runs a program of a path (${first})`);
  const p = base(first);
  const args = run.slice(1);
  const said = run.join(" ").slice(0, 160);
  const has = (re: RegExp) => args.some((a) => re.test(a));
  const short = (letters: string) => args.some((a) => /^-[A-Za-z0-9]+$/.test(a) && [...letters].some((l) => a.includes(l)));
  if (READS.has(p)) {
    if (p === "find" && has(FIND_ACTS)) return unseen(`find runs a program or writes or deletes files (${said})`);
    if (p === "rg" && has(/^--(pre|pre-glob|hostname-bin)(=|$)/)) return unseen(`rg runs a program it is given (${said})`);
    if (p === "sort" && (short("o") || has(/^--(output|compress-program)(=|$)/))) return unseen(`sort writes a file or runs a program (${said})`);
    if (p === "file" && (short("C") || has(/^--compile$/))) return unseen(`file writes a compiled magic file (${said})`);
    return null;
  }
  if (p === "sed") return sedOffList(args, cwd, place, said);
  if (/^(awk|gawk|mawk|nawk)$/.test(p)) return awkOffList(p, args, said);
  if (p === "git") return gitOffList(args, cwd, place, said);
  if (p === "curl" || p === "wget") return fetchOffList(p, args, cwd, place, said);
  if (p === "mkdir" || p === "cp" || p === "mv") return moveOffList(p, args, cwd, place, said);
  return unseen(`${p} is not among the programs whose whole effect a card shows`);
}

// --- sed

function sedOffList(args: string[], cwd: string, place: Place, said: string): Hit {
  const scripts: string[] = [];
  const operands: string[] = [];
  let inPlace = false;
  let dd = false;
  for (let k = 0; k < args.length; k++) {
    const a = args[k]!;
    if (dd || a === "-" || !a.startsWith("-")) { operands.push(a); continue; }
    if (a === "--") { dd = true; continue; }
    if (a.startsWith("--")) {
      if (/^--in-place(=|$)/.test(a)) inPlace = true;
      else if (a === "--expression") scripts.push(args[++k] ?? "");
      else if (a.startsWith("--expression=")) scripts.push(a.slice("--expression=".length));
      else if (!/^--(quiet|silent|regexp-extended|separate|unbuffered|null-data|zero-terminated|posix|sandbox|debug|follow-symlinks|binary|line-length=\d+)$/.test(a)) return unseen(`sed's option ${a} is not on the list (${said})`);
      continue;
    }
    for (let j = 1; j < a.length; j++) {
      const c = a[j]!;
      if ("nrEsuzb".includes(c)) continue;
      if (c === "i") { inPlace = true; break; }
      if (c === "e") { const rest = a.slice(j + 1); scripts.push(rest || (args[++k] ?? "")); break; }
      if (c === "l") { if (!a.slice(j + 1)) k++; break; }
      return unseen(c === "f" ? `sed reads its script from a file the card does not show (${said})` : `sed's option -${c} is not on the list (${said})`);
    }
  }
  if (!scripts.length) { if (!operands.length) return unseen(`sed is given no script (${said})`); scripts.push(operands.shift()!); }
  for (const s of scripts) {
    const bad = sedRuns(s);
    if (bad) return unseen(`sed ${bad} (${said})`);
  }
  if (inPlace) for (const f of operands) {
    if (f === "-") continue;
    const path = pathAt(cwd, f, place);
    if (!path) return unseen(`sed writes a path the rules cannot place (${f})`);
    const hit = writeOffList(path, place, "sed -i");
    if (hit) return hit;
  }
  return null;
}

// What of a sed script runs a command or writes a file (the e and w commands, s's e and w flags), in words, or null.
// A script the scanner cannot read is not read as safe.
export function sedRuns(s: string): string | null {
  const n = s.length;
  let i = 0;
  const spaces = () => { while (i < n && (s[i] === " " || s[i] === "\t")) i++; };
  // Past a delimited part that starts at s[i] (the delimiter); false when it does not end.
  const part = (d: string): boolean => {
    i++;
    while (i < n && s[i] !== d) { if (s[i] === "\\") i++; else if (s[i] === "\n" && d !== "\n") return false; i++; }
    if (i >= n) return false;
    i++;
    return true;
  };
  const toLine = () => { while (i < n && s[i] !== "\n") { if (s[i] === "\\") i++; i++; } };
  while (i < n) {
    const c = s[i]!;
    if (c === " " || c === "\t" || c === "\n" || c === ";" || c === "}") { i++; continue; }
    if (c === "#") { toLine(); continue; }
    // An address: numbers, $, /re/ or \cREc with I and M, first~step, addr,+n, then !.
    for (;;) {
      if (/[0-9]/.test(s[i] ?? "")) { while (/[0-9~]/.test(s[i] ?? "")) i++; }
      else if (s[i] === "$") i++;
      else if (s[i] === "/") { if (!part("/")) return "has a pattern the rules cannot read"; while (s[i] === "I" || s[i] === "M") i++; }
      else if (s[i] === "\\") { i++; const d = s[i]; if (!d || d === "\n") return "has a pattern the rules cannot read"; if (!part(d)) return "has a pattern the rules cannot read"; while (s[i] === "I" || s[i] === "M") i++; }
      else break;
      spaces();
      if (s[i] === ",") { i++; spaces(); if (s[i] === "+" || s[i] === "~") i++; continue; }
      break;
    }
    spaces();
    if (s[i] === "!") { i++; spaces(); }
    const cmd = s[i];
    i++;
    if (cmd === undefined) break;
    if (cmd === "{" || "=dDgGhHnNpPxzF".includes(cmd)) continue;
    if (cmd === "s" || cmd === "y") {
      const d = s[i];
      if (!d || d === "\n" || d === "\\") return "has a command the rules cannot read";
      if (!part(d)) return "has a command the rules cannot read";
      i--;
      if (!part(d)) return "has a command the rules cannot read";
      if (cmd === "s") while (i < n && /[gpiImMew0-9]/.test(s[i]!)) {
        if (s[i] === "e") return "runs the result of a substitution as a command (the e flag)";
        if (s[i] === "w") return "writes a file (the w flag)";
        i++;
      }
      continue;
    }
    if ("aic".includes(cmd) || cmd === "r" || cmd === "R") { toLine(); continue; }
    if (cmd === "e") return "runs a command (the e command)";
    if (cmd === "w" || cmd === "W") return "writes a file (the w command)";
    if ("btT:v".includes(cmd)) { while (i < n && s[i] !== "\n" && (cmd === ":" || s[i] !== ";")) i++; continue; }
    if ("qQlL".includes(cmd)) { spaces(); while (/[0-9]/.test(s[i] ?? "")) i++; continue; }
    return `has a command the rules cannot read (${cmd})`;
  }
  return null;
}

// --- awk

// An awk program runs a command through system(), a pipe or a coprocess, writes a file through > or >>, and opens a
// connection through gawk's /inet files. Those
// characters and words are not read apart from where they mean something else (a comparison), so a program that holds
// any of them is the owner's. A program from a file, an extension or an include is not shown.
function awkOffList(p: string, args: string[], said: string): Hit {
  const programs: string[] = [];
  const operands: string[] = [];
  let dd = false;
  for (let k = 0; k < args.length; k++) {
    const a = args[k]!;
    if (dd || a === "-" || !a.startsWith("-")) { operands.push(a); continue; }
    if (a === "--") { dd = true; continue; }
    if (a === "-F" || a === "-v" || a === "--field-separator" || a === "--assign") { k++; continue; }
    if (/^-[Fv]./.test(a) || /^--(field-separator|assign)=/.test(a)) continue;
    if (a === "-e" || a === "--source") { programs.push(args[++k] ?? ""); continue; }
    if (a.startsWith("--source=")) { programs.push(a.slice("--source=".length)); continue; }
    if (/^(-b|-c|-P|-S|-M|-N|--characters-as-bytes|--traditional|--posix|--sandbox|--bignum|--use-lc-numeric)$/.test(a)) continue;
    return unseen(`${p}'s option ${a} is not on the list: it reads a program file, loads an extension or writes a file (${said})`);
  }
  if (!programs.length) { if (!operands.length) return unseen(`${p} is given no program (${said})`); programs.push(operands.shift()!); }
  for (const prog of programs) if (/[|>@]|\bsystem\b|\bPROCINFO\b|\/inet/.test(prog)) return unseen(`${p} may run a command or write a file (${said})`);
  return null;
}

// --- git

function gitOffList(args: string[], cwd: string, place: Place, said: string): Hit {
  let repo = cwd;
  let k = 0;
  for (; k < args.length; k++) {
    const a = args[k]!;
    if (a === "-C") {
      const d = args[++k];
      const at = d === undefined ? null : pathAt(repo, d, place);
      if (!at) return unseen(`git -C names a folder the rules cannot place (${said})`);
      repo = place.real(at);
      if (!contains(place.workspace, repo)) return off("authority", `git works in a folder outside the session's (${said})`);
      continue;
    }
    if (/^(--no-pager|--no-optional-locks|-P|--literal-pathspecs|--no-replace-objects|--glob-pathspecs|--noglob-pathspecs|--icase-pathspecs|--no-advice)$/.test(a)) continue;
    if (a.startsWith("-")) return unseen(`git's option ${a} can change what it runs or where (${said})`);
    break;
  }
  const verb = args[k] ?? "";
  const rest = args.slice(k + 1);
  const opts = rest.filter((a) => a.startsWith("-"));
  const words = rest.filter((a) => !a.startsWith("-"));
  const only = (re: RegExp) => opts.find((a) => !re.test(a));
  const bad = (what: string) => unseen(`git ${verb} ${what} (${said})`);
  switch (verb) {
    case "add":
      // (--chmod marks a file executable in what is committed.)
      return rest.some((a) => a.startsWith("--chmod")) ? bad("marks a file executable") : null;
    case "status": case "commit":
      return null;
    case "log": case "show": case "diff":
      if (rest.some((a) => /^--(output|ext-diff|textconv)(=|$)/.test(a))) return bad("writes a file or runs a diff program");
      return null;
    case "branch": {
      const o = only(/^(-a|--all|-r|--remotes|-l|--list|-v|-vv|--verbose|--show-current|--contains|--no-contains|--merged|--no-merged|--points-at|--sort(=.*)?|--format(=.*)?|--color(=.*)?|--no-color|--column(=.*)?|--no-column|-i|--ignore-case|--abbrev(=.*)?|--no-abbrev|-q|--quiet|-t|--track(=.*)?|--no-track)$/);
      return o ? bad(`with ${o} deletes, moves, copies or forces a branch, or opens an editor`) : null;
    }
    case "fetch": {
      const o = only(/^(--all|--prune|-p|--tags|-t|--no-tags|-n|--depth=\d+|--deepen=\d+|--unshallow|-q|--quiet|-v|--verbose|--progress|--dry-run|--multiple|--jobs=\d+|-j\d+|--no-recurse-submodules|--filter=.*|--atomic|--no-write-fetch-head)$/);
      if (o) return bad(`with ${o} is not on the list`);
      const w = words.find((a) => a.includes("::") || a.includes(":") && !/^[a-z]+:\/\//i.test(a) && !/^[\w.-]+@[\w.-]+:/.test(a) || a.startsWith("+"));
      return w ? bad(`with ${w} forces a ref, names a transport or writes a local ref`) : null;
    }
    case "clone": return cloneOffList(rest, repo, place, said);
    case "switch": {
      const o = only(/^(-c|--create|-d|--detach|--guess|--no-guess|-q|--quiet|-t|--track(=.*)?|--no-track|--progress|--no-progress)$/);
      if (o) return bad(`with ${o} forces, discards or merges changes`);
      return words.length >= 1 && words.length <= 2 ? null : bad("names more than a branch and its start");
    }
    case "checkout": {
      const o = only(/^(-b|-q|--quiet|-t|--track(=.*)?|--no-track|--progress|--no-progress|--detach|--guess|--no-guess)$/);
      if (o) return bad(`with ${o} forces, resets or restores files`);
      if (opts.includes("-b")) return words.length >= 1 && words.length <= 2 && !rest.includes("--") ? null : bad("names more than a new branch and its start");
      // A word that is not a local branch is a path: checkout puts the file back as committed, losing its changes.
      if (words.length !== 1) return bad("names files or more than one branch");
      const b = words[0]!;
      if (!place.branch(repo, b)) return bad(`names ${b}, which is not a local branch: checkout would restore files`);
      if (place.exists(resolve(repo, b))) return bad(`names ${b}, which is a local branch and a path too`);
      return null;
    }
    case "stash": {
      const sub = words[0];
      if (sub === undefined || /^(push|save|list|show|apply|pop)$/.test(sub)) return null;
      return bad(sub === "drop" || sub === "clear" ? "deletes stashed work" : `${sub} is not on the list`);
    }
    case "push": return off("authority", `git push changes a repository on another machine (${said})`);
    default: return unseen(`git ${verb} is not among git's commands whose whole effect a card shows (${said})`);
  }
}

function cloneOffList(rest: string[], cwd: string, place: Place, said: string): Hit {
  const words: string[] = [];
  for (let k = 0; k < rest.length; k++) {
    const a = rest[k]!;
    if (/^(-b|--branch|-o|--origin|--depth)$/.test(a)) { k++; continue; }
    if (/^(-q|--quiet|-v|--verbose|--progress|--depth=\d+|--shallow-since=.*|--single-branch|--no-single-branch|--no-tags|--branch=.*|--origin=.*|--filter=.*|--sparse|-n|--no-checkout|--bare)$/.test(a)) continue;
    if (a.startsWith("-")) return unseen(`git clone with ${a} is not on the list: it can run a program, a template's hooks or write elsewhere (${said})`);
    words.push(a);
  }
  const [url, dir] = words;
  if (!url || words.length > 2) return unseen(`git clone is given no source or more than a source and a folder (${said})`);
  if (url.includes("::")) return unseen(`git clone names a transport that runs a program (${url})`);
  const name = dir ?? basename(url.replace(/\/+$/, "").replace(/\.git$/, "").replace(/^.*:/, ""));
  const target = name ? pathAt(cwd, name, place) : null;
  if (!target) return unseen(`git clone writes a folder the rules cannot place (${said})`);
  const real = place.real(target);
  if (!contains(place.workspace, real) && !(place.cache && contains(place.cache, real))) return off("authority", `git clone writes outside the session's folder and the cache (${target})`);
  const code = contains(place.workspace, real) ? codeFile(relative(place.workspace, real)) : null;
  return code ? unseen(`git clone writes ${code}, which a runner reads as code`) : null;
}

// --- curl and wget

const LOCAL_NAMES = /(^|\.)(local|localdomain|internal|intranet|lan|home|corp|home\.arpa|localhost)\.?$/i;

function fetchOffList(p: "curl" | "wget", args: string[], cwd: string, place: Place, said: string): Hit {
  const urls: string[] = [];
  const writes: string[] = [];
  let named = false;
  let noRedirect = p === "curl";
  let prefix: string | undefined;
  // Options with no value, and those with one, for each; any other is the owner's.
  const FLAGS = p === "curl"
    ? /^--(silent|show-error|fail|fail-with-body|head|include|verbose|compressed|remote-name|no-progress-meter|progress-bar|http1\.0|http1\.1|http2|ipv4|ipv6|globoff|no-buffer|get)$/
    : /^--(quiet|no-verbose|server-response|spider|continue|timestamping|no-clobber|inet4-only|inet6-only|no-cache)$/;
  const VALUED = p === "curl"
    ? /^--(output|header|user-agent|referer|max-time|connect-timeout|retry|retry-delay|retry-max-time|range|request|max-filesize|limit-rate|url)$/
    : /^--(output-document|timeout|tries|header|user-agent|directory-prefix|max-redirect|wait)$/;
  const SHORT_FLAGS = p === "curl" ? "sSfIivk#46Og" : "qSc46N";
  const SHORT_VALUED = p === "curl" ? "oHAemrX" : "OTtUP";
  const take = (opt: string, v: string | undefined): Hit => {
    if (v === undefined) return unseen(`${p} ${opt} has no value (${said})`);
    if (/^(-X|--request)$/.test(opt) && !/^(GET|HEAD)$/i.test(v)) return off("authority", `${p} sends a ${v.toUpperCase()} request, which writes to a service (${said})`);
    if (/^(-o|--output|-O|--output-document)$/.test(opt) && v !== "-") writes.push(v);
    if (/^(-P|--directory-prefix)$/.test(opt)) prefix = v;
    if (opt === "--max-redirect") noRedirect = v === "0";
    if (opt === "--url") urls.push(v);
    return null;
  };
  let dd = false;
  for (let k = 0; k < args.length; k++) {
    const a = args[k]!;
    if (dd || !a.startsWith("-") || a === "-") { urls.push(a); continue; }
    if (a === "--") { dd = true; continue; }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const opt = eq >= 0 ? a.slice(0, eq) : a;
      if (FLAGS.test(opt) && eq < 0) { if (opt === "--remote-name") named = true; continue; }
      if (VALUED.test(opt)) { const hit = take(opt, eq >= 0 ? a.slice(eq + 1) : args[++k]); if (hit) return hit; continue; }
      if (/^--(location|location-trusted)$/.test(opt)) return unseen(`${p} follows redirects to addresses the card does not show (${said})`);
      return unseen(`${p}'s option ${opt} is not on the list: it may send a body, credentials or a file, read options from a file, or connect elsewhere (${said})`);
    }
    for (let j = 1; j < a.length; j++) {
      const c = a[j]!;
      if (SHORT_FLAGS.includes(c)) { if (c === "O" && p === "curl") named = true; continue; }
      if (SHORT_VALUED.includes(c)) { const v = a.slice(j + 1); const hit = take(`-${c}`, v || args[++k]); if (hit) return hit; break; }
      if (c === "L" && p === "curl") return unseen(`curl follows redirects to addresses the card does not show (${said})`);
      return unseen(`${p}'s option -${c} is not on the list: it may send a body, credentials or a file, read options from a file, or connect elsewhere (${said})`);
    }
  }
  if (!noRedirect) return unseen(`wget follows redirects to addresses the card does not show unless --max-redirect=0 (${said})`);
  if (!urls.length) return unseen(`${p} is given no address (${said})`);
  for (const raw of urls) {
    let u: URL;
    try { u = new URL(raw); } catch { return unseen(`${p} is given an address the rules cannot read (${raw})`); }
    if (!/^https?:$/.test(u.protocol) || !raw.toLowerCase().startsWith(u.protocol)) return unseen(`${p} is given an address that is not http or https (${raw})`);
    if (/[{}[\]]/.test(u.pathname + u.search)) return unseen(`${p} is given an address with a pattern (${raw})`);
    const host = u.hostname.replace(/^\[|\]$/g, "");
    if (privateHost(host) || LOCAL_NAMES.test(host) || (u.port && keelPorts.has(Number(u.port)))) return off("authority", `${p} reaches a host on this machine or a private network (${raw})`);
    if (p === "wget" && !writes.length) writes.push(join(prefix ?? ".", basename(u.pathname) || "index.html"));
    if (p === "curl" && named) writes.push(basename(u.pathname) || "");
  }
  for (const w of writes) {
    if (!w) return unseen(`${p} writes a file the address does not name (${said})`);
    const path = pathAt(cwd, w, place);
    if (!path) return unseen(`${p} writes a path the rules cannot place (${w})`);
    const hit = writeOffList(path, place, p);
    if (hit) return hit;
  }
  return null;
}

// --- mkdir, cp and mv

function moveOffList(p: "mkdir" | "cp" | "mv", args: string[], cwd: string, place: Place, said: string): Hit {
  const ops: string[] = [];
  let target: string | undefined;
  let dd = false;
  const LONG = p === "mkdir" ? /^--(parents|verbose)$/ : p === "cp"
    ? /^--(recursive|archive|preserve(=[a-z,]+)?|verbose|no-clobber|update(=[a-z]+)?|force|parents|no-target-directory|dereference|no-dereference|remove-destination)$/
    : /^--(force|no-clobber|verbose|update(=[a-z]+)?|no-target-directory)$/;
  const SHORT = p === "mkdir" ? "pv" : p === "cp" ? "rRapvnfuLPdHTx" : "fnvuT";
  for (let k = 0; k < args.length; k++) {
    const a = args[k]!;
    if (dd || !a.startsWith("-") || a === "-") { ops.push(a); continue; }
    if (a === "--") { dd = true; continue; }
    if (a.startsWith("--")) {
      if (p !== "mkdir" && /^--target-directory(=|$)/.test(a)) { target = a.includes("=") ? a.slice(a.indexOf("=") + 1) : args[++k]; continue; }
      if (p === "mkdir" && /^--mode(=|$)/.test(a)) { if (!a.includes("=")) k++; continue; }
      if (LONG.test(a)) continue;
      return unseen(`${p}'s option ${a} is not on the list (${said})`);
    }
    for (let j = 1; j < a.length; j++) {
      const c = a[j]!;
      if (SHORT.includes(c)) continue;
      if ((c === "t" && p !== "mkdir") || (c === "m" && p === "mkdir")) { const v = a.slice(j + 1) || args[++k]; if (c === "t") target = v; break; }
      return unseen(`${p}'s option -${c} is not on the list (${said})`);
    }
  }
  if (target !== undefined) ops.push(target);
  if (!ops.length || (p !== "mkdir" && ops.length < 2)) return unseen(`${p} is given no path, or no source and destination (${said})`);
  const abs: string[] = [];
  for (const o of ops) {
    const at = pathAt(cwd, o, place);
    if (!at) return unseen(`${p} names a path the rules cannot place (${o})`);
    if (!contains(place.workspace, place.real(at))) return off("authority", `${p} reaches outside the session's folder (${o})`);
    abs.push(at);
  }
  if (p === "mkdir") return null;
  // What lands at the destination: the destination itself, or each source by its name inside it.
  const dest = abs[abs.length - 1]!;
  for (const src of abs.slice(0, -1)) for (const at of [dest, join(dest, basename(src))]) {
    const hit = writeOffList(at, place, p);
    if (hit) return hit;
  }
  return null;
}

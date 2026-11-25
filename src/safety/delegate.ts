// Which approval cards the owner's helper may answer for him, decided here in
// code from the gate's own facts, never from the helper's words.
//
// The owner can let the helper answer other sessions' approval cards on his
// standing instruction (Settings > Helper > Answer approvals, on by default):
// allow what they ask unless it is really risky. Some cards never go to the
// helper and stay his, whatever the helper says: `ownerClass` names the class.
// The helper's judgement applies only to what is left.
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
//   in part), so nobody but the owner can stand behind an allow.
//
// Pure: the card as stored in, a class or null out (delegate.test.ts).
import { name as base, unwrap, type RiskRule } from "./risk-words.ts";
import { splitCommand, type Simple } from "./shell.ts";
import { isOwnPort } from "./net-proxy.ts";
import { privateHost } from "../core/hosts.ts";

// What made a one-call card (gate.ts askOnce): outside content named the target, a tool that confirms
// each call, private words in a public place, a hook of the owner's that asks.
export type Held = "provenance" | "confirm" | "words" | "hook";
// What the gate knew of why it asked, kept with the card (gate.ts card()).
// `owner_only`: the policy's onlyOwner. `account`: a write with the owner's account beyond his namespaces.
// `risks`: the classes of what makes a command high risk (risk-words.ts). `held`: a one-call card and what made it.
export type CardFacts = { owner_only?: true; account?: string; risks?: RiskRule[]; held?: Held };

export type OwnerClass = "provenance" | "owner-only" | "spend" | "publish" | "delete" | "authority" | "unseen" | "helper";
export const CLASS_WORDS: Record<OwnerClass, string> = {
  provenance: "outside content named its target first",
  "owner-only": "only the owner allows it",
  spend: "it spends money or rents machines",
  publish: "it publishes something that cannot be taken back",
  delete: "it deletes something that cannot be brought back",
  authority: "it changes what may run on the machine or what the rules allow",
  unseen: "the card does not hold the whole request",
  helper: "it is the helper's own call",
};

// The card as the class is read from: what the gate stored.
export type CardIn = {
  tool: string; kind: string; summary: string; input: unknown; risk: "high" | "low";
  rule?: string; why?: string; once?: boolean; autoOwner?: boolean; cut?: boolean; input_len?: number; mine?: string;
  facts?: CardFacts;
};

// The rule words the policy gives what leaves the sandbox, reads credentials or is Keel's own (policy.ts).
const AUTHORITY_RULES = [/asks to leave the sandbox/, /reads credentials/, /Keel's own configuration/, /runs later, outside the sandbox/, /credential store/, /outside what the sandbox shows/, /runs as root/i, /acts in another session/];

// One class for a card, or null: the helper may judge it. What the helper cannot see in the card is the owner's:
// code the card does not show (a script, a package's script, an alias, code handed to an interpreter) is `unseen`.
export function ownerClass(a: CardIn, isHelperSession = false): { cls: OwnerClass; why: string } | null {
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
    const hidden = hiddenCode(a.summary);
    if (hidden) return say("unseen", hidden);
    if (risks.has("hidden")) return say("unseen", a.why);
  } else {
    // (An edit's strings are a file's text, which runs nothing by being written: the gate's rules judge where it lands.)
    const hit = toolClass(toolWords(a.tool, a.input)) ?? (a.kind === "edit" ? null : valuesClass(a.tool, a.input));
    if (hit) return say(hit.cls, hit.what);
  }
  if (risks.has("destroys")) return say("delete", a.why);
  // A change on another machine or a service (its deletions and the files there that run later are among it),
  // credentials sent out, a reach past the session on this machine.
  if (risks.has("remote") || risks.has("exposes") || risks.has("machine")) return say("authority", a.why);
  return null;
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
  const verb = args.find((a) => !a.startsWith("-")) ?? "";
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

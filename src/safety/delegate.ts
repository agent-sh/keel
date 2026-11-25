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
import type { RiskRule } from "./risk-words.ts";

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

// One class for a card, or null: the helper may judge it.
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
  // What the command or the tool says it does names the class first; the rules' risk classes after it.
  const text = a.kind === "shell" ? a.summary : "";
  const hit = (text && shellClass(text)) || toolClass(toolWords(a.tool, a.input));
  if (hit) return say(hit.cls, hit.what);
  const risks = new Set(f.risks ?? []);
  if (risks.has("destroys")) return say("delete", a.why);
  // A change on another machine or a service (its deletions and the files there that run later are among it),
  // credentials sent out, a reach past the session on this machine.
  if (risks.has("remote") || risks.has("exposes") || risks.has("machine")) return say("authority", a.why);
  return null;
}

const isClipped = (v: unknown) => !!v && typeof v === "object" && "_clipped" in (v as object);

// --- commands ------------------------------------------------------------------

// The simple commands of a line, each as its words (quotes taken off). A rough split: the gate's own
// reading already judged the line; this only names a class among what it let ask.
export function simpleCommands(line: string): string[][] {
  return line.split(/\|\||&&|[;|&\n]|\$\(|`|\(|\)/).map((part) => part.trim().split(/\s+/).map((w) => w.replace(/^['"]+|['"]+$/g, "")).filter(Boolean)).filter((w) => w.length);
}

// The program a part runs past assignments and the wrappers that only start it.
const WRAPPERS = new Set(["env", "nice", "nohup", "time", "timeout", "command", "exec", "xargs", "stdbuf", "ionice", "chrt", "npx", "bunx", "uvx", "pnpx"]);
function programOf(words: string[]): { p: string; args: string[] } | null {
  let i = 0;
  while (i < words.length) {
    const w = words[i]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) { i++; continue; }
    const base = w.slice(w.lastIndexOf("/") + 1);
    if (WRAPPERS.has(base)) { i++; while (i < words.length && /^-/.test(words[i]!)) i++; if (base === "timeout" && /^\d/.test(words[i] ?? "")) i++; continue; }
    return { p: base, args: words.slice(i + 1) };
  }
  return null;
}

const ROOT = new Set(["sudo", "doas", "pkexec", "su", "run0"]);
const MACHINE = new Set(["systemctl", "loginctl", "crontab", "launchctl", "chsh", "passwd", "usermod", "useradd", "userdel", "groupadd", "visudo", "ufw", "iptables", "ip6tables", "nft", "modprobe", "insmod", "mount", "umount", "swapon", "sysctl", "update-alternatives", "ssh-add", "ssh-copy-id"]);
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

type Hit = { cls: OwnerClass; what: string } | null;

// The class of a command line the gate asked about, or null.
export function shellClass(line: string): Hit {
  for (const words of simpleCommands(line)) {
    const x = programOf(words);
    if (!x) continue;
    const { p, args } = x;
    const said = words.join(" ").slice(0, 160);
    const has = (re: RegExp) => args.some((a) => re.test(a));
    const verb = args.find((a) => !a.startsWith("-")) ?? "";
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
    if ((p === "docker" || p === "podman" || p === "buildah" || p === "skopeo") && /^(push|copy)$/.test(verb)) return { cls: "publish", what: said };
    if (p === "dotnet" && has(/^push$/) && has(/^nuget$/)) return { cls: "publish", what: said };
    if ((p === "gh" || p === "glab") && /^release$/.test(verb) && has(/^(create|upload|edit|delete)$/)) return { cls: "publish", what: said };
    if ((p === "gh" || p === "glab") && verb === "repo" && has(/^(delete|archive|rename|transfer)$/)) return { cls: "delete", what: said };
    if ((p === "gh" || p === "glab") && verb === "repo" && has(/^--visibility(=public)?$|^--public$/)) return { cls: "publish", what: said };
    if (/^(wrangler|vercel|netlify|firebase|flyctl|fly|railway|heroku|surge)$/.test(p) && has(/^(deploy|publish|--prod|release)$/)) return { cls: "publish", what: said };
    if (p === "git" && verb === "push") {
      if (has(/^--tags$|^--follow-tags$|^refs\/tags\//) || args.some((a, k) => k > 0 && /^v?\d+\.\d+/.test(a))) return { cls: "publish", what: said };
      if (has(/^(-d|--delete|--mirror|--prune|-f|--force|--force-with-lease.*|\+.*|:.*)$/)) return { cls: "delete", what: said };
    }
    // Deletion through a service's own client.
    if ((p === "gh" || p === "glab") && (has(/^delete$/) || args.some((a, k) => (/^(-X|--method)$/.test(args[k - 1] ?? "") && /^delete$/i.test(a)) || /^--method=delete$/i.test(a)))) return { cls: "delete", what: said };
    if (p === "curl" && args.some((a, k) => (/^(-X|--request)$/.test(args[k - 1] ?? "") && /^delete$/i.test(a)) || /^-XDELETE$/i.test(a))) return { cls: "delete", what: said };
    if (p === "aws" && has(/^(rm|rb|delete-.*|terminate-instances)$/)) return { cls: "delete", what: said };
    if ((p === "gsutil" || p === "gcloud") && has(/^(rm|delete)$/)) return { cls: "delete", what: said };
    if ((p === "kubectl" || p === "helm") && /^(delete|uninstall)$/.test(verb)) return { cls: "delete", what: said };
    if ((p === "docker" || p === "podman") && (/^(rm|rmi)$/.test(verb) || has(/^prune$/) || (has(/^(volume|network|image|container)$/) && has(/^rm$/)))) return { cls: "delete", what: said };
    if (/^(dropdb|dropuser)$/.test(p)) return { cls: "delete", what: said };
    if (/^(psql|mysql|sqlite3|mongosh|redis-cli|valkey-cli)$/.test(p) && /\b(drop\s+(table|database|schema)|truncate\b|delete\s+from|flushall|flushdb|dropDatabase)\b/i.test(line)) return { cls: "delete", what: said };
    // Keel's own permissions and settings, through its command line or its API.
    if (p === "keel" && /^(perm|permissions|rules|grant|mode|settings|sandbox|config)$/.test(verb)) return { cls: "authority", what: said };
    if ((p === "curl" || p === "wget" || p === "http" || p === "xh") && /\/api\/(sessions\/[^/\s]+\/)?(permissions|rules|grants|settings|sandbox|approvals)\b/.test(said)) return { cls: "authority", what: said };
  }
  return null;
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

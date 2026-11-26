// The risk classes that reach past this machine (risk.ts): `remote`, a
// change on another machine or a service that nothing here undoes, and
// `exposes`, a file that holds credentials handed to something that sends
// it. With them, what a database client drops or empties.
import { CRED_PATH } from "./autonomy.ts";
import { INTERPRETERS, SHELLS, literal, name, shellGiven, target, untrailed, written, type Risk, type Run, type Values, type Where } from "./risk-words.ts";
import type { Made, Simple } from "./shell.ts";

// One part of the line, as the classes read it. `made(k)`: what is known of argument k when an expansion makes it.
export type Part = { s: Simple; run: Run; p: string; args: string[]; plain: string[]; dir: string | null; i: number; made: (k: number) => Made | undefined };

export const REMOTE_SPEC = /^[A-Za-z0-9_.@-]+:(?!\/\/)/;
export const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?|0\.0\.0\.0)(:\d+)?$/i;
const dry = (args: string[]) => args.some((a) => /^--dry-?run($|=(?!none|false))/.test(a) || a === "--dryrun");

// ---- another machine's shell ----

const SSH_VALUED = /^-[bcDEeFIiJLlMmOoPpQRSWw]$/; // ssh's, and autossh's -M
// The command a program runs somewhere else, and where: null when it runs none.
// `argv`: the command is run as the words it is, with no shell there to read them again (kubectl and docker exec).
export function elsewhere(x: Part): { host: string; command: string[]; argv?: true } | null {
  const { p, args } = x;
  if (p === "ssh" || p === "autossh") {
    let i = 0;
    for (; i < args.length && args[i]!.startsWith("-"); i++) { if (args[i] === "--") { i++; break; } if (SSH_VALUED.test(args[i]!)) i++; }
    if (args[i] === undefined) return null;
    const command = args.slice(i + 1);
    if (command[0] === "--") command.shift();
    return { host: args[i]!, command };
  }
  // mosh HOST -- CMD, pdsh -w HOSTS CMD, gcloud compute ssh VM --command CMD, ansible PATTERN -a CMD: the same.
  if (p === "mosh" || p === "pdsh") {
    let i = 0, host = p === "pdsh" ? args.find((_, k) => args[k - 1] === "-w") : undefined;
    for (; i < args.length && args[i]!.startsWith("-"); i++) { if (args[i] === "--") { i++; break; } if (p === "pdsh" ? /^-[wgxltufR]$/.test(args[i]!) : /^(-p|--port|--ssh|--predict|--family|--bind-server|--server|--client)$/.test(args[i]!)) i++; }
    if (p === "mosh") { host = args[i]; i++; if (args[i] === "--") i++; }
    return host === undefined ? null : { host, command: args.slice(i) };
  }
  if (p === "gcloud" && x.plain[0] === "compute" && x.plain[1] === "ssh") {
    const k = args.indexOf("--command"), given = k >= 0 ? args[k + 1] : args.find((a) => a.startsWith("--command="))?.slice(10);
    return { host: x.plain[2] ?? "a cloud machine", command: given === undefined ? [] : [given] };
  }
  if (p === "ansible") {
    const k = args.findIndex((a) => a === "-a" || a === "--args"), mod = args[args.findIndex((a) => a === "-m" || a === "--module-name") + 1];
    return k < 0 || args[k + 1] === undefined || (args.includes("-m") && !/^(shell|command|raw|script)$/.test(mod ?? "")) ? null : { host: x.plain[0] ?? "other machines", command: [args[k + 1]!] };
  }
  // kubectl exec POD -- CMD, docker exec CONTAINER CMD: what runs is in a container, not here.
  if ((p === "kubectl" || p === "oc") && x.plain[0] === "exec") {
    const dd = args.indexOf("--");
    return { host: "a cluster's container", command: dd < 0 ? [] : args.slice(dd + 1), argv: true };
  }
  // (Also `docker compose exec SERVICE CMD`, and docker-compose's.)
  const compose = p === "docker-compose" || ((p === "docker" || p === "podman") && x.plain[0] === "compose");
  if (((p === "docker" || p === "podman") && x.plain[0] === "exec") || (compose && args.includes("exec") && !args.includes("run"))) {
    let i = args.indexOf("exec") + 1;
    for (; i < args.length && args[i]!.startsWith("-"); i++) if (/^(-e|--env|-u|--user|-w|--workdir|--env-file|--detach-keys|--index)$/.test(args[i]!)) i++;
    return args[i] === undefined ? null : { host: `the container ${args[i]}`, command: args.slice(i + 1), argv: true };
  }
  return null;
}

// ---- databases ----

const SQL = /^(psql|mysql|mariadb|sqlite3|sqlcmd|clickhouse-client|clickhouse|duckdb|cockroach|snowsql|mongosh|mongo|redis-cli|cqlsh|turso|pg_restore)$/;
const FILE_DB = /^(sqlite3|duckdb)$/;
export const sqlClient = (p: string) => SQL.test(p);

// A statement that drops or empties what a database holds: DDL, and DELETE or UPDATE with no WHERE.
export function sqlLoss(text: string): string | null {
  for (const st of text.split(";")) {
    if (/\bDROP\s+(DATABASE|SCHEMA|TABLE|VIEW|INDEX|ROLE|USER|KEYSPACE|COLLECTION|TRIGGER|FUNCTION)\b/i.test(st)) return "drops";
    if (/\bTRUNCATE\b/i.test(st) || /\bFLUSH(ALL|DB)\b/i.test(st)) return "empties";
    if (/\bALTER\s+TABLE\b/i.test(st) && /\bDROP\b/i.test(st)) return "drops";
    if ((/\bDELETE\s+FROM\b/i.test(st) || (/\bUPDATE\b/i.test(st) && /\bSET\b/i.test(st))) && !/\bWHERE\b/i.test(st)) return "changes every row of";
    if (/\.(drop|dropDatabase|deleteMany|remove)\s*\(/.test(st)) return "drops";
  }
  return null;
}

// Where a database command goes, as far as the line says: a host written as
// this machine, a test or development target the line names, a host written
// that is not this machine, or nothing written (it may be a remote through
// the environment).
const TEST_ENV = /^(RAILS_ENV|NODE_ENV|APP_ENV|RACK_ENV|DJANGO_ENV|FLASK_ENV|ENV|ENVIRONMENT)=(test|testing|development|dev|local|ci)$/;
const hostOf = (url: string) => /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:?#]+|\[[^\]]+\])/i.exec(url)?.[1] ?? null;
const TEST_SETTINGS = /(^|[._=])(test|tests|testing|dev|development|local|ci)([._]|$)/;
function goes(x: Part, w: Where): "here" | "there" | "unsaid" {
  const { args, run } = x;
  const hosts: string[] = [];
  let test = run.set.some((kv) => TEST_ENV.test(kv) || (kv.startsWith("DJANGO_SETTINGS_MODULE=") && TEST_SETTINGS.test(kv.slice(23))));
  for (const kv of run.set) { const m = /^(PGHOST|MYSQL_HOST|REDIS_HOST|DATABASE_URL|REDIS_URL|MONGODB_URI|PGDATABASE)=(.*)$/.exec(kv); if (m) { if (m[1] === "PGDATABASE") test ||= /_(test|dev)$/.test(m[2]!); else hosts.push(hostOf(m[2]!) ?? m[2]!); } }
  args.forEach((a, k) => {
    const prev = args[k - 1] ?? "";
    if (/^(-h|--host|--hostname)$/.test(prev) && !a.startsWith("-")) hosts.push(a);
    else if (/^--(host|hostname)=/.test(a)) hosts.push(a.slice(a.indexOf("=") + 1));
    else if (/^-h./.test(a) && !a.startsWith("--") && x.p !== "pg_restore") hosts.push(a.slice(2));
    else if (hostOf(a)) hosts.push(hostOf(a)!);
    else if (/^host=/.test(a)) hosts.push(a.slice(5).split(/\s/)[0]!);
    if ((/^(--env|-e|--environment)$/.test(prev) && /^(test|testing|development|dev|local)$/.test(a)) || /^--(env|environment)=(test|testing|development|dev|local)$/.test(a)) test = true;
    // A database named for tests or development.
    if (!a.startsWith("-") && /^([A-Za-z0-9_.-]+_)?(test|dev|development)$/.test(a)) test = true;
    // A settings module named for tests (manage.py flush --settings=app.settings.test).
    if (/^--settings=/.test(a) ? TEST_SETTINGS.test(a.slice(11)) : prev === "--settings" && TEST_SETTINGS.test(a)) test = true;
  });
  // mongosh's own first word is where it connects when it holds a dot, a colon or a slash (host/db, host:port);
  // a plain word is a database's name.
  const mongo = /^(mongosh|mongo)$/.test(x.p);
  if (mongo) {
    const at = args.find((a, k) => !a.startsWith("-") && !/^(--eval|-f|--file|-u|--username|-p|--password|--authenticationDatabase|--host|--port|--apiVersion)$/.test(args[k - 1] ?? ""));
    if (at && /[.:\/]/.test(at) && !hostOf(at)) hosts.push(at.split(/[:\/]/)[0]!);
  }
  // On another machine "local" is that machine: only a test target the line names lowers anything there.
  if (w.away) return test ? "here" : "there";
  if (/--protocol=socket/i.test(args.join(" "))) hosts.push("localhost");
  if (hosts.some((h) => !LOCAL_HOST.test(h) && !h.startsWith("/"))) return "there";
  // A client whose host only its own options name is this machine's when they name none; so is the stack
  // `supabase db reset` runs here unless it is told the linked one.
  // (Not when a word of theirs is an expansion, or a -u or --uri names where they go: that is not read here.)
  const told = args.some((a, k) => x.made(k) !== undefined || /^(--uri|--uri=.*)$/.test(a) || (x.p === "redis-cli" && a === "-u"));
  const own = ((x.p === "redis-cli" || mongo) && !told) || (x.p === "supabase" && !args.some((a) => /^--(linked|db-url)/.test(a)));
  return hosts.length || test || own ? "here" : "unsaid";
}

// What a database client loses: nothing when the line says it is this machine's own or a test one; high risk on a
// host the line names; and when it names none, high risk as a loss here (a remote is not written).
function database(x: Part, fed: { text: string; piped: boolean }, w: Where, vals: Values): Risk[] {
  const { p, args, plain } = x;
  const where = goes(x, w);
  const lost = (what: string): Risk[] => (where === "here" ? [] : [{ rule: where === "there" ? "remote" : "destroys", why: `${what}${where === "unsaid" ? ", on a host the command does not name" : ""}` }]);
  if (SQL.test(p)) {
    const loss = sqlLoss(`${args.join(" ")};${fed.text}`);
    if (FILE_DB.test(p)) {
      if (!loss) return [];
      // A database in a file: nothing is lost in memory, in a file git ignores, or in one it can bring back.
      const file = plain.find((a) => !/\s/.test(a) && !sqlLoss(a));
      if (file === undefined || file === ":memory:" || file === "") return [];
      const t = target(file, x.made(args.indexOf(file)), x.dir, w, vals, x.i);
      if (!("place" in t)) return [{ rule: "destroys", why: `${loss} a table of a database the command does not spell out (${file})` }];
      if (t.place === "scratch" || t.place === "cache") return [];
      const kept = t.place === "inside" ? w.looked?.kept([literal(t.path)]) : undefined;
      if (kept === undefined || kept === null ? /(^|[-_.\/])(test|tests|tmp|temp|dev|scratch|example|sample|fixture)s?([-_.\/]|$)/i.test(t.shown) : kept !== "late" && kept.n === 0) return [];
      return [{ rule: "destroys", why: `${loss} a table of ${t.shown}${kept === "late" ? ", and git did not say in time whether it can bring the file back" : ""}` }];
    }
    if (loss) return lost(`${loss} a table or a database (${p})`);
    // Statements from a file or from another command's output are not in the command to read.
    const file = p === "pg_restore" ? (args.some((a) => /^(-c|--clean)$/.test(a)) ? "a dump, dropping what it restores over" : null)
      : args.find((a, k) => /^(-f|--file|-i|--input-file)$/.test(args[k - 1] ?? "") || /^--file=/.test(a)) ?? x.s.inputs?.[0] ?? (fed.piped ? "another command's output" : null);
    if (!file) return [];
    // A file of statements the disk can show is read like statements in the command.
    const at = file === x.s.inputs?.[0] || args.includes(file) ? target(file, undefined, x.dir, w, vals, x.i) : null;
    const text = at && "path" in at && !at.glob ? w.looked?.read(at.path) : undefined;
    if (typeof text === "string") { const does = sqlLoss(text); return does ? lost(`${does} a table or a database (${p}, from ${file.slice(0, 80)})`) : []; }
    return lost(`runs statements the command does not show (${file.slice(0, 80)}) against a database (${p})`);
  }
  if (p === "dropdb" || p === "dropuser" || (p === "mysqladmin" && plain.includes("drop"))) return lost(`drops a database (${p})`);
  if (p === "mongorestore" && args.includes("--drop")) return lost("drops each collection before it restores it (mongorestore --drop)");
  // The migration tools' own ways to take a schema down to nothing.
  const has = (...ws: string[]) => ws.every((v) => plain.includes(v));
  const drops = (p === "alembic" && has("downgrade", "base")) || (p === "knex" && plain.includes("migrate:rollback") && args.includes("--all")) || (p === "flyway" && plain.includes("clean"))
    || (p === "liquibase" && plain.some((a) => /^(dropAll|drop-all)$/.test(a))) || (/^(sequelize|sequelize-cli)$/.test(p) && plain.includes("db:drop")) || (/^typeorm/.test(p) && plain.includes("schema:drop"))
    || (p === "drizzle-kit" && plain[0] === "drop") || (p === "dotnet" && has("ef", "database", "drop")) || (p === "django-admin" && plain.some((a) => /^(flush|sqlflush|reset_db)$/.test(a)))
    || (p === "goose" && (plain.includes("reset") || (plain.includes("down-to") && plain[plain.indexOf("down-to") + 1] === "0"))) || (p === "dbmate" && plain.includes("drop"))
    || (p === "diesel" && has("database", "reset")) || (p === "sqlx" && plain.includes("database") && plain.some((a) => /^(drop|reset)$/.test(a)));
  if (drops) return lost(`drops or resets a database (${p} ${plain.slice(0, 3).join(" ")})`);
  if (/^(prisma|rails|rake|artisan|manage\.py|supabase|drizzle-kit)$/.test(p) || (INTERPRETERS.test(p) && /(^|\/)(manage\.py|artisan)$/.test(plain[0] ?? ""))) {
    if (plain.some((a) => /^(db:drop|db:reset|db:wipe|db:schema:load|migrate:fresh|migrate:reset|flush|sqlflush|reset_db)$/.test(a)) || (plain.includes("reset") && plain.some((a) => /^(migrate|db)$/.test(a))) || args.includes("--force-reset"))
      return lost("resets a database: what it holds is dropped");
  }
  return [];
}

// ---- class: remote ----

// Verbs that delete in the clients of clusters, clouds and hosted services.
const SERVICE = new Set(["aws", "gcloud", "gsutil", "bq", "az", "doctl", "flyctl", "fly", "heroku", "vercel", "netlify", "wrangler", "supabase", "firebase", "railway", "render", "hcloud", "linode-cli", "oci",
  "ibmcloud", "scw", "turso", "neonctl", "neon", "influx", "planetscale", "pscale", "gh", "glab", "kubectl", "oc", "helm", "vault", "consul", "etcdctl", "nomad", "argocd", "pulumi", "cdk", "serverless", "sls", "sam", "amplify"]);
const GONE = /^(delete|destroy|terminate|remove|rm|rb|purge|drop|uninstall|deregister|teardown|drain|wipe)$|^(delete|terminate|destroy|remove|purge|deregister)-|:(destroy|delete|reset|remove|drop)$/;
// What puts something where others take it from, by program and the words after it.
const PUBLISH: [RegExp, RegExp][] = [
  [/^(npm|pnpm|yarn|bun|cargo|poetry|flit|hatch|uv|vsce|ovsx|jsr|deno|lerna|changeset|amplify)$/, /^(publish|unpublish|deprecate|yank|dist-tag|owner|access)$/],
  [/^(twine)$/, /^upload$/], [/^(gem|helm|docker|podman|nuget)$/, /^(push|yank)$/], [/^(ssh-copy-id)$/, /^/], [/^(mvn|mvnw)$/, /^(deploy|release:perform)$/], [/^(gradle|gradlew)$/, /^publish/],
  [/^(goreleaser)$/, /^release$/], [/^(semantic-release|release-it|np|surge)$/, /^/], [/^(vercel|netlify|fly|flyctl|wrangler|firebase|serverless|sls|sam|cdk|gcloud|heroku|railway|render|cap|kamal)$/, /^(deploy|publish|promote|container:release)$/],
];
const NAMED_DEPLOY = /(^|[^a-z0-9])(deploy|publish)([^a-z0-9]|$)/i;
// A script named for what it does to what runs on another machine.
const NAMED_DOWN = /(^|[^a-z0-9])(restart|rollback|teardown|destroy|shutdown)([^a-z0-9]|$)/i;
export const deployNamed = (word: string, away = false) => NAMED_DEPLOY.test(name(word)) || (away && NAMED_DOWN.test(name(word)));
// The programs this file has a rule for: a part that runs none of them is not looked at here.
export const REACHES = new Set([...SERVICE, "ssh", "terraform", "tofu", "terragrunt", "docker", "podman", "docker-compose", "dropdb", "dropuser", "mysqladmin", "prisma", "rails", "rake", "artisan", "manage.py",
  "drizzle-kit", "mongorestore", "alembic", "knex", "flyway", "liquibase", "sequelize", "sequelize-cli", "typeorm", "typeorm-ts-node-commonjs", "typeorm-ts-node-esm", "dotnet", "django-admin", "goose", "dbmate", "diesel", "sqlx",
  "pastebinit", "tmate", "dig", "nslookup", "host", "drill", "ping", "autossh", "mosh", "pdsh", "ansible", "npm", "pnpm", "yarn", "bun", "cargo", "poetry", "flit", "hatch", "uv", "vsce", "ovsx", "jsr", "deno", "lerna", "changeset", "twine", "gem", "nuget", "mvn", "mvnw", "gradle", "gradlew", "goreleaser",
  "semantic-release", "release-it", "np", "surge", "cap", "kamal", "make", "gmake", "just", "task", "invoke", "curl", "wget", "http", "https", "xh", "psql", "mysql", "mariadb", "sqlite3", "sqlcmd", "clickhouse-client",
  "clickhouse", "duckdb", "cockroach", "snowsql", "mongosh", "mongo", "redis-cli", "cqlsh", "turso", "pg_restore", "rsync", "ssh-copy-id", "ngrok", "cloudflared", "lt", "localtunnel", "openssl", "printenv", "env"]);

// `fed`: the text handed to it on its input where the line holds it, and whether another command's output is.
export function remote(x: Part, fed: { text: string; piped: boolean }, w: Where, vals: Values): Risk[] {
  const { p, args, plain } = x;
  const prog = x.run.words[0]!;
  const add = (why: string): Risk[] => [{ rule: "remote", why }];
  if (/^(terraform|tofu|terragrunt)$/.test(p)) {
    if (plain[0] === "destroy" || (plain[0] === "apply" && args.some((a) => /^--?(auto-approve|destroy)$/.test(a))) || (plain[0] === "state" && plain[1] === "rm") || (plain[0] === "workspace" && plain[1] === "delete") || plain[0] === "force-unlock")
      return add(`changes or destroys infrastructure (${p} ${plain[0]}${plain[0] === "apply" ? ", with no plan to read first" : ""})`);
    return [];
  }
  if (p === "pulumi" && plain[0] === "up" && args.some((a) => /^(-y|--yes)$/.test(a))) return add("changes infrastructure (pulumi up, with no plan to read first)");
  if (p === "docker" || p === "podman" || p === "docker-compose") {
    const words = p === "docker-compose" ? ["compose", ...plain] : plain;
    if (words[0] === "system" && words[1] === "prune") return [{ rule: "destroys", why: `removes every unused container, image and network of ${p}` }];
    if (words[0] === "volume" && /^(rm|prune|remove)$/.test(words[1] ?? "")) return [{ rule: "destroys", why: `removes ${p} volumes, and the data in them` }];
    if (words[0] === "compose" && words.includes("down") && args.some((a) => /^(-v|--volumes)$/.test(a))) return [{ rule: "destroys", why: "removes the volumes of the services, and the data in them" }];
  }
  const db = database(x, fed, w, vals);
  if (db.length) return db;
  if (dry(args)) return [];
  if (SERVICE.has(p)) {
    const verb = plain.slice(0, 4).find((a) => GONE.test(a));
    if (verb) return add(`deletes on a service what nothing here brings back (${[p, ...plain.slice(0, plain.indexOf(verb) + 1)].join(" ")})`);
    if (p === "aws" && args.includes("--delete")) return add("deletes in the bucket what the source does not hold (aws --delete)");
    if ((p === "kubectl" || p === "oc") && ((plain[0] === "scale" && args.some((a) => /^--replicas(=0$|$)/.test(a) && (a.endsWith("=0") || args[args.indexOf(a) + 1] === "0"))) || (plain[0] === "apply" && args.includes("--prune"))
      || (plain[0] === "replace" && args.includes("--force")) || (plain[0] === "rollout" && plain[1] === "undo"))) return add(`takes down or replaces what runs in a cluster (${p} ${plain[0]})`);
    if (p === "helm" && plain[0] === "rollback") return add("rolls a release in a cluster back (helm rollback)");
    if (p === "gh" && plain[0] === "pr" && ((plain[1] === "merge" && args.includes("--admin")) || (plain[1] === "close" && args.includes("--delete-branch")))) return add(`${plain[1] === "merge" ? "merges past the branch's protections" : "deletes the branch on the remote"} (gh pr ${plain[1]})`);
    if (p === "gh" && ((plain[0] === "secret" && /^(set|delete|remove)$/.test(plain[1] ?? "")) || (plain[0] === "workflow" && /^(disable|enable)$/.test(plain[1] ?? "")))) return add(`changes the repository's ${plain[0] === "secret" ? "secrets" : "workflows"} on the service (gh ${plain[0]} ${plain[1]})`);
    if (p === "wrangler" && plain[0] === "d1" && plain[1] === "execute" && args.includes("--remote") && sqlLoss(args.join(" "))) return add(`${sqlLoss(args.join(" "))} a table or a database on the service (wrangler d1 execute --remote)`);
    if ((p === "firebase" && plain[0] === "hosting:disable") || (p === "railway" && plain[0] === "down")) return add(`takes down what is deployed (${p} ${plain[0]})`);
    // A file a CI host runs, written through the service's own API.
    const ci = p === "gh" && plain[0] === "api" ? args.find((a) => /\/contents\/(.*\/)?(\.(github|gitlab|circleci|forgejo|gitea|woodpecker|buildkite|tekton)\/|\.gitlab-ci\.ya?ml|Jenkinsfile|azure-pipelines\.ya?ml|bitbucket-pipelines\.yml)/.test(a)) : undefined;
    if (ci && args.some((a, k) => (/^(PUT|POST|PATCH|DELETE)$/i.test(a) && /^(-X|--method)$/.test(args[k - 1] ?? "")) || /^(-XPUT|-XPOST|-XPATCH|--method=(PUT|POST|PATCH))$/i.test(a) || /^(-f|-F|--field|--raw-field|--input)$/.test(a)))
      return add(`writes a file a CI host runs, through the service (${ci.slice(0, 100)})`);
    if (p === "gh" && plain[0] === "api" && args.some((a, k) => (/^DELETE$/i.test(a) && /^(-X|--method)$/.test(args[k - 1] ?? "")) || /^(-XDELETE|--method=DELETE)$/i.test(a))) return add("deletes on the service (gh api DELETE)");
    if (p === "gh" && plain[0] === "repo" && (plain[1] === "archive" || (plain[1] === "edit" && args.some((a) => a.startsWith("--visibility"))))) return add(`changes who can see or use the repository (gh repo ${plain[1]})`);
    if (p === "gh" && plain[0] === "release" && /^(create|upload|edit)$/.test(plain[1] ?? "")) return add("publishes a release");
  }
  for (const [who, what] of PUBLISH) if (who.test(p) && (what.source === "^" || plain.slice(0, 3).some((a) => what.test(a)))) return add(`publishes or deploys where others take it from, which cannot be taken back (${`${p} ${plain.find((a) => what.test(a)) ?? ""}`.trim()})`);
  if (INTERPRETERS.test(p) && plain[0] === "twine" && plain[1] === "upload") return add("publishes a package (twine upload)");
  // A deploy or publish step of the project: what it does elsewhere is not in the command.
  const script = SHELLS.test(p) ? !shellGiven(args).c : INTERPRETERS.test(p) && !args.some((a) => /^-[a-zA-Z]*[cer]$/.test(a) || a === "--eval" || a === "eval");
  const step = /^(make|gmake|just|task|rake|invoke)$/.test(p) ? args.find((a, k) => !a.startsWith("-") && !/^-[CfIoWl]$/.test(args[k - 1] ?? "") && !a.includes("=") && NAMED_DEPLOY.test(a))
    : /^(npm|pnpm|yarn|bun)$/.test(p) ? (plain[0] === "run" || plain[0] === "run-script" ? plain[1] : p === "npm" ? undefined : plain[0])
    : script ? plain[0] : prog.includes("/") ? prog : undefined;
  if (step && NAMED_DEPLOY.test(name(step))) return add(`runs ${name(step)}, a deploy or publish step of the project: what it does on other machines is not in the command`);
  if (w.away && step && NAMED_DOWN.test(name(step))) return add(`runs ${name(step)} there, a script named for restarting or taking down what runs`);
  // A request that deletes: -X DELETE, also at the end of a cluster (-sX DELETE) or joined (-XDELETE).
  if (/^(curl|wget|http|https|xh)$/.test(p)) {
    const del = args.some((a, k) => (/^DELETE$/i.test(a) && (/^(-[a-zA-Z]*X|--request)$/.test(args[k - 1] ?? "") || k === 0)) || /^(-[a-zA-Z]*XDELETE|--request=DELETE|--method=DELETE)$/i.test(a));
    const url = args.find((a) => /^https?:\/\//i.test(a));
    const host = url?.replace(/^https?:\/\//i, "").split(/[/?#]/)[0] ?? "";
    if (del && !LOCAL_HOST.test(host)) return add(`sends a DELETE request to ${host || "an address the command does not spell out"}`);
    // A write to an address whose last word is the act: POST .../projects/1/destroy.
    const act = url && url.length < 2_000 && !LOCAL_HOST.test(host) ? /\/(destroy|delete|remove|terminate|purge|wipe|drop)\/?$/i.exec(url.split(/[?#]/)[0]!) : null;
    if (act && args.some((a, k) => /^(POST|PUT|PATCH)$/i.test(a) && /^(-[a-zA-Z]*X|--request)$/.test(args[k - 1] ?? "") || /^(-d|--data|--data-raw|--json)$/.test(a))) return add(`asks ${host} to ${act[1]!.toLowerCase()} something`);
  }
  return [];
}

// ---- class: exposes ----

// The file in a word that hands one over: @file, name=@file;type=x, --option=file.
function named(word: string): string {
  const eq = /^[\w.-]*=/.exec(word);
  const rest = (eq ? word.slice(eq[0].length) : word).replace(/^[@<]/, "");
  const end = rest.indexOf(";");
  return end < 0 ? rest : rest.slice(0, end);
}
// A file that holds credentials, by its name: environment files, keys, token and credential stores, and the
// folders the cloud and cluster clients keep theirs in.
export function secretFile(word: string): boolean {
  const p = untrailed(named(word));
  const b = p.slice(p.lastIndexOf("/") + 1).toLowerCase();
  if (!b || /\.(example|sample|template|dist|defaults?|pub)$/.test(b)) return false;
  return /^\.env(\.|$)/.test(b) || /\.env$/.test(b) || /^\.?(netrc|npmrc|pypirc|git-credentials|htpasswd|vault-token|pgpass)$/.test(b) || /^id_(rsa|dsa|ecdsa|ed25519)/.test(b)
    || /\.(pem|key|p12|pfx|jks|keystore|kdbx|ppk|tfstate|tfvars)$/.test(b) || /^(credentials?|secrets?|kubeconfig|tokens?)(\.[a-z0-9]+)?$/.test(b)
    || (/^service[-_]?account/.test(b) && b.endsWith(".json")) || /[-_.](secrets?|credentials?)\.(json|ya?ml|toml|env|txt|ini)$/.test(b)
    || /^\.(aws|kube|ssh|gnupg|azure)$/.test(b) || (b === ".docker" && /^(~|\$HOME|\$\{HOME\}|\/home\/|\/Users\/|\/root\/)/.test(p))
    // The home folder itself holds all of them.
    || /^(~|\$HOME|\$\{HOME\})$/.test(p) || CRED_PATH.test(word);
}
const SENDS = /^(curl|wget|nc|ncat|netcat|socat|scp|sftp|ftp|tftp|rsync|http|https|xh|rclone|mail|mailx|mutt|sendmail|telnet|ssh|autossh|websocat|croc|wormhole|gsutil|aws|az|gh|openssl|pastebinit|dig|nslookup|host|drill|ping)$/;
// The options of rsync whose value is not a file it sends, and whether it is told to leave environment files out.
const RSYNC_VALUED = /^(-i|-F|-o|-J|-S|-P|-c|-l|-e|--rsh|--exclude|--include|--filter|-f|--exclude-from|--include-from|--files-from|--rsync-path|--log-file|--password-file|--temp-dir|-T|--partial-dir|--backup-dir|--chown|--chmod|--bwlimit|--port|--timeout|--compare-dest|--copy-dest|--link-dest)$/;
const leavesOutEnv = (args: string[]) => args.some((a, k) => {
  const v = /^--(exclude|filter)=/.test(a) ? a.slice(a.indexOf("=") + 1) : /^(--exclude|--filter|-f)$/.test(args[k - 1] ?? "") ? a : null;
  return v !== null && (/^(- )?\/?\.env\*?$/.test(v) || /^:- ?\.gitignore$/.test(v) || /^(- )?\.\*$/.test(v));
});
export const sender = (p: string) => SENDS.test(p);
// Options whose file is what the program proves itself with, or writes, not what it sends.
const PROVES = /^(-i|--key|--cert|--cacert|--capath|--netrc-file|--identity)$/;
const PROVES_SSH = /^(-F|-o|-J|-S)$/, PROVES_CURL = /^(-E|-K|--config)$/;
const WRITES = /^(-o|--output|-O|--output-document|-D|--dump-header|-c|--cookie-jar|-P|--directory-prefix)$/;

// Whether the part sends what it is given, and which of its arguments are what it sends.
function sent(x: Part): string[] | null {
  const { p, args, plain, s } = x;
  // A redirect into a socket the shell opens.
  if (s.redirects && /\/dev\/(tcp|udp)\//.test(s.text)) return args;
  // kubectl cp FILE POD:PATH sends the file into the cluster. (Its other words send nothing: it is no sender for what it reads there.)
  if ((p === "kubectl" || p === "oc") && plain[0] === "cp" && REMOTE_SPEC.test(plain.at(-1) ?? "")) return plain.slice(1, -1);
  if (!SENDS.test(p)) return null;
  if (p === "scp" || p === "rsync") {
    // A copy to another machine sends its sources; one from there sends nothing.
    const last = plain.at(-1) ?? "";
    // (The key it logs in with, its settings file and its port are not what it sends.)
    return REMOTE_SPEC.test(last) || last.startsWith("rsync://") ? args.filter((a, k) => a !== last && !a.startsWith("-") && !REMOTE_SPEC.test(a) && !RSYNC_VALUED.test(args[k - 1] ?? "")) : null;
  }
  if (p === "ssh" || p === "autossh") return []; // what follows its host runs there; its input is what it sends
  // A lookup sends the name it asks for: what a substitution writes into it goes to the name's servers.
  if (/^(dig|nslookup|host|drill|ping)$/.test(p)) return [];
  if (p === "pastebinit") return args;

  if (p === "openssl") return plain[0] === "s_client" ? [] : null;
  if (p === "aws") return args[0] === "s3" && /^(cp|sync|mv)$/.test(args[1] ?? "") ? args.slice(2) : null;
  if (p === "gsutil") return args.some((a) => /^(cp|rsync|mv)$/.test(a)) && /^gs:\/\//.test(plain.at(-1) ?? "") ? plain.filter((a) => !/^(cp|rsync|mv)$/.test(a) && !/^gs:\/\//.test(a)) : null;
  if (p === "az") return args.includes("upload") || args.includes("upload-batch") ? args : null;
  if (p === "rclone") return /^(copy|sync|move|copyto|moveto)$/.test(plain[0] ?? "") && REMOTE_SPEC.test(plain.at(-1) ?? "") ? plain.slice(1, -1) : null;
  if (p === "gh") {
    if (plain[0] === "gist" && plain[1] === "create") return plain.slice(2);
    if (plain[0] === "release" && plain[1] === "upload") return plain.slice(3);
    // What it posts: a body from a file, and whatever a substitution writes into its words.
    return /^(issue|pr|gist|release|api|discussion)$/.test(plain[0] ?? "") ? args.filter((a, k) => /^(-F|--body-file)$/.test(args[k - 1] ?? "") || /^--body-file=/.test(a)) : null;
  }
  const proves = (o: string) => PROVES.test(o) || WRITES.test(o) || (p === "curl" && PROVES_CURL.test(o)) || (/^(sftp)$/.test(p) && PROVES_SSH.test(o));
  return args.filter((a, k) => !proves(args[k - 1] ?? "") && !/^-[a-zA-Z]$/.test(a) && !/^--(output|output-document|cookie-jar|dump-header)=/.test(a));
}

// `above`: a credential file an earlier stage of its pipeline reads. `holding`: the variables whose value a
// substitution read from one. `anywhere`: one named anywhere else on the line, for a sender that is handed its
// input inside a substitution (`tee >(curl -d @-)`). Each is looked up only when a sender asks.
// `copies`: the names the line gave a copy of one.
export function exposes(x: Part, above: (i: number) => string | undefined, holding: () => Map<string, string>, anywhere: () => string | undefined, copies: Map<string, string>, w: Where, vals: Values): Risk[] {
  const args = sent(x);
  if (!args) return [];
  const { s } = x;
  let file = args.find(secretFile) ?? s.inputs?.find(secretFile) ?? above(x.i);
  if (!file && copies.size) for (const a of [...args, ...(s.inputs ?? [])]) { file = copies.get(named(a)); if (file) break; }
  // What a file client is told to put, in the text it is handed.
  if (!file && /^(sftp|ftp|lftp|tftp)$/.test(x.p)) { const told = /<<<\s*(?:'([^']*)'|"([^"]*)")/.exec(s.text); file = (told?.[1] ?? told?.[2])?.split(/\s+/).find(secretFile); }
  // The folder itself, when an environment file lies in it.
  // (Not when the command leaves it out by name, or leaves out what git ignores.)
  if (!file && /^(scp|rsync|rclone|aws|gsutil|az)$/.test(x.p) && !(x.p === "rsync" && leavesOutEnv(x.args))) file = args.map((a) => envIn(a, x.dir, w)).find((f) => f !== undefined);
  // A variable the line gave one value, written into what it sends (F=.env; curl -d @$F).
  if (!file) for (const [k, a] of x.args.entries()) {
    const how = x.made(k);
    const said = how && how.vars.length && !how.subs.length && args.includes(a) ? written(a, how, x.dir, w, vals, x.i) : null;
    if (typeof said === "string" && secretFile(said)) { file = said; break; }
  }
  // A socket the shell opened elsewhere on the line (exec 3<>/dev/tcp/...): what the line reads can go out through it.
  if (!file && !SENDS.test(x.p)) file = anywhere();
  // What a substitution in its own words reads, and what a variable the line filled from one holds.
  if (!file) for (const m of s.how ?? []) {
    file = m.subs.flat().flatMap((q) => [...q.words.slice(1), ...(q.inputs ?? [])]).find(secretFile) ?? m.vars.map((v) => holding().get(v.name)).find((f) => f !== undefined);
    if (file) break;
  }
  if (!file && s.nested && x.args.some((a) => a === "@-" || a === "-")) file = anywhere();
  if (!file) return [];
  return [{ rule: "exposes", why: file === ENVIRONMENT ? "sends the environment's variables, which hold credentials, to another machine" : `sends ${named(file)}, a file that holds credentials, to another machine` }];
}
// The environment file of a folder a command names whole (`.`), when the disk says there is one.
export function envIn(word: string, dir: string | null, w: Where): string | undefined {
  if (!dir || w.away || !/^\.\/?$/.test(word)) return undefined;
  return w.looked?.exists(`${dir}/.env`) === "file" ? ".env (in the folder it sends whole)" : undefined;
}
// What stands for the environment where a credential file's name would: `printenv | nc host 9000`.
export const ENVIRONMENT = "the environment";

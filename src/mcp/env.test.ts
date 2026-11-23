import { expect, test } from "bun:test";
import { envHint, maskProxy, serverEnv } from "./env.ts";
import { classify } from "./class.ts";

// A daemon's environment with made-up secrets under names no pattern catches.
const daemon = {
  PATH: "/usr/bin", HOME: "/home/o", LANG: "C.UTF-8", TERM: "xterm", LC_ALL: "C", USER: "o",
  DISPLAY: ":0", XDG_RUNTIME_DIR: "/run/user/1000",
  ANTHROPIC_API_KEY: "madeup-provider-key", GITHUB_TOKEN: "madeup-forge-token", KEEL_DEFAULT_MODEL: "x",
  DATABASE_URL: "postgres://u:madeup-db-password@db/x", PAYMENTS_LIVE: "madeup-payments-key", SSH_AUTH_SOCK: "/run/agent", AWS_PROFILE: "prod",
  BASH_FUNC_x: "() { echo hi; }",
};

test("a server gets the base and nothing else of the daemon's environment", () => {
  const env = serverEnv({ command: "x" }, daemon, "linux");
  expect(Object.keys(env).sort()).toEqual(["DISPLAY", "HOME", "LANG", "LC_ALL", "PATH", "TERM", "USER", "XDG_RUNTIME_DIR"]);
  expect(JSON.stringify(env)).not.toContain("madeup");
});

test("what the config names reaches it: a passed name, a value, a value that names a variable", () => {
  const env = serverEnv({ command: "x", env_vars: ["GITHUB_TOKEN", "UNSET"], env: { MODE: "fast", DSN: "${DATABASE_URL}", D: "${NOPE:-dflt}" } }, daemon, "linux");
  expect(env.GITHUB_TOKEN).toBe("madeup-forge-token");
  expect(env.MODE).toBe("fast");
  expect(env.DSN).toBe("postgres://u:madeup-db-password@db/x");
  expect(env.D).toBe("dflt");
  expect("UNSET" in env).toBe(false);
  expect(env.ANTHROPIC_API_KEY).toBeUndefined();
});

test("a server finds the owner's toolchains and proxy as a shell would, and no agent socket or npm credential", () => {
  const owner = {
    ...daemon, JAVA_HOME: "/opt/jdk", NVM_DIR: "/home/o/.nvm", CARGO_HOME: "/home/o/.cargo", VIRTUAL_ENV: "/home/o/venv", NODE_OPTIONS: "--max-old-space-size=4096",
    HTTPS_PROXY: "http://pu:madeup-proxy-pass@proxy:3128", no_proxy: "localhost", npm_config_prefix: "/home/o/.npm-global", NPM_CONFIG_CACHE: "/home/o/.npm",
    "npm_config_//registry.example/:_authToken": "madeup-npm-token", NPM_CONFIG__AUTH: "madeup-npm-auth", GPG_AGENT_INFO: "/run/gpg",
  };
  const env = serverEnv({ command: "x" }, owner, "linux");
  for (const k of ["JAVA_HOME", "NVM_DIR", "CARGO_HOME", "VIRTUAL_ENV", "NODE_OPTIONS", "HTTPS_PROXY", "no_proxy", "npm_config_prefix", "NPM_CONFIG_CACHE"]) expect(env[k]).toBe(owner[k as keyof typeof owner]);
  for (const k of ["SSH_AUTH_SOCK", "GPG_AGENT_INFO", "NPM_CONFIG__AUTH", "npm_config_//registry.example/:_authToken"]) expect(k in env).toBe(false);
  expect(serverEnv({ command: "x", env_vars: ["SSH_AUTH_SOCK"] }, owner, "linux").SSH_AUTH_SOCK).toBe("/run/agent");
  // The proxy's password goes to the server, and not into what is kept of its words.
  expect(maskProxy("connect http://pu:madeup-proxy-pass@proxy:3128 refused", owner)).toBe("connect http://***@proxy:3128 refused");
});

test("a proxy's password is masked with its user and alone, and a piece too short to tell from ordinary text is not", () => {
  const long = { HTTPS_PROXY: "http://proxyuser:madeup-proxy-pass@proxy:3128" };
  expect(maskProxy("via http://proxyuser:madeup-proxy-pass@proxy:3128, then pass=madeup-proxy-pass", long)).toBe("via http://***@proxy:3128, then pass=***");
  // A percent-encoded password is masked as the client decoded it, too.
  expect(maskProxy("pass=madeup proxy", { http_proxy: "http://u:madeup%20proxy@p:1" })).toBe("pass=***");
  // A token as the whole user part is masked as it is.
  expect(maskProxy("auth madeup-proxy-token failed", { ALL_PROXY: "socks5://madeup-proxy-token@p:1" })).toBe("auth *** failed");
  // Under eight characters: "u:pw" and "pw" are left, as they are in every word that holds them.
  expect(maskProxy("http://u:pw@p:1 upward", { HTTPS_PROXY: "http://u:pw@p:1" })).toBe("http://u:pw@p:1 upward");
  // A long user with a short password: the pair is masked, the password alone is not.
  expect(maskProxy("http://longproxyuser:pw@p:1 pw", { HTTPS_PROXY: "http://longproxyuser:pw@p:1" })).toBe("http://***@p:1 pw");
});

test("a server that failed is told of the base and of the names it went without that look like its own", () => {
  const owner = { ...daemon, HARNESS_WEBSEARCH_BIN: "/x", BRAVE_API_KEY: "k", NPM_TOKEN: "t", SEARXNG_URL: "u" };
  const c = { command: "node", args: ["/srv/harness-web/server.mjs"] };
  const hint = envHint("harness-web", c, serverEnv(c, owner, "linux"), owner);
  // (NPM_TOKEN looks like its own too, but a credential's name is not pointed to.)
  expect(hint).toBe("Keel passes a base set of variables; name more in env_vars. It went without HARNESS_WEBSEARCH_BIN, which looks like its own.");
  const node = { ...owner, NODE_EXTRA_FLAGS: "x", NODE_AUTH_TOKEN: "t", NPM_PASSWORD: "p", NODE_SECRET_DIR: "s", NODE_KEYFILE: "k" };
  expect(envHint("harness-web", c, serverEnv(c, node, "linux"), node)).toBe("Keel passes a base set of variables; name more in env_vars. It went without HARNESS_WEBSEARCH_BIN, NODE_EXTRA_FLAGS, which look like its own.");
  expect(envHint("plain", { command: "plain-tool" }, {}, { OTHER: "x" })).toBe("Keel passes a base set of variables; name more in env_vars.");
});

test("each platform has its own base", () => {
  expect(Object.keys(serverEnv({}, { ...daemon, __CF_USER_TEXT_ENCODING: "0x1F5" }, "darwin"))).toContain("__CF_USER_TEXT_ENCODING");
  expect(Object.keys(serverEnv({}, { ...daemon, __CF_USER_TEXT_ENCODING: "0x1F5" }, "linux"))).not.toContain("__CF_USER_TEXT_ENCODING");
  expect(serverEnv({}, { ...daemon, NODE_EXTRA_CA_CERTS: "/etc/ca.pem" }, "linux").NODE_EXTRA_CA_CERTS).toBe("/etc/ca.pem");
  // Windows names are any case; nothing of the POSIX desktop.
  expect(Object.keys(serverEnv({}, { Path: "C:\\x", SystemRoot: "C:\\Windows", DISPLAY: ":0", GITHUB_TOKEN: "t" }, "win32")).sort()).toEqual(["Path", "SystemRoot"]);
});

test("a server is classed from its config, and the owner's answer stands over it", () => {
  const local = classify({ command: "x" });
  expect([local.outside.yes, local.outside.by, local.sends.yes, local.sends.by, local.account.yes]).toEqual([true, "assumed", true, "assumed", false]);
  expect(classify({ command: "x", env: { GITHUB_PERSONAL_ACCESS_TOKEN: "t" } }).account).toMatchObject({ yes: true, by: "config" });
  expect(classify({ url: "https://x.example/mcp" }).sends).toMatchObject({ yes: true, by: "config" });
  expect(classify({ url: "https://x.example/mcp", bearer_env: "T" }).account.yes).toBe(true);
  expect(classify({ url: "https://x.example/mcp" }, true).account.why).toBe("the owner signed in to it");
  expect(classify({ command: "x", class: { sends: false } }).sends).toMatchObject({ yes: false, by: "owner" });
});

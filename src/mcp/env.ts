// The environment an owner's stdio server starts with: a base of the daemon's
// variables, the ones its config names (`env_vars`), and its own (`env`,
// where `${NAME}` names a daemon variable on purpose). Nothing else of the
// daemon's environment: no provider key, token or setting reaches a server,
// whatever the variable is called, unless the config names it.
//
// The base is what a program needs to run as the owner on this machine and
// nothing that grants anything:
// - what the MCP SDKs let a stdio server inherit (DEFAULT_INHERITED_ENV_VARS
//   in modelcontextprotocol/typescript-sdk and python-sdk: HOME, LOGNAME,
//   PATH, SHELL, TERM, USER; on Windows the system folders and the user's),
//   with what Codex adds (the locale, the time zone, the temp folder, and on
//   macOS __CF_USER_TEXT_ENCODING), and the certificate authorities Codex
//   passes on (a file or folder of the CAs a TLS client trusts, behind a
//   proxy that inspects TLS);
// - where the owner's desktop session is, so a server that drives the screen
//   or reads the accessibility tree still works: the display (X11 and
//   Wayland, and the X authority file), the session bus and the runtime
//   folder, the session and desktop, the XDG base folders, and the switches
//   that turn on the accessibility bridges and input methods of the apps it
//   starts. These name places and settings, not credentials: a process of
//   the owner's account finds the session bus at its default path anyway;
// - where the owner's toolchains are (a Java, a Node manager, a Rust or Go
//   home, the active Python environment, a loader or build path, a model
//   cache folder, the npm settings that name no credential) and the editor,
//   so a server started through one finds it as a shell would;
// - the proxy the owner's network goes through, as a shell would see it. A
//   proxy address can carry a user and password: it is passed all the same
//   (a server behind that proxy reaches nothing without it, and it grants
//   the network, not an account), and masked wherever the server's own
//   words are kept (maskProxy: its stderr and its log lines).
// An agent socket (SSH_AUTH_SOCK, GPG_AGENT_INFO) is not in the base: it
// lends the owner's keys, so a server gets it only when its config names it.
// A variable whose value is a shell function (bash exports one as `() {`) is
// left out, as the TypeScript SDK does.
import { basename } from "node:path";
import { expand, type McpServerConfig } from "./config.ts";

const POSIX = ["HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER", "USERNAME", "LANG", "TZ", "TMPDIR", "EDITOR", "VISUAL"];
const DESKTOP = [
  "DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "XDG_SESSION_TYPE", "XDG_CURRENT_DESKTOP",
  "XDG_SESSION_DESKTOP", "XDG_SESSION_CLASS", "XDG_MENU_PREFIX", "DESKTOP_SESSION", "GDMSESSION",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_DIRS", "XDG_DATA_DIRS",
  "GTK_MODULES", "QT_ACCESSIBILITY", "NO_AT_BRIDGE", "GTK_IM_MODULE", "QT_IM_MODULE", "QT_IM_MODULES", "XMODIFIERS",
];
const TOOLS = [
  "JAVA_HOME", "NVM_DIR", "NVM_BIN", "NVM_INC", "NODE_PATH", "NODE_OPTIONS", "BUN_INSTALL", "PNPM_HOME", "VOLTA_HOME", "DENO_DIR", "DENO_INSTALL",
  "CARGO_HOME", "RUSTUP_HOME", "GOPATH", "GOROOT", "GOBIN", "GOMODCACHE",
  "VIRTUAL_ENV", "CONDA_PREFIX", "CONDA_DEFAULT_ENV", "PYENV_ROOT", "PYTHONPATH", "PYTHONHOME", "PIPX_HOME", "UV_CACHE_DIR", "UV_TOOL_DIR", "UV_PYTHON_INSTALL_DIR",
  "ASDF_DIR", "ASDF_DATA_DIR", "MISE_DATA_DIR", "SDKMAN_DIR", "ANDROID_HOME", "ANDROID_SDK_ROOT", "DOTNET_ROOT", "CUDA_HOME", "CUDA_PATH",
  "CUDAToolkit_ROOT", "DOTNET_CLI_TELEMETRY_OPTOUT", "DOTNET_NOLOGO",
  "LD_LIBRARY_PATH", "LIBRARY_PATH", "PKG_CONFIG_PATH", "CMAKE_PREFIX_PATH", "CMAKE_LIBRARY_PATH", "PLAYWRIGHT_BROWSERS_PATH", "PUPPETEER_CACHE_DIR",
  "HF_HOME", "HF_HUB_CACHE", "HUGGINGFACE_HUB_CACHE", "TRANSFORMERS_CACHE",
];
// Upper and lower case: curl and Python read the lower, Node's agents and Go the upper.
const PROXY = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "FTP_PROXY"].flatMap((k) => [k, k.toLowerCase()]);
// npm reads its settings from npm_config_<name> in either case; the ones that hold a credential stay out.
const NPM = /^npm_config_/i;
const NPM_CREDENTIAL = /AUTH|TOKEN|PASS|KEY|SECRET|USER|EMAIL|OTP|CERT$/i;
const MACOS = ["__CF_USER_TEXT_ENCODING"];
const CA = ["SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "GIT_SSL_CAINFO", "PIP_CERT"];
// The TypeScript SDK's list.
const WINDOWS = [
  "APPDATA", "COMSPEC", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "PATH", "PATHEXT", "PROCESSOR_ARCHITECTURE", "PROGRAMDATA", "PROGRAMFILES",
  "PROGRAMFILES(X86)", "PROGRAMW6432", "SYSTEMDRIVE", "SYSTEMROOT", "TEMP", "USERNAME", "USERPROFILE", "WINDIR",
];

// The base names for a platform (process.platform's word).
export function baseNames(platform: string): string[] {
  if (platform === "win32") return [...WINDOWS, ...TOOLS.map((k) => k.toUpperCase()), ...PROXY.filter((k) => k === k.toUpperCase()), ...CA];
  return [...POSIX, ...(platform === "darwin" ? MACOS : []), ...DESKTOP, ...TOOLS, ...PROXY, ...CA];
}

const inBase = (k: string, platform: string, names: Set<string>) =>
  (platform === "win32" ? names.has(k.toUpperCase()) : names.has(k) || k.startsWith("LC_")) || (NPM.test(k) && !NPM_CREDENTIAL.test(k.slice(11)));

export function serverEnv(c: McpServerConfig, from: Record<string, string | undefined> = process.env, platform: string = process.platform): Record<string, string> {
  const names = new Set(baseNames(platform));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(from)) if (v !== undefined && !v.startsWith("()") && inBase(k, platform, names)) env[k] = v;
  for (const k of c.env_vars ?? []) if (from[k] !== undefined) env[k] = from[k]!;
  for (const [k, v] of Object.entries(c.env ?? {})) env[k] = expand(String(v), from);
  return env;
}

// What of each proxy address in an environment is masked, as it appears in
// it: its user and password together, and its password alone (a server can
// write the one without the other), the longer first. A piece shorter than
// MASK_MIN is not masked: so short a string turns up in ordinary text by
// chance (a masked "u:pw" would blot that run out of every path and word the
// server writes), and masking it would garble its words more than it hides.
export const MASK_MIN = 8;
export function proxyCredentials(from: Record<string, string | undefined> = process.env): string[] {
  const out = new Set<string>();
  for (const k of PROXY) {
    const m = from[k]?.match(/^[a-z][a-z0-9+.-]*:\/\/([^\s/@]+)@/i);
    if (!m) continue;
    const pass = m[1]!.includes(":") ? m[1]!.slice(m[1]!.indexOf(":") + 1) : "";
    for (const piece of [m[1]!, pass]) if (piece.length >= MASK_MIN) out.add(piece);
  }
  return [...out].sort((a, b) => b.length - a.length);
}

// Text a server wrote, with a proxy's user and password in it masked.
export function maskProxy(text: string, from: Record<string, string | undefined> = process.env): string {
  let out = text;
  for (const cred of proxyCredentials(from)) {
    out = out.split(cred).join("***");
    // (Written out by a client that decoded it, too.)
    try {
      const plain = decodeURIComponent(cred);
      if (plain !== cred) out = out.split(plain).join("***");
    } catch {} // a credential that is not valid percent-encoding is only written as it is
  }
  return out;
}

// Words of a server's name and command that say little of what it needs.
const PLAIN = new Set(["mcp", "server", "servers", "bin", "local", "usr", "index", "main", "build", "dist", "lib", "src", "cli", "run", "the"]);
// The variables a runner's family reads, by the runner's name.
const FAMILY: [RegExp, RegExp][] = [
  [/^(node|npx|npm|pnpm|yarn|bun|bunx|deno)$/, /^(NODE|NPM|NVM|BUN|PNPM|YARN|DENO|COREPACK)_/i],
  [/^(python\d*|uv|uvx|pip\d*|pipx|poetry)$/, /^(PYTHON|UV|PIP|PIPX|CONDA|VIRTUAL|POETRY)_?/i],
  [/^(java|mvn|gradle)$/, /^(JAVA|MAVEN|GRADLE|JDK)_/i],
  [/^(docker|podman)$/, /^(DOCKER|PODMAN|CONTAINER)_/i],
  [/^(go)$/, /^GO/],
  [/^(cargo|rustc)$/, /^(CARGO|RUST)/],
];

const CREDENTIAL_NAME = /AUTH|TOKEN|PASS|KEY|SECRET/i;

// What a server that failed to start, or failed its first call, is told of
// the variables it did not get: the base, and the daemon's names it went
// without that look like its own (a word of its name, command or script in
// them, or its runner's family), at most `max` of them. Names only.
export function envHint(name: string, c: McpServerConfig, passed: Record<string, string>, from: Record<string, string | undefined> = process.env, max = 8): string {
  const words = new Set(
    [name, c.command ?? "", ...(c.args ?? []).slice(0, 4)]
      .flatMap((s) => basename(s).toLowerCase().replace(/\.(m?js|ts|py|sh|exe)$/, "").split(/[^a-z0-9]+/))
      .filter((w) => w.length >= 3 && !PLAIN.has(w) && !/^\d+$/.test(w)),
  );
  const runners = [c.command ?? "", ...(c.args ?? []).slice(0, 1)].map((s) => basename(s).toLowerCase());
  const family = FAMILY.filter(([r]) => runners.some((x) => r.test(x))).map(([, v]) => v);
  // (A credential's name is not pointed to: the base keeps those out on purpose, and the owner names one knowingly.)
  const dropped = Object.keys(from).filter((k) => from[k] !== undefined && !(k in passed) && !CREDENTIAL_NAME.test(k)).sort();
  const likely = dropped.filter((k) => k.toLowerCase().split(/_+/).some((w) => words.has(w)) || family.some((f) => f.test(k)));
  const shown = likely.slice(0, max);
  const more = likely.length > max ? ` and ${likely.length - max} more` : "";
  const named = shown.length ? ` It went without ${shown.join(", ")}${more}, which ${likely.length === 1 ? "looks" : "look"} like its own.` : "";
  return `Keel passes a base set of variables; name more in env_vars.${named}`;
}

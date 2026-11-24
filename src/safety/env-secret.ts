// Which names of an environment carry a secret: the one place that says it, for the sandbox (the names a
// sandboxed command does not get, src/safety/sandbox-view.ts) and for the daemon's own environment
// (src/safety/closed-env.ts, which keeps them out of /proc/<daemon>/environ).

export const ENV_SECRET = /TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|APIKEY|API_KEY|PRIVATE_KEY|ACCESS_KEY|(^|_)AUTH(_|$)|(^|_)KEY$/i;
// The telemetry exporters' headers carry a sign-in under a name that says nothing of it.
const EXPORTER_HEADERS = /^OTEL_EXPORTER_OTLP(_[A-Z]+)?_HEADERS$/;
// A URL that carries a sign-in before its host: a user and a password, or a token alone (https://token@host).
export const URL_SIGN_IN = /(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi;
// A value that carries a sign-in under a name a build keeps: a header (Authorization: ..., Bearer ...), a token
// in a URL's query, a netrc line, a field of JSON, a flag that sets one (GOFLAGS -X main.token=...). Such a
// variable goes whole: there is no telling what of it is safe.
export const VALUE_SECRET = /\b(proxy-)?authorization\s*:|\b(bearer|basic)\s+[A-Za-z0-9._~+\/=-]{8,}|\b(login|password|passwd)\s+\S+\s*$|\bpassword\s+\S|[?&;.\s"'{,_-](access[_-]?token|auth[_-]?token|token|api[_-]?key|apikey|secret|password|passwd|credentials?)["']?\s*[=:]\s*["']?[^\s"'&]/i;
// git settings given through the environment (GIT_CONFIG_COUNT, GIT_CONFIG_KEY_n, GIT_CONFIG_VALUE_n): a pair that
// carries a sign-in (an Authorization header, a credential helper, a URL with one).
const GIT_PAIR_SECRET = /authorization\s*:|\b(bearer|basic)\s+\S|token|passw|secret|credential/i;
const GIT_KEY_SECRET = /extraheader|credential|proxyauth|password|token/i;
export const GIT_PAIR_NAME = /^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/;

type Env = Record<string, string | undefined>;

// Whether one pair of git's numbered settings carries a sign-in (then all of them go: one cannot be taken out alone).
export function gitPairsSecret(env: Env): boolean {
  const count = Number(env.GIT_CONFIG_COUNT ?? 0);
  for (let i = 0; i < Math.min(Number.isFinite(count) ? count : 0, 256); i++) {
    const k = env[`GIT_CONFIG_KEY_${i}`] ?? "", v = env[`GIT_CONFIG_VALUE_${i}`] ?? "";
    if (GIT_KEY_SECRET.test(k) || GIT_PAIR_SECRET.test(v) || new RegExp(URL_SIGN_IN.source, "i").test(v) || new RegExp(URL_SIGN_IN.source, "i").test(k)) return true;
  }
  return false;
}

// The names of an environment that hold a secret, by their name or by what their value carries. Wider than
// needed is harmless for the daemon: a name taken out of its starting environment is put back in the
// process (src/safety/closed-env.ts), so what the daemon starts gets it all the same.
export function secretEnvNames(env: Env): string[] {
  const git = gitPairsSecret(env);
  const out: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const byName = (ENV_SECRET.test(name) && name !== "SSH_AUTH_SOCK") || EXPORTER_HEADERS.test(name);
    const gitName = GIT_PAIR_NAME.test(name);
    if (byName || (gitName && git) || (!gitName && (VALUE_SECRET.test(value.replace(URL_SIGN_IN, "$1")) || value.replace(URL_SIGN_IN, "$1") !== value))) out.push(name);
  }
  return out;
}

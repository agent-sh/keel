// `keel --help`, the short usage of an unknown command, and shell completion.
const GROUPS: [string, [string, string][]][] = [
  ["Run", [
    ["run", "send a prompt; -p prints the answer (text, json, stream-json), runs without a daemon"],
    ["resume", "continue a session with a prompt, or attach to it"],
    ["send", "text or files to a session, or into its draft; --wait prints the reply"],
    ["attach", "follow a session in this terminal and type into it"],
    ["approve", "answer an open approval card or question"],
    ["rules", "the standing permission rules: list, revoke, check a sample"],
    ["review", "pull request reviews from GitHub: watch a repository, list, post a draft"],
    ["stop", "interrupt a session's running turn"],
  ]],
  ["Sessions", [
    ["sessions", "list or search sessions (also: ls)"],
    ["search", "what was said and done in any session, with when; --commands, --since, --on, --state"],
    ["stuck", "the turns, tools and agents that made no progress for too long"],
    ["agents", "a session's agents: which work, which wait; --limit sets how many work at once"],
    ["messages", "a session's messages between sessions, each with its state"],
    ["changes", "what a session changed in its working tree, by turn; a turn's files and patch"],
    ["cost", "what one session cost: its agents, turns, requests and where the tokens went"],
    ["show", "a session and its transcript"],
    ["logs", "a session's events; -f follows them"],
    ["open", "open the workbench on a directory's session"],
    ["export", "write a session for Claude Code or Codex"],
    ["import", "sessions of other harnesses: list, preview, import"],
    ["port", "bring your setup from Claude Code, Codex, Hermes and the Rust Keel"],
    ["models", "the models the providers list"],
    ["providers", "the providers; add, test and probe an endpoint or a local server"],
    ["mcp", "the MCP servers; channel: take the events a server pushes into sessions"],
  ]],
  ["Daemon", [
    ["serve", "run the daemon (the agent loop, the API and the workbench)"],
    ["status", "the running daemon; --sessions: every session in one short text; --away: what happened while you were away"],
    ["drain", "let running turns finish, then stop"],
    ["restart", "drain, then start again (also: upgrade)"],
    ["ui", "serve a new UI bundle without a restart; rollback"],
    ["storage", "what the state folder holds"],
    ["doctor", "one health check: broken files, dead hooks, the sandbox, providers, MCP servers, disk"],
    ["leftovers", "commands still running, worktrees and branches no live session holds"],
    ["cleanup", "delete old archived sessions"],
    ["backup", "a checked copy of the database, the settings and the config folder"],
    ["backups", "list the backups"],
    ["restore", "put a backup in place (daemon stopped); --config for its config files"],
    ["report", "a redacted bundle about a problem"],
    ["debug", "a failure's debug bundle, the errors, traces and the daemon log"],
    ["usage", "tokens, spend and timings; the spend ranked by session and agent tree; --slow: the slowest requests; --tools: failures per tool and session"],
    ["activity", "what happened across sessions, newest first; --failures, --since, --session"],
    ["service", "write the systemd user unit"],
  ]],
  ["Devices and editors", [
    ["pair", "pair a phone"],
    ["devices", "the paired phones"],
    ["revoke", "unpair a phone"],
    ["notify", "send a test push"],
    ["acp", "speak the Agent Client Protocol on stdio, for an editor"],
    ["plugin", "install, list, enable, disable, update, remove plugins; check a provider plugin"],
    ["login", "sign in to a provider plan (xai)"],
    ["logout", "sign out of a provider plan (xai)"],
    ["completion", "shell completion: keel completion bash|zsh|fish"],
  ]],
];

export const COMMAND_NAMES = GROUPS.flatMap(([, cmds]) => cmds.map(([n]) => n)).concat(["ls", "upgrade", "help"]);

export function topHelp(): string {
  const w = Math.max(...GROUPS.flatMap(([, c]) => c.map(([n]) => n.length)));
  return [
    "keel: a coding agent harness. The daemon runs sessions; these commands drive it.",
    "",
    "usage: keel <command> [options]       keel <command> --help for its options",
    "       keel -p PROMPT                 the same as keel run -p PROMPT",
    "       keel --version                 the revision and target this binary was built from",
    "",
    ...GROUPS.flatMap(([g, cmds]) => [`${g}:`, ...cmds.map(([n, d]) => `  ${n.padEnd(w)}  ${d}`), ""]),
    "Client commands find the daemon from --url, KEEL_URL, or the state folder (--state-dir,",
    "KEEL_STATE_DIR). Exit codes: 0 done, 2 the session needs the owner, 3 error, 124 timeout.",
  ].join("\n");
}

export function unknownCommand(name: string): number {
  const near = COMMAND_NAMES.filter((n) => n.startsWith(name.slice(0, 2))).slice(0, 3);
  console.error(`keel: unknown command ${JSON.stringify(name)}${near.length ? `; did you mean ${near.join(", ")}?` : ""}\nusage: keel <command> [options]; keel --help lists the commands`);
  return 3;
}

// Shell completion for bash, zsh and fish, from one table: the flags that
// take a value and what the value is, and what a command's first argument is.
// Flags come from each command's own --help when a word is completed (one
// source of truth); session ids from `keel sessions --ids`.
type Words = string | "dirs" | "files" | "models" | "all-sessions" | "sessions" | "commands";
const VALUES: [flags: string[], what: Words][] = [
  [["--cwd", "-C", "--workspace", "--state-dir", "--path", "--file", "--exec"], "dirs"],
  [["--attach"], "files"],
  [["--output-format"], "text json stream-json"],
  [["--input-format"], "text stream-json"],
  [["--permission-mode", "--mode"], "ask auto-edits auto full-auto read-only plan reviewer new update open"],
  [["--on-ask"], "exit deny wait stdin"],
  [["--choice"], "once session always deny"],
  [["--format"], "claude_code codex"],
  [["--harness"], "claude codex keel"],
  [["--model", "-m"], "models"],
  [["--session", "--resume", "-r", "--approval"], "all-sessions"],
];
const SHELLS = ["bash", "zsh", "fish"];
const FIRST: [commands: string[], what: Words][] = [
  [["show", "logs", "stop", "attach", "approve", "export", "resume", "send"], "sessions"],
  [["import"], "list harnesses folders preview run batch file index"],
  [["login", "logout"], "xai"],
  [["plugin"], "install list enable disable update remove check"],
  [["mcp"], "list channel"],
  [["review"], "watch unwatch list post"],
  [["service"], "install"],
  [["completion"], SHELLS.join(" ")],
  [["help"], "commands"],
];
const FOLDERS = ["open", "serve"]; // every argument is a folder
// The shell's own words for each kind, in POSIX shells (bash and zsh run the same commands).
const MODEL_IDS = String.raw`keel models --json 2>/dev/null | grep -o '"id": *"[^"]*"' | sed 's/.*"\([^"]*\)"$/\1/'`;
// A flag is a dash word that does not continue another word: after a space, a comma, a bracket, a bar.
const FLAGS_OF = (cmd: string) => String.raw`keel ${cmd} --help 2>/dev/null | grep -oE -- '(^|[^a-zA-Z0-9-])--?[a-zA-Z][a-zA-Z-]*' | grep -oE -- '--?[a-zA-Z][a-zA-Z-]*' | sort -u`;
const listOf = (what: Words) => (what === "models" ? `$(${MODEL_IDS})` : what === "all-sessions" ? "$(keel sessions --ids -a 2>/dev/null)" : what === "sessions" ? "$(keel sessions --ids 2>/dev/null)" : what === "commands" ? "@COMMANDS@" : what);

// "@{" stands for the shell's "${" in the scripts below.
const bashWords = (what: Words) => (what === "dirs" ? `COMPREPLY=( $(compgen -d -- "$cur") )` : what === "files" ? `COMPREPLY=( $(compgen -f -- "$cur") )` : `COMPREPLY=( $(compgen -W "${listOf(what)}" -- "$cur") )`);
const BASH = String.raw`# keel completion for bash. Load it with:  source <(keel completion bash)
_keel_flags_cache=()
_keel() {
  local cur prev cmd words
  cur="@{COMP_WORDS[COMP_CWORD]}"
  prev="@{COMP_WORDS[COMP_CWORD-1]}"
  cmd="@{COMP_WORDS[1]}"
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "@COMMANDS@ --help -p" -- "$cur") )
    return
  fi
  case "$prev" in
${VALUES.map(([flags, what]) => `    ${flags.join("|")}) ${bashWords(what)}; return ;;`).join("\n")}
  esac
  if [[ "$cur" == -* ]]; then
    local i key="$cmd" flags=""
    for i in "@{!_keel_flags_cache[@]}"; do
      [[ "@{_keel_flags_cache[$i]}" == "$key="* ]] && flags="@{_keel_flags_cache[$i]#*=}"
    done
    if [ -z "$flags" ]; then
      flags="$(${FLAGS_OF('"$cmd"')} | tr '\n' ' ')"
      _keel_flags_cache+=("$key=$flags")
    fi
    COMPREPLY=( $(compgen -W "$flags" -- "$cur") )
    return
  fi
  case "$cmd" in
${FIRST.map(([cmds, what]) => `    ${cmds.join("|")}) [ "$COMP_CWORD" -eq 2 ] && ${bashWords(what)} ;;`).join("\n")}
    ${FOLDERS.join("|")}) COMPREPLY=( $(compgen -d -- "$cur") ) ;;
  esac
}
complete -o default -F _keel keel
`;

// zsh: the same function over zsh's own completion calls. Sourced, it
// registers itself; saved as _keel in a folder of $fpath, zsh loads it on
// first use (the #compdef line) and runs it.
// (zsh splits an unquoted command substitution into words, and nothing else.)
const zshWords = (what: Words) => (what === "dirs" ? "_files -/" : what === "files" ? "_files" : `compadd -- ${listOf(what)}`);
const ZSH = String.raw`#compdef keel
# keel completion for zsh. Load it with:  source <(keel completion zsh)
# or save it where zsh looks for completions:  keel completion zsh > "@{fpath[1]}/_keel"
typeset -gA _keel_flags_cache
_keel() {
  local cur="@{words[CURRENT]}" prev="@{words[CURRENT-1]}" cmd="@{words[2]}"
  if (( CURRENT == 2 )); then
    compadd -- @COMMANDS@ --help -p
    return
  fi
  case "$prev" in
${VALUES.map(([flags, what]) => `    ${flags.join("|")}) ${zshWords(what)}; return ;;`).join("\n")}
  esac
  if [[ "$cur" == -* ]]; then
    [[ -n "@{_keel_flags_cache[$cmd]}" ]] || _keel_flags_cache[$cmd]="$(${FLAGS_OF('"$cmd"')} | tr '\n' ' ')"
    compadd -- @{=_keel_flags_cache[$cmd]}
    return
  fi
  case "$cmd" in
${FIRST.map(([cmds, what]) => `    ${cmds.join("|")}) if (( CURRENT == 3 )); then ${zshWords(what)}; else _files; fi ;;`).join("\n")}
    ${FOLDERS.join("|")}) _files -/ ;;
    *) _files ;;
  esac
}
if [[ "@{funcstack[1]}" == _keel ]]; then _keel "$@"; else compdef _keel keel; fi
`;

// fish: one rule per row of the table. Files are offered where nothing else
// is, as in the other two.
const fishWords = (what: Words) =>
  what === "dirs" ? `-x -a '(__fish_complete_directories)'` : what === "files" ? "-r -F"
  : what === "models" ? String.raw`-x -a '(keel models --json 2>/dev/null | string match -rg -- \'"id": *"([^"]*)"\')'`
  : what === "all-sessions" ? `-x -a '(keel sessions --ids -a 2>/dev/null)'` : what === "sessions" ? `-x -a '(keel sessions --ids 2>/dev/null)'`
  : `-x -a '${what === "commands" ? "@COMMANDS@" : what}'`;
const FISH = String.raw`# keel completion for fish. Save it where fish looks for completions:
#   keel completion fish > ~/.config/fish/completions/keel.fish
# The words before the one being completed.
function __keel_words; commandline -opc; end
function __keel_cmd; set -l w (__keel_words); test (count $w) -ge 2; and echo $w[2]; end
function __keel_at; test (count (__keel_words)) -eq $argv[1]; end
function __keel_after; set -l w (__keel_words); contains -- $w[-1] $argv; end
function __keel_first_of; __keel_at 2; and contains -- (__keel_cmd) $argv; end
function __keel_flags
  set -l cmd (__keel_cmd)
  test -n "$cmd"; and keel $cmd --help 2>/dev/null | string match -rag -- '(?:^|[^a-zA-Z0-9-])(--?[a-zA-Z][a-zA-Z-]*)' | sort -u
end
complete -c keel -n '__keel_at 1' -x -a '@COMMANDS@ --help -p'
${VALUES.map(([flags, what]) => `complete -c keel -n '__keel_after ${flags.join(" ")}' ${fishWords(what)}`).join("\n")}
complete -c keel -n 'not __keel_at 1; and string match -q -- "-*" (commandline -ct)' -f -a '(__keel_flags)'
${FIRST.map(([cmds, what]) => `complete -c keel -n '__keel_first_of ${cmds.join(" ")}' ${fishWords(what)}`).join("\n")}
complete -c keel -n 'contains -- (__keel_cmd) ${FOLDERS.join(" ")}' -x -a '(__fish_complete_directories)'
`;
const SCRIPTS: Record<string, string> = { bash: BASH, zsh: ZSH, fish: FISH };

export async function completion(argv: string[]): Promise<number> {
  const usage = "keel completion bash|zsh|fish\n  Prints the shell's completion script.\n  bash: source <(keel completion bash), or save it: keel completion bash > ~/.local/share/bash-completion/completions/keel\n  zsh:  source <(keel completion zsh), or save it as _keel in a folder of $fpath\n  fish: keel completion fish > ~/.config/fish/completions/keel.fish";
  if (argv[0] === "--help" || argv[0] === "-h") return (console.log(usage), 0);
  const script = SCRIPTS[argv[0] ?? ""];
  if (!script) return (console.error(`keel completion: ${argv[0] ? `no completion for ${JSON.stringify(argv[0])}` : "name the shell"}: keel completion ${SHELLS.join("|")}`), 3);
  process.stdout.write(script.replaceAll("@{", "${").replaceAll("@COMMANDS@", COMMAND_NAMES.filter((n) => n !== "help").concat("help").join(" ")));
  return 0;
}

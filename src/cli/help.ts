// `keel --help`, the short usage of an unknown command, and shell completion.
const GROUPS: [string, [string, string][]][] = [
  ["Run", [
    ["run", "send a prompt; -p prints the answer (text, json, stream-json), runs without a daemon"],
    ["resume", "continue a session with a prompt, or attach to it"],
    ["send", "text or files to a session, or into its draft; --wait prints the reply"],
    ["attach", "follow a session in this terminal and type into it"],
    ["approve", "answer an open approval card or question"],
    ["rules", "the standing permission rules: list, revoke, check a sample"],
    ["stop", "interrupt a session's running turn"],
  ]],
  ["Sessions", [
    ["sessions", "list or search sessions (also: ls)"],
    ["show", "a session and its transcript"],
    ["logs", "a session's events; -f follows them"],
    ["open", "open the workbench on a directory's session"],
    ["export", "write a session for Claude Code or Codex"],
    ["import", "sessions of other harnesses: list, preview, import"],
    ["port", "bring your setup from Claude Code, Codex, Hermes and the Rust Keel"],
    ["models", "the models the providers list"],
  ]],
  ["Daemon", [
    ["serve", "run the daemon (the agent loop, the API and the workbench)"],
    ["status", "the running daemon"],
    ["drain", "let running turns finish, then stop"],
    ["restart", "drain, then start again (also: upgrade)"],
    ["storage", "what the state folder holds"],
    ["cleanup", "delete old archived sessions"],
    ["backup", "a checked copy of the database"],
    ["backups", "list the backups"],
    ["restore", "put a backup in place (daemon stopped)"],
    ["report", "a redacted bundle about a problem"],
    ["debug", "a failure's debug bundle, the errors, traces and the daemon log"],
    ["usage", "tokens, spend and timings"],
    ["service", "write the systemd user unit"],
  ]],
  ["Devices and editors", [
    ["pair", "pair a phone"],
    ["devices", "the paired phones"],
    ["revoke", "unpair a phone"],
    ["notify", "send a test push"],
    ["acp", "speak the Agent Client Protocol on stdio, for an editor"],
    ["plugin", "check a provider plugin against protocol v1"],
    ["login", "sign in to a provider plan (xai)"],
    ["logout", "sign out of a provider plan (xai)"],
    ["completion", "shell completion: keel completion bash"],
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

// Flags come from each command's own --help when a word is completed (one
// source of truth); session ids from `keel sessions --ids`.
const BASH = `# keel completion for bash. Load it with:  source <(keel completion bash)
_keel_flags_cache=()
_keel() {
  local cur prev cmd words
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  cmd="\${COMP_WORDS[1]}"
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "@COMMANDS@ --help -p" -- "$cur") )
    return
  fi
  case "$prev" in
    --cwd|-C|--workspace|--state-dir|--path|--file|--exec) COMPREPLY=( $(compgen -d -- "$cur") ); return ;;
    --attach) COMPREPLY=( $(compgen -f -- "$cur") ); return ;;
    --output-format) COMPREPLY=( $(compgen -W "text json stream-json" -- "$cur") ); return ;;
    --permission-mode|--mode) COMPREPLY=( $(compgen -W "ask auto-edits full-auto read-only reviewer new update open" -- "$cur") ); return ;;
    --on-ask) COMPREPLY=( $(compgen -W "exit deny wait" -- "$cur") ); return ;;
    --choice) COMPREPLY=( $(compgen -W "once session always deny" -- "$cur") ); return ;;
    --format) COMPREPLY=( $(compgen -W "claude_code codex" -- "$cur") ); return ;;
    --harness) COMPREPLY=( $(compgen -W "claude codex keel" -- "$cur") ); return ;;
    --model|-m) COMPREPLY=( $(compgen -W "$(keel models --json 2>/dev/null | grep -o '"id": *"[^"]*"' | sed 's/.*"\\([^"]*\\)"$/\\1/')" -- "$cur") ); return ;;
    --session|--resume|-r|--approval) COMPREPLY=( $(compgen -W "$(keel sessions --ids -a 2>/dev/null)" -- "$cur") ); return ;;
  esac
  if [[ "$cur" == -* ]]; then
    local i key="$cmd" flags=""
    for i in "\${!_keel_flags_cache[@]}"; do
      [[ "\${_keel_flags_cache[$i]}" == "$key="* ]] && flags="\${_keel_flags_cache[$i]#*=}"
    done
    if [ -z "$flags" ]; then
      flags="$(keel "$cmd" --help 2>/dev/null | grep -oE -- '(^|[ ,(])--?[a-zA-Z][a-zA-Z-]*' | grep -oE -- '--?[a-zA-Z][a-zA-Z-]*' | sort -u | tr '\\n' ' ')"
      _keel_flags_cache+=("$key=$flags")
    fi
    COMPREPLY=( $(compgen -W "$flags" -- "$cur") )
    return
  fi
  case "$cmd" in
    show|logs|stop|attach|approve|export|resume|send)
      [ "$COMP_CWORD" -eq 2 ] && COMPREPLY=( $(compgen -W "$(keel sessions --ids 2>/dev/null)" -- "$cur") ) ;;
    import) [ "$COMP_CWORD" -eq 2 ] && COMPREPLY=( $(compgen -W "list harnesses folders preview run batch index" -- "$cur") ) ;;
    login|logout) [ "$COMP_CWORD" -eq 2 ] && COMPREPLY=( $(compgen -W "xai" -- "$cur") ) ;;
    plugin) [ "$COMP_CWORD" -eq 2 ] && COMPREPLY=( $(compgen -W "check" -- "$cur") ) ;;
    service) [ "$COMP_CWORD" -eq 2 ] && COMPREPLY=( $(compgen -W "install" -- "$cur") ) ;;
    completion) [ "$COMP_CWORD" -eq 2 ] && COMPREPLY=( $(compgen -W "bash" -- "$cur") ) ;;
    help) [ "$COMP_CWORD" -eq 2 ] && COMPREPLY=( $(compgen -W "@COMMANDS@" -- "$cur") ) ;;
    open|serve) COMPREPLY=( $(compgen -d -- "$cur") ) ;;
  esac
}
complete -o default -F _keel keel
`;

export async function completion(argv: string[]): Promise<number> {
  if (argv[0] === "--help" || argv[0] === "-h") return (console.log("keel completion bash\n  Prints the bash completion script. Load it with: source <(keel completion bash)\n  or save it: keel completion bash > ~/.local/share/bash-completion/completions/keel"), 0);
  if (argv[0] !== "bash") return (console.error("keel completion: only bash is supported: keel completion bash"), 3);
  process.stdout.write(BASH.replaceAll("@COMMANDS@", COMMAND_NAMES.filter((n) => n !== "help").concat("help").join(" ")));
  return 0;
}

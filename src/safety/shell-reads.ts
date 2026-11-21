// The allow-list behind the shell classifier: programs and subcommands that
// only read, each with what makes it write a file, run a program or send data
// (from its manual page, named in the comment). A program is here only when
// every form the entry lets through changes nothing: no file, no process, no
// request to another machine. Pure data and functions.

// How a program is judged:
// - true: nothing it can be given writes, runs or sends (its options only
//   choose what to print), so its arguments may be anything, expansions too;
// - { short, long }: it reads unless one of these options is given. `short`
//   are option letters, looked for in every single-dash word; `long` are GNU
//   long options, which may be cut short (--out is --output). Its operands are
//   only read, and `--` ends its options;
// - a function of its arguments (none of them made by an expansion): an
//   allow-list of the forms that read.
export type Reader = true | { short?: string; long?: string[] } | ((args: string[]) => boolean);

// A GNU long option, which may be cut short as far as it stays one option: --out is --output.
export const long = (a: string, ...names: string[]) => {
  if (!a.startsWith("--") || a.length < 3) return false;
  const given = a.slice(2).split("=")[0]!;
  return names.some((n) => n.startsWith(given));
};

// Whether one of the options a table entry names is among the arguments.
export const denied = (r: { short?: string; long?: string[] }, args: string[]) =>
  args.some((a) => (a.startsWith("--") ? !!r.long && long(a, ...r.long) : a.startsWith("-") && !!r.short && [...a.slice(1)].some((c) => r.short!.includes(c))));

const every = (re: RegExp) => (args: string[]) => args.every((a) => re.test(a));
// Its first argument is one of these subcommands or actions, and nothing after it is an option.
const first = (re: RegExp) => (args: string[]) => re.test(args[0] ?? "") && args.slice(1).every((a) => !a.startsWith("-"));

// Operands past the options that take a value in the next word (`valued`, as letters).
function countOperands(args: string[], valued: string): number {
  let n = 0;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") return n + args.length - i - 1;
    if (a.startsWith("-") && a !== "-") { if (a.length === 2 && valued.includes(a[1]!)) i++; continue; }
    n++;
  }
  return n;
}

// tar(1): a listing. -t with -v, -z, -j, -J, -a and -f only; every other
// option is refused, as --to-command, --use-compress-program (-I),
// --checkpoint-action, --info-script (-F) and --rsh-command run a program,
// --index-file writes one, and an archive named host:file is read over rsh.
function tarLists(args: string[]): boolean {
  let lists = false;
  let files = 0; // archive names still to come, one per f
  let i = 0;
  const cluster = (letters: string): boolean => {
    if (!/^[tvzjJaf]+$/.test(letters)) return false;
    lists ||= letters.includes("t");
    files += letters.split("f").length - 1;
    return true;
  };
  if (args[0] && !args[0].startsWith("-")) { if (!cluster(args[0])) return false; i = 1; }
  for (; i < args.length; i++) {
    const a = args[i]!;
    if (files) { if (a.includes(":") || a.startsWith("-")) return false; files--; continue; }
    if (a === "--list") lists = true;
    else if (a.startsWith("--file=")) { if (a.includes(":")) return false; }
    else if (/^--(verbose|gzip|gunzip|bzip2|xz|zstd|auto-compress|force-local|utc|full-time|numeric-owner)$/.test(a)) continue;
    else if (a.startsWith("-")) { if (a.startsWith("--") || !cluster(a.slice(1)) || (a.includes("f") && !a.endsWith("f"))) return false; }
  }
  return lists && !files;
}

// gzip(1), gunzip(1): -c writes to standard output and keeps the file, -l
// lists, -t tests. Without one of them the file is replaced. A letter after
// -S or -b in the same word is that option's value (-Sc is the suffix c).
const gzipKeeps = (args: string[]) => args.some((a) => /^-[^-Sb]*[clt]/.test(a) || /^--(stdout|to-stdout|list|test)$/.test(a));

// ip(8): OBJECT with no command, or show, list, lst, get. Every object also
// takes add, del, set, flush, change and replace, and `ip netns exec` and
// -batch run commands; ip takes any prefix of a command, so `ip link s` is set.
function ipShows(args: string[]): boolean {
  let i = 0;
  while (i < args.length && args[i]!.startsWith("-")) {
    if (!/^-(4|6|0|br|brief|c|color|j|json|p|pretty|s|stats|statistics|d|details|o|oneline|h|human|human-readable|iec)$/.test(args[i]!)) return false;
    i++;
  }
  const [object, command] = args.slice(i);
  if (!object || !/^(a|addr|address|l|link|r|ro|route|n|neigh|neighbor|neighbour|ru|rule|maddr|maddress)$/.test(object)) return false;
  return command === undefined || /^(show|list|lst|sh)$/.test(command) || (command === "get" && /^r/.test(object));
}

// docker(1): the subcommands that list or print. An option before
// the subcommand is refused (-H, --host, --context and --config choose another
// daemon). `docker compose` is not here: loading a project can fetch what its
// file includes from a registry or a git remote.
const DOCKER_SUB = /^(ps|images|version|info|inspect|logs|top|port|history|diff|stats)$/;
const DOCKER_GROUP: Record<string, RegExp> = {
  image: /^(ls|list|inspect|history)$/, container: /^(ls|list|ps|inspect|logs|top|port|diff|stats)$/, volume: /^(ls|list|inspect)$/,
  network: /^(ls|list|inspect)$/, context: /^(ls|list|show|inspect)$/, system: /^(df|info)$/,
};
const dockerReads = (args: string[]) => {
  const [a, b] = args;
  if (!a) return false;
  if (args.length === 1 && a === "--version") return true;
  return DOCKER_SUB.test(a) || (Object.hasOwn(DOCKER_GROUP, a) && DOCKER_GROUP[a]!.test(b ?? ""));
};

// systemctl(1): the subcommands that print. -H and -M reach another machine or
// a container, --root and --image another tree: only the options below pass.
const SYSTEMCTL_SUB = /^(status|show|cat|list-units|list-unit-files|list-timers|list-sockets|list-jobs|list-dependencies|is-active|is-enabled|is-failed|is-system-running|get-default|show-environment)$/;
const SYSTEMCTL_FLAG = /^(--user|--system|--no-pager|--full|--all|--no-legend|--plain|--failed|--value|--quiet|--reverse|--after|--before|--recursive|-[lanotpqr]+|-n\d+|--(lines|output|type|state|property)=[\w,.@:-]+)$/;
// Before the subcommand only options that take no value, so the first word that is not an option is the subcommand.
const SYSTEMCTL_FIRST = /^(--user|--system|--no-pager|--full|--all|--no-legend|--plain|--failed|--quiet|-l|-a|-q)$/;
function systemctlReads(args: string[]): boolean {
  let i = 0;
  while (i < args.length && args[i]!.startsWith("-")) if (!SYSTEMCTL_FIRST.test(args[i++]!)) return args.length === 1 && args[0] === "--version";
  return SYSTEMCTL_SUB.test(args[i] ?? "") && args.slice(i + 1).every((a) => !a.startsWith("-") || SYSTEMCTL_FLAG.test(a));
}

// journalctl(1): reading the journal. --vacuum-*, --rotate, --flush, --sync,
// --relinquish-var, --setup-keys and --update-catalog change it, --cursor-file
// writes a file, -M, -D, --root, --file and --image read another one.
const JOURNALCTL_FLAG = /^(--user|--system|--follow|--reverse|--dmesg|--no-pager|--catalog|--quiet|--all|--full|--no-full|--no-hostname|--no-tail|--utc|--list-boots|--disk-usage|--version|--boot|-[frkxqalenb0-9]*[upSUogt]?|--(lines|unit|user-unit|boot|priority|since|until|output|grep|identifier)=.+)$/;
const journalctlReads = (args: string[]) => args.every((a) => (a.startsWith("-") ? JOURNALCTL_FLAG.test(a) : true));

function readsNames(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-d") { i++; continue; }
    if (!/^(-[rs]+|[a-z_][a-z0-9_]*)$/.test(args[i]!)) return false;
  }
  return true;
}

// Programs that print their version and stop when it is their only argument.
// Not here: cargo and rustc (a rustup shim installs the toolchain a project
// pins), go (it downloads the toolchain go.mod names), pnpm and yarn (corepack
// downloads the pinned one), npm (every npm command writes a log under ~/.npm),
// java (it writes hsperfdata under the temporary folder), gh (it writes a
// device id under ~/.local/state on its first run).
const version = (...flags: string[]) => (args: string[]) => args.length === 1 && flags.includes(args[0]!);

export const READERS = new Map<string, Reader>([
  // coreutils(1) and util-linux: filters and printers with no option that names an output file.
  ...["seq", "sleep", "tac", "rev", "paste", "comm", "join", "fold", "expand", "unexpand", "fmt", "pr", "od", "hexdump", "hd", "strings", "expr", "numfmt", "factor",
    "tsort", "yes", "look", "bc"].map((p): [string, Reader] => [p, true]),
  // Checksums: -c reads a list of sums and checks it.
  ...["sha1sum", "sha224sum", "sha384sum", "sha512sum", "b2sum", "cksum", "sum", "shasum"].map((p): [string, Reader] => [p, true]),
  // The machine, its users and its processes, as the kernel and the system databases show them.
  ...["arch", "groups", "users", "who", "w", "logname", "tty", "getconf", "locale", "whereis", "lscpu", "lsblk", "lsusb", "lsmem", "lsns", "lsmod", "lsattr", "namei",
    "findmnt", "netstat", "pgrep", "pidof", "pstree", "pwdx", "vmstat", "iostat", "mpstat"].map((p): [string, Reader] => [p, true]),
  // zcat(1), bzcat(1), xzcat(1): gzip -cd, bzip2 -dc and xz -dc, which no later option turns back into writing a file.
  // zgrep is not here: it is a shell script that evaluates its arguments and writes a temporary file for -f.
  ...["zcat", "bzcat", "xzcat", "zipinfo", "dpkg-query"].map((p): [string, Reader] => [p, true]),
  // bash(1) builtins that print, wait or move between directories as cd does.
  ...[":", "exit", "help", "dirs", "pushd", "popd"].map((p): [string, Reader] => [p, true]),
  // wait -p NAME gives a variable a value, and a subscript in the name is evaluated.
  ["wait", every(/^(-[nf]+|%?\d+|%[%+-]?)$/)],
  // history: -c and -d delete entries, -w, -a, -r and -n write or read the history file, -s adds an entry.
  ["history", (a) => a.length === 0 || (a.length === 1 && /^\d+$/.test(a[0]!))],
  // jobs -x COMMAND runs it.
  ["jobs", every(/^-[lnprs]+$/)],
  // ulimit, umask, set and alias with a value change the shell the rest of the line runs in.
  ["ulimit", every(/^-[HSa-zR]+$/)], ["umask", every(/^-[pS]+$/)], ["set", (a) => a.length === 0], ["alias", every(/^-p$/)],
  // read NAME...: a name with a subscript is evaluated (a[$(cmd)] runs cmd), and a name in capitals may be one the
  // shell or a program reads (HOME, PATH, IFS): plain names in small letters only. -d takes a delimiter.
  ["read", readsNames],

  // shuf(1): -o FILE, --output=FILE.
  ["shuf", { short: "o", long: ["output"] }],
  // base64(1): GNU has no output option; the BSD and macOS one takes -o FILE, --output=FILE.
  ["base64", { short: "o", long: ["output"] }], ["base32", { short: "o", long: ["output"] }], ["basenc", { short: "o", long: ["output"] }],
  // ss(8): -K, --kill closes sockets; -D FILE, --diag=FILE writes a dump.
  ["ss", { short: "KD", long: ["kill", "diag"] }],
  // dmesg(1): -C, -c clear the ring buffer; -D, -E and -n change what the console prints.
  ["dmesg", { short: "CcDEn", long: ["clear", "read-clear", "console-off", "console-on", "console-level"] }],
  // lspci(8): -q and -Q ask the PCI ID database over DNS and keep the answers in ~/.pciids-cache.
  ["lspci", { short: "qQ" }],

  // xxd(1): xxd [options] [infile [outfile]]: a second operand is the file it writes. -c, -g, -l, -o and -s take a value.
  ["xxd", (a) => countOperands(a, "cglos") <= 1],
  ["gzip", gzipKeeps], ["gunzip", gzipKeeps],
  // zstdcat(1): zstd -dcf, but a later -o FILE wins over -c, and --rm deletes the source: operands only.
  ["zstdcat", (a) => a.every((x) => !x.startsWith("-"))],
  ["tar", tarLists],
  // unzip(1): -l and -v list, -t tests, -z prints the archive comment, -Z is zipinfo. Any other first option extracts.
  ["unzip", first(/^-(l|lv|vl|v|t|tq|qt|lq|ql|z|Z[12smlvhtTz]*)$/)],
  // getent(1): the local databases. hosts, ahosts and networks ask a name server; shadow and gshadow hold password hashes.
  ["getent", first(/^(passwd|group|services|protocols|shells)$/)],
  // tput(1): the terminal's size and name. init, reset, clear and the rest write control sequences to it.
  ["tput", (a) => a.length === 1 && /^(cols|lines|colors|longname)$/.test(a[0]!)],
  // stty(1): printing the settings. Any other operand changes them.
  ["stty", (a) => a.length === 1 && /^(size|-a|--all|-g|--save)$/.test(a[0]!)],
  // mount(8): with no argument, or -l, it lists what is mounted.
  ["mount", (a) => a.length === 0 || (a.length === 1 && a[0] === "-l")],
  ["ip", ipShows],
  // sysctl(8): -w and name=value set a parameter, -p, -f and --system load a file of them.
  ["sysctl", every(/^(-[aAXnNeqbd]+|--all|--values|--names|--ignore|--quiet|--binary|[a-zA-Z][\w./-]*)$/)],
  // nvidia-smi(1): queries. -r resets a GPU, -pm, -c, -e, -pl and --gom change a setting, -f FILE writes one.
  ["nvidia-smi", every(/^(-L|--list-gpus|-q|--query|-x|--xml-format|--query-(gpu|compute-apps|accounted-apps|retired-pages)=[\w.,]+|--format=[\w,]+|--id=[\w,-]+|--version)$/)],
  // dpkg(1): the query actions. -i, -r, -P, --configure, --unpack and the rest change the system.
  ["dpkg", first(/^(-l|--list|-L|--listfiles|-s|--status|-S|--search|-c|--contents|-I|--info|-p|--print-avail|--get-selections|--print-architecture|--version)$/)],
  // apt(8), apt-cache(8): the listing and search subcommands. -o sets any configuration item and -c reads a configuration file: refused.
  ["apt", (a) => /^(list|show|search|policy|depends|rdepends)$/.test(a[0] ?? "") && a.slice(1).every((x) => !x.startsWith("-") || /^(--installed|--upgradable|--upgradeable|--all-versions|--manual-installed|--names-only|--full|-a|-n|-f)$/.test(x))],
  ["apt-cache", first(/^(show|search|policy|depends|rdepends|showpkg|showsrc|pkgnames|madison|stats)$/)],
  // pip(1): show and freeze read the environment. list is not here: it asks the index for a newer pip and keeps the answer.
  ...["pip", "pip3"].map((p): [string, Reader] => [p, (a) => (a.length === 1 && /^(--version|-V)$/.test(a[0]!)) || (/^(show|freeze)$/.test(a[0] ?? "") && a.slice(1).every((x) => !x.startsWith("-") || /^(-f|--files|-v|--verbose|-l|--local|--user|--all)$/.test(x)))]),
  ["docker", dockerReads],
  ["systemctl", systemctlReads],
  ["journalctl", journalctlReads],

  ...["node", "bun"].map((p): [string, Reader] => [p, version("--version", "-v")]),
  ...["python", "python3", "uv", "curl", "wget"].map((p): [string, Reader] => [p, version("--version", "-V")]),
  ...["ruby", "gcc", "g++", "cc", "clang", "clang++", "make", "cmake", "bash", "zsh"].map((p): [string, Reader] => [p, version("--version")]),
  ["openssl", version("version")], ["ssh", version("-V")],
]);

// The readers that are programs on disk (not shell builtins): what xargs and find -exec can run.
const BUILTINS = new Set([":", "exit", "help", "dirs", "pushd", "popd"]);
export const anyArguments = (prog: string) => READERS.get(prog) === true && !BUILTINS.has(prog);

// xargs(1): it runs the command it is given with arguments read from its
// input, so only a program that reads whatever its arguments are. -o opens the
// terminal and -p asks there: refused, with what is not known.
export function xargsCommand(args: string[]): string[] | null {
  let i = 0;
  for (; i < args.length && args[i]!.startsWith("-"); i++) {
    const a = args[i]!;
    if (/^-[0rtx]+$/.test(a) || /^--(null|no-run-if-empty|verbose|exit)$/.test(a)) continue;
    if (/^-[nLPsEIda]$/.test(a)) { i++; continue; }
    if (/^-[nLPsEId].+$/.test(a) || /^--(max-args|max-lines|max-procs|max-chars|delimiter|arg-file|replace)=/.test(a)) continue;
    return null;
  }
  return args.slice(i);
}

// Programs whose options end at `--`, each with the options that take no value: a `--` that stands after one of
// them (or after an operand) is the end of the options, while after any other option it may be that option's value.
export const ENDS = new Map<string, RegExp>([
  ["sort", /^-[bdfghiMnRrVcCmsuz]+$/],
  ["rg", /^(-[cFHhiLlNnoPSsUuvwxz.]+|--[a-z-]+=.*|--(files|hidden|no-ignore|json|count|ignore-case|smart-case|case-sensitive|line-number|no-line-number|files-with-matches|files-without-match|fixed-strings|word-regexp|line-regexp|invert-match|only-matching|no-heading|heading|multiline|pcre2|follow|null|stats|trim|vimgrep|column|no-filename|with-filename))$/],
  ["fd", /^(-[HIaLlpsiugF01]+|--[a-z-]+=.*|--(hidden|no-ignore|absolute-path|follow|list-details|full-path|case-sensitive|ignore-case|glob|fixed-strings|print0))$/],
  ["file", /^(-[bhiLkrsz0NnS]+|--(brief|mime|mime-type|mime-encoding|dereference|no-dereference|keep-going|uncompress|print0|raw))$/],
  ["shuf", /^(-[erz]+|--(echo|repeat|zero-terminated))$/],
  ...["base64", "base32", "basenc"].map((p): [string, RegExp] => [p, /^(-[di]+|--(decode|ignore-garbage|base64|base64url|base32|base32hex|base16|z85))$/]),
]);

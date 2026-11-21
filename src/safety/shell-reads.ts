// The allow-list behind the shell classifier: programs and subcommands that
// only read, each with what makes it write a file, run a program or send data
// (from its manual page, named in the comment). A program is here only when
// every form the entry lets through changes nothing: no file, no process, no
// request to another machine. Pure data and functions.
//
// Four things every entry answers, from the program's manual page:
// (a) cut-short options: getopt_long and optparse take any unique prefix of a
//     long option, so a list of refused options matches by prefix (--out is
//     --output) and a list of allowed ones is matched whole;
// (b) options that take a value: the next word is that value whatever it looks
//     like (gzip -S -c: the suffix is -c). An entry that looks for a reading
//     option names the exact forms it takes; none scans for one;
// (c) what follows `--`, and in a program that does not reorder its arguments
//     what follows the first operand, is an operand (xxd a -b writes -b);
// (d) a name where an address goes is looked up on the network (ss dst NAME):
//     only numbers are let through.
// A read may never end (yes, sleep 1d, journalctl -f, vmstat 1): it runs until
// the tool's timeout, as tail -f always did.

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

// xxd(1): xxd [options] [infile [outfile]]: a second operand is the file it writes. Its options end at the first
// operand or at `--`; what follows is an operand whatever it looks like (xxd a -b writes a file named -b). An
// option is known by its first letter (-c, -cols, --cols); -c, -g, -l, -o, -s, -n and -R take a value, written on
// or in the next word.
function xxdReads(args: string[]): boolean {
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i]!.replace(/^--(?=.)/, "-");
    if (a === "-") break; // standard input, an operand
    if (args[i] === "--") { i++; break; }
    if (!a.startsWith("-")) break;
    if (/^-(a|b|e|u|p|i|r|E|C|d|capitalize)/.test(a)) continue;
    const valued = /^-(cols|c|groupsize|g|len|l|offset|o|seek|s|name|n|R)(.*)$/.exec(a);
    if (!valued) return false;
    if (!valued[2] && ++i >= args.length) return false;
  }
  return args.length - i <= 1;
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

// gzip(1), gunzip(1): -c writes to standard output and keeps the file, -l lists, -t tests. Without one of them
// the file is replaced. -S, --suffix and -b take the next word as their value (gzip -S -c a writes a-c), so the
// first word must be the one with -c, -l or -t, and every other option is one of those below, which take none.
// After `--` every word is a file.
const GZIP_FLAG = /^(-[cdfklnNqrtv1-9]+|--(stdout|to-stdout|list|test|decompress|uncompress|keep|force|verbose|quiet|no-name|name|recursive|fast|best))$/;
function gzipKeeps(args: string[]): boolean {
  if (!/^(-[cdfklnNqrtv1-9]*[clt][cdfklnNqrtv1-9]*|--(stdout|to-stdout|list|test))$/.test(args[0] ?? "")) return false;
  for (const a of args) {
    if (a === "--") return true;
    if (a.startsWith("-") && a !== "-" && !GZIP_FLAG.test(a)) return false;
  }
  return true;
}

// ss(8): -K closes sockets, -D FILE writes a dump, -F FILE reads a filter, -r and any word of a filter that is
// not a keyword or a number are looked up on the name server (ss dst NAME sends NAME there), -N enters another
// network namespace. Let through: the options below, -f and -A with their value, and a filter made of the state
// keywords, numeric addresses after src and dst, and numeric ports after sport and dport.
const SS_FLAG = /^(-[HOnaloempTis460tudwxS]+|--(no-header|oneline|numeric|all|listening|options|extended|memory|processes|threads|info|summary|ipv4|ipv6|packet|tcp|udp|dccp|raw|unix|sctp|mptcp|version)|--(family|query)=[a-z0-9_,]+)$/;
const SS_STATE = /^(all|connected|synchronized|bucket|big|established|syn-sent|syn-recv|fin-wait-1|fin-wait-2|time-wait|closed|close-wait|last-ack|listening|closing)$/;
const OCTET = "(25[0-5]|2[0-4]\\d|1?\\d?\\d)";
// An IPv4 address or prefix, an IPv6 one in brackets or `*`, with a port number; or a port number alone.
const SS_ADDR = new RegExp(`^((${OCTET}(\\.${OCTET}){0,3}|\\[[0-9a-fA-F:]+\\]|\\*)(/\\d{1,3})?(:\\d{1,5})?|:\\d{1,5})$`);
function ssReads(args: string[]): boolean {
  let i = 0;
  for (; i < args.length && args[i]!.startsWith("-"); i++) {
    if ((args[i] === "-f" || args[i] === "-A") && /^[a-z0-9_,]+$/.test(args[i + 1] ?? "")) i++;
    else if (!SS_FLAG.test(args[i]!)) return false;
  }
  // The filter is read as one text, however it is split into words.
  const filter = args.slice(i).join(" ").replace(/[()]/g, " $& ").split(/\s+/).filter((t) => t);
  for (let k = 0; k < filter.length; k++) {
    const t = filter[k]!;
    if (/^(and|or|not|[()!&|]|&&|\|\|)$/.test(t)) continue;
    if (t === "state" || t === "exclude") { if (!SS_STATE.test(filter[++k] ?? "")) return false; }
    else if (t === "src" || t === "dst") { if (!SS_ADDR.test(filter[++k] ?? "")) return false; }
    else if (t === "sport" || t === "dport") {
      if (/^(=|==|!=|eq|ne|neq|gt|ge|geq|lt|le|leq|[<>]=?)$/.test(filter[k + 1] ?? "")) k++;
      if (!/^:?\d{1,5}$/.test(filter[++k] ?? "")) return false;
    } else return false;
  }
  return true;
}

// lsof(8): -i [46][protocol][@host][:port] looks a host name up on the name server (lsof -i @NAME sends NAME
// there): only an address in numbers. -D builds or updates a device cache file where lsof has one. An option's
// letters are read up to the first that takes a value; the rest of the word is that value.
function lsofReads(args: string[]): boolean {
  for (const a of args) {
    for (const m of a.matchAll(/@(\[[^\]]*\]|[^:]*)/g)) if (!SS_ADDR.test(m[1]!) || m[1] === "*") return false;
    if (!a.startsWith("-")) continue;
    for (const c of a.slice(1)) {
      if (c === "D") return false;
      if (!"abChlnNOPRtUvVwX".includes(c)) break;
    }
  }
  return true;
}

// pip(1): show and freeze read the environment; list asks the index for a newer pip and keeps the answer. optparse
// takes cut-short options (pip show --local x is --local-log x and writes x), so each subcommand's own options
// are matched whole.
const PIP_FLAG: Record<string, RegExp> = { show: /^(-f|--files|-v|--verbose)$/, freeze: /^(-l|--local|--user|--all)$/ };
function pipReads(args: string[]): boolean {
  if (args.length === 1 && /^(--version|-V)$/.test(args[0]!)) return true;
  const flag = Object.hasOwn(PIP_FLAG, args[0] ?? "") ? PIP_FLAG[args[0]!]! : null;
  return !!flag && args.slice(1).every((a) => (a.startsWith("-") ? flag.test(a) : args[0] === "show"));
}

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

// docker(1): the subcommands that list or print, each option matched whole: the ones below choose and format
// what is printed, and none names a file. -H, --host, --context and --config choose another daemon and are
// refused before the subcommand and after it. `docker top` hands what follows the container to ps. `docker
// compose` is not here: loading a project can fetch what its file includes from a registry or a git remote.
const DOCKER_SUB = /^(ps|images|version|info|inspect|logs|top|port|history|diff|stats)$/;
const DOCKER_GROUP: Record<string, RegExp> = {
  image: /^(ls|list|inspect|history)$/, container: /^(ls|list|ps|inspect|logs|top|port|diff|stats)$/, volume: /^(ls|list|inspect)$/,
  network: /^(ls|list|inspect)$/, context: /^(ls|list|show|inspect)$/, system: /^(df|info)$/,
};
const DOCKER_FLAG = /^(-[aflnqstv]+|--(all|latest|no-trunc|quiet|size|digests|tree|details|follow|timestamps|no-stream|human|verbose)|--(filter|format|last|since|tail|until|type)(=.*)?)$/;
const dockerReads = (args: string[]) => {
  const [a, b] = args;
  if (!a) return false;
  if (args.length === 1 && a === "--version") return true;
  const grouped = Object.hasOwn(DOCKER_GROUP, a) && DOCKER_GROUP[a]!.test(b ?? "");
  if (!grouped && !DOCKER_SUB.test(a)) return false;
  const rest = args.slice(grouped ? 2 : 1);
  // What follows the container of `top` are options of ps, which only prints.
  const own = (grouped ? b : a) === "top" ? rest.slice(0, 1) : rest;
  return own.every((x) => !x.startsWith("-") || DOCKER_FLAG.test(x)) && !rest.some((x) => /^(-H|--host|--context|--config|--tls)/.test(x));
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

// A variable in small letters that the shell or a program reads for itself: giving it a value changes what the rest of the line does.
export const KEPT = /^(histchars|auto_resume|[a-z_]*_proxy)$/;

function readsNames(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-d") { i++; continue; }
    if (!/^(-[rs]+|[a-z_][a-z0-9_]*)$/.test(args[i]!) || KEPT.test(args[i]!)) return false;
  }
  return true;
}

// Programs that print their version and stop when it is their only argument.
// Not here: go (it downloads the toolchain go.mod names), pnpm and yarn (they
// download or run the version a project pins), npm (every npm command writes
// a log under ~/.npm), java (it writes hsperfdata under the temporary
// folder), gh (it writes a device id under ~/.local/state on its first run),
// curl (it opens a socket to the name server); node, bun, python, ruby, uv, cargo
// and the compilers (a version manager's shim under their name installs the
// version a project pins).
const version = (...flags: string[]) => (args: string[]) => args.length === 1 && flags.includes(args[0]!);

export const READERS = new Map<string, Reader>([
  // coreutils(1) and util-linux: filters and printers with no option that names an output file.
  ...["seq", "sleep", "tac", "rev", "paste", "comm", "join", "fold", "expand", "unexpand", "fmt", "pr", "od", "hexdump", "hd", "strings", "expr", "numfmt", "factor",
    "tsort", "yes", "look", "bc"].map((p): [string, Reader] => [p, true]),
  // Checksums: -c reads a list of sums and checks it.
  ...["sha1sum", "sha224sum", "sha384sum", "sha512sum", "b2sum", "cksum", "sum", "shasum"].map((p): [string, Reader] => [p, true]),
  // The machine, its users and its processes, as the kernel and the system databases show them.
  ...["groups", "users", "w", "logname", "tty", "getconf", "locale", "whereis", "lscpu", "lsblk", "lsusb", "lsmem", "lsns", "lsmod", "lsattr", "namei",
    "findmnt", "pgrep", "pidof", "pstree", "pwdx", "vmstat", "iostat", "mpstat"].map((p): [string, Reader] => [p, true]),
  // arch(1): it prints the machine's architecture. On macOS, with an argument, it runs a program (arch -arm64 CMD).
  ["arch", (a) => a.length === 0],
  // who(1): --lookup asks the name server for the hosts users logged in from.
  ["who", { long: ["lookup"] }],
  // netstat(8): without -n it looks every address up on the name server.
  // So the first word must hold -n, the rest are options too, and an operand is refused (on BSD -p and -w take one).
  ["netstat", (a) => /^(-[a-zA-Z0-9]*n|--numeric$)/.test(a[0] ?? "") && a.every((x) => /^(-[tuUwxlapeoirsgvWnS46]+|--(numeric|tcp|udp|listening|all|programs|extend|route|interfaces|statistics|groups|wide))$/.test(x))],
  ["lsof", lsofReads],
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
  ["ss", ssReads],
  // dmesg(1): -C, -c clear the ring buffer; -D, -E and -n change what the console prints.
  ["dmesg", { short: "CcDEn", long: ["clear", "read-clear", "console-off", "console-on", "console-level"] }],
  // lspci(8): -q and -Q ask the PCI ID database over DNS and keep the answers in ~/.pciids-cache.
  ["lspci", { short: "qQ" }],

  ["xxd", xxdReads],
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
  // Run as root they refresh the package cache under /var/cache/apt, as apt-get does.
  ["apt", (a) => /^(list|show|search|policy|depends|rdepends)$/.test(a[0] ?? "") && a.slice(1).every((x) => !x.startsWith("-") || /^(--installed|--upgradable|--upgradeable|--all-versions|--manual-installed|--names-only|--full|-a)$/.test(x))],
  ["apt-cache", first(/^(show|search|policy|depends|rdepends|showpkg|showsrc|pkgnames|madison|stats)$/)],
  ["pip", pipReads], ["pip3", pipReads],
  ["docker", dockerReads],
  ["systemctl", systemctlReads],
  ["journalctl", journalctlReads],

  ["bash", version("--version")], ["zsh", version("--version")], ["openssl", version("version")], ["ssh", version("-V")],
]);

// The readers that are programs on disk (not shell builtins): what xargs and find -exec can run.
const BUILTINS = new Set([":", "exit", "help", "dirs", "pushd", "popd"]);
export const anyArguments = (prog: string) => READERS.get(prog) === true && !BUILTINS.has(prog);

// xargs(1): it runs the command it is given with arguments read from its
// input, so only a program that reads whatever its arguments are. -o opens the
// terminal and -p asks there: refused, with what is not known. Its options
// are matched whole, each with where its value stands. A replacement string
// (-I) that occurs in the command's own name could rename it: refused.
export function xargsCommand(args: string[]): string[] | null {
  let i = 0;
  const replaced: string[] = [];
  for (; i < args.length && args[i]!.startsWith("-"); i++) {
    const a = args[i]!;
    if (/^-[0rtx]+$/.test(a) || /^--(null|no-run-if-empty|verbose|exit)$/.test(a)) continue;
    if (a === "-I") { replaced.push(args[++i] ?? ""); continue; }
    if (/^-[nLPsEda]$/.test(a)) { i++; continue; }
    if (/^-I.+$/.test(a)) { replaced.push(a.slice(2)); continue; }
    if (/^--replace=.+$/.test(a)) { replaced.push(a.slice(10)); continue; }
    if (/^-[nLPsEd].+$/.test(a) || /^--(max-args|max-lines|max-procs|max-chars|delimiter|arg-file)=/.test(a)) continue;
    return null;
  }
  const run = args.slice(i);
  return run[0] !== undefined && replaced.some((r) => !r || run[0]!.includes(r)) ? null : run;
}

// Programs whose options end at `--`, each with the options that take no value: a `--` that stands after one of
// them (or after an operand) is the end of the options, while after any other option it may be that option's value.
export const ENDS = new Map<string, RegExp>([
  ["sort", /^-[bdfghiMnRrVcCmsuz]+$/],
  ["rg", /^(-[cFHhiLlNnoPSsUuvwxz.]+|--[a-z-]+=.*|--(files|hidden|no-ignore|json|count|ignore-case|smart-case|case-sensitive|line-number|no-line-number|files-with-matches|files-without-match|fixed-strings|word-regexp|line-regexp|invert-match|only-matching|no-heading|heading|multiline|pcre2|follow|null|stats|trim|vimgrep|column|no-filename|with-filename))$/],
  ["fd", /^(-[HIaLlpsiugF01]+|--[a-z-]+=.*|--(hidden|no-ignore|absolute-path|follow|list-details|full-path|case-sensitive|ignore-case|glob|fixed-strings|print0))$/],
  ["file", /^(-[bhiLkrsz0NnS]+|--(brief|mime|mime-type|mime-encoding|dereference|no-dereference|keep-going|uncompress|print0|raw))$/],
  ["shuf", /^(-[erz]+|--(echo|repeat|zero-terminated))$/],
  // -i takes a file name in the BSD base64, so it is not among them.
  ...["base64", "base32", "basenc"].map((p): [string, RegExp] => [p, /^(-d|--(decode|base64|base64url|base32|base32hex|base16|z85))$/]),
]);

// The cause of a failed tool call, in a short list the ledger ranks by. A call's `error_class` is the shape of
// its message (paths and numbers folded), which is as many classes as there are messages; the cause is what the
// failure was about. The first rule that matches the kept line is the cause, the specific ones first.
export const TOOL_CAUSES = ["bad_input", "missing_file", "timeout", "network", "refused", "nonzero_exit", "other"] as const;
export type ToolCause = (typeof TOOL_CAUSES)[number];

const RULES: [ToolCause, RegExp][] = [
  // The call's own input: a field missing or unknown, a tool that does not exist, an agent that is not in the tree, an edit
  // whose old text is not in the file.
  ["bad_input", /input is invalid|required field|is not a field|No tool named|\binvalid (?:input|argument|parameter|value)\b|\bunknown (?:field|parameter|option)\b|^no agent "|^pid \d+ is no process|process \d+ has already ended|is at most \d+ characters|\bland: \"|old_string was not found|old_string appears|not unique in the file/i],
  ["missing_file", /does not exist|No such file or directory|\bENOENT\b|cannot access|FileNotFoundError|can't open file|cannot open|Cannot find module|file not found|no such (?:file|path|directory)/i],
  ["timeout", /\btimed? ?out\b|\bexit code 124\b|\bTimeout \d+ ?ms\b|\bETIMEDOUT\b|deadline exceeded|time limit/i],
  ["network", /\bECONN(?:RESET|REFUSED|ABORTED)\b|\bENOTFOUND\b|\bEAI_AGAIN\b|\bEHOSTUNREACH\b|connection (?:reset|refused|closed|lost)|Unable to connect|could not resolve host|network is unreachable|\bgetaddrinfo\b|socket hang up|\bHTTP [45]\d\d\b|\bstatus (?:code )?[45]\d\d\b|ssh: connect|certificate|\bTLS\b|no process of this session listens on/i],
  // The gate, a guard or a limit said no: a rule, the owner's answer, a file not read before it is written, no free slot.
  ["refused", /\b(?:refused|denied|not allowed|forbidden|not permitted|permission)\b|\bblocked\b|AGENT_LIMIT|exists and was not read|must be read first|read-only (?:mode|session)|has no write scope/i],
  // A command that ended with a status (the last line it printed and "(exit code N)"), with nothing more specific to say.
  ["nonzero_exit", /\(exit code \d+\)\s*$|^exit code \d+|\bexited with\b|\bnon-?zero\b|\bsignal: \w+|\bkilled by\b/i],
];

export function causeOf(error: string | null | undefined): ToolCause {
  const text = String(error ?? "");
  for (const [cause, re] of RULES) if (re.test(text)) return cause;
  return "other";
}

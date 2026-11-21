// The language a file is colored as, from its name.
const LANG: Record<string, string> = {
  py: "python", rs: "rust", md: "markdown", yml: "yaml", sh: "shell", bash: "shell", zsh: "shell", mjs: "js", cjs: "js",
  h: "c", hpp: "cpp", cc: "cpp", kt: "kotlin", rb: "ruby", jsonc: "json", lock: "plaintext",
};
export const langOf = (p: string) => {
  const name = p.split("/").pop()!.toLowerCase();
  if (name === "dockerfile") return "dockerfile";
  if (name === "makefile") return "makefile";
  const ext = name.includes(".") ? name.split(".").pop()! : "";
  return LANG[ext] ?? ext;
};

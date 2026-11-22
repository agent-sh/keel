// Words of the activity list that the page shares with the daemon's text
// form. No imports, so the page can load this file.

// What a turn's alert said, without the session's title the row already carries.
export function saidOf(a: { said?: string }, title: string | undefined): string {
  const said = a.said ?? "";
  if (!said) return "";
  const at = title ? said.indexOf(`${title}: `) : -1;
  return (at >= 0 && at <= 40 ? said.slice(at + title!.length + 2) : said).trim();
}

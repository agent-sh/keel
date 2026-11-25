// Rows of a CSV or TSV text: quoted fields may hold the delimiter, quotes ("" is one) and line
// breaks. Stops after `max` rows, so a long text is read only as far as is shown.
export function parseTable(text: string, delimiter: string, max: number): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length && rows.length < max; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') { field += '"'; i++; }
      else quoted = false;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === delimiter) { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      rows.push(row); row = [];
    } else field += c;
  }
  if (rows.length < max && (field !== "" || row.length)) { row.push(field); rows.push(row); }
  return rows;
}

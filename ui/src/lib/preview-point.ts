// What the element picker of a preview hands the message box. The words come
// from the frame, whose page is not Keel's: they are taken only while the
// owner is picking (the picker is on, the pointer is over the frame), kept
// short and on one line, and put inside a sentence that says where they are
// from. A page that posts by itself puts nothing in the message box.
const line = (v: unknown, max: number): string => String(v ?? "").replace(/[\u0000-\u001f\u007f`]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

// `said`: the frame's message. `port`: the port the panel shows (known to the page, not taken
// from the frame). `on`: where it runs when that is another machine.
export function pointSeed(said: { selector?: unknown; text?: unknown; url?: unknown }, port: number, on: string, by: { picking: boolean; over: boolean }): string | null {
  if (!by.picking || !by.over) return null;
  const selector = line(said.selector, 200);
  if (!selector) return null;
  // The dev server's own address, not the portal's (its key stays out of the conversation).
  const path = (/^https?:\/\/[^/]+\/(?:portal|fleet-portal\/[^/]+)\/[^/]+\/\d+\/[^/]+(\/[\w\-./~%]*)/.exec(String(said.url ?? ""))?.[1] ?? "").slice(0, 120);
  const text = line(said.text, 120).replace(/"/g, "'");
  return `In the preview (http://127.0.0.1:${port}${path}${on ? ` on ${on}` : ""}), the element \`${selector}\`${text ? ` ("${text}")` : ""}: `;
}

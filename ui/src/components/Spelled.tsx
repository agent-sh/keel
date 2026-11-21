// Text that is to be approved, with every character a reader could not see
// spelled out and marked (lib/hidden-chars.ts): a right-to-left override, a
// zero-width space or a control never changes what the text looks like.
import { spellHidden } from "../lib/hidden-chars.ts";

export function Spelled({ text }: { text: string }) {
  const pieces = spellHidden(text);
  if (pieces.length === 1 && !pieces[0]!.hidden) return <>{text}</>;
  return (
    <>
      {pieces.map((p, i) => (p.hidden
        ? <mark key={i} className="rounded-sm bg-danger-soft px-0.5 text-danger" title={`A hidden character: ${p.hidden.name}`} data-testid="hidden-char">{p.hidden.shown}</mark>
        : <span key={i}>{p.text}</span>))}
    </>
  );
}

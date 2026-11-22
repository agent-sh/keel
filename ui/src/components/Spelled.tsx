// Text that is to be approved, with every character a reader could not see
// spelled out and marked (lib/hidden-chars.ts): a right-to-left override, a
// zero-width space or a control never changes what the text looks like.
import { rtlRuns, spellHidden } from "../lib/hidden-chars.ts";

// Plain text with each run of letters written right to left set apart (bdi): the run reads as
// it is written, and the text around it keeps its order.
function Runs({ text }: { text: string }) {
  const runs = rtlRuns(text);
  if (runs.length === 1 && !runs[0]!.rtl) return <>{text}</>;
  return <>{runs.map((r, i) => (r.rtl ? <bdi key={i} dir="rtl" data-testid="rtl-run">{r.text}</bdi> : r.text))}</>;
}

// `shown`: the owner asked to see the marks: each is ringed.
export function Spelled({ text, shown }: { text: string; shown?: boolean }) {
  const pieces = spellHidden(text);
  if (pieces.length === 1 && !pieces[0]!.hidden) return <Runs text={text} />;
  return (
    <>
      {pieces.map((p, i) => (p.hidden
        ? <mark key={i} className={shown ? "rounded-sm bg-danger-soft px-0.5 text-danger ring-2 ring-danger" : "rounded-sm bg-danger-soft px-0.5 text-danger"} title={`A hidden character: ${p.hidden.name}`} data-testid="hidden-char">{p.hidden.shown}</mark>
        : <span key={i}><Runs text={p.text} /></span>))}
    </>
  );
}

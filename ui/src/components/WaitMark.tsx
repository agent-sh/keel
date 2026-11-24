// A call's line while its card is open says only that it waits: the card holds what it waits for
// (the command, the question), so the line would say it a second time. A violet diamond, the shape the
// session list uses for what needs the owner; its words are for a screen reader and a tooltip.
export function WaitMark({ words, testid }: { words: string; testid?: string }) {
  return <span className="k-line-wait" role="img" aria-label={words} title={words} data-testid={testid} />;
}

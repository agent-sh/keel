import { useMemo } from "react";
import { parseAnsi } from "../../../src/core/ansi.ts";
import { cn } from "../lib/utils.ts";

// Terminal output with the program's colors (see src/core/ansi.ts).
export function Ansi({ text }: { text: string }) {
  const segs = useMemo(() => parseAnsi(text), [text]);
  return (
    <>
      {segs.map((s, i) =>
        s.fg || s.bg || s.bold || s.dim || s.italic || s.underline ? (
          <span key={i} style={{ color: s.fg, backgroundColor: s.bg }} className={cn(s.bold && "font-semibold", s.dim && "opacity-70", s.italic && "italic", s.underline && "underline")}>{s.text}</span>
        ) : (
          s.text
        ),
      )}
    </>
  );
}

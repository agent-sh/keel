import { Marked } from "marked";
import { memo, useMemo } from "react";

// Raw HTML in model output is shown as text, never rendered: the renderer
// escapes every html token, so the output needs no sanitizer.
const md = new Marked({ gfm: true, breaks: false });
md.use({
  renderer: {
    html({ text }) {
      return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    },
    link({ href, title, tokens }) {
      const safe = /^(https?:|mailto:|#|\/)/i.test(href) ? href : "#";
      const t = title ? ` title="${title.replace(/"/g, "&quot;")}"` : "";
      return `<a href="${safe.replace(/"/g, "%22")}"${t} target="_blank" rel="noreferrer">${this.parser.parseInline(tokens)}</a>`;
    },
  },
});

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const html = useMemo(() => md.parse(text, { async: false }) as string, [text]);
  return <div className="prose-keel" dangerouslySetInnerHTML={{ __html: html }} />;
});

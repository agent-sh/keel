// Loaded on first use (a dynamic import): TeX to MathML, which the browser
// draws natively, so no math fonts or stylesheet ship with the page.
import temml from "temml";

export function mathMl(tex: string, display: boolean): string {
  return temml.renderToString(tex, { displayMode: display, throwOnError: false, annotate: true });
}

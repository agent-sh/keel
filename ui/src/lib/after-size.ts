// A fit that writes to the page (an attribute, a hidden part) must not run inside a ResizeObserver's own call:
// what it writes changes the size of the elements the observer watches, and the browser cannot tell the
// observer of that in the same pass. It reports the change as an error ("ResizeObserver loop completed with
// undelivered notifications"). `afterSize` is the callback to give the observer: it reads nothing and runs
// the fit in the next frame, once for any number of calls before it. `stop` cancels a fit still waiting.
export function afterSize(fit: () => void): { (): void; stop: () => void } {
  let frame = 0;
  const later = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(fit); };
  later.stop = () => cancelAnimationFrame(frame);
  return later;
}

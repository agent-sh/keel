// Words for assistive technology: two visually hidden live regions of the
// page, one that waits its turn ("status") and one that interrupts ("alert").
// A control cannot hold its own (what is inside a button is not announced),
// and the same words said twice are announced twice.
const regions: Partial<Record<"status" | "alert", HTMLElement>> = {};
const timers: Partial<Record<"status" | "alert", number>> = {};

export function announce(text: string, role: "status" | "alert" = "status") {
  const el = (regions[role] ??= document.body.appendChild(Object.assign(document.createElement("div"), { className: "sr-only" })));
  el.setAttribute("role", role);
  el.dataset.testid = `announce-${role}`;
  el.textContent = "";
  clearTimeout(timers[role]);
  requestAnimationFrame(() => {
    el.textContent = text;
    timers[role] = window.setTimeout(() => { el.textContent = ""; }, 5000);
  });
}

// What counts as the owner at a page: the input that ends an absence (the daemon's away rule, and so the card
// reminders) and makes them present in a pane. A key, a press, a wheel or a touch is the owner. A pointer moving
// is the owner only in the focused page: a mouse that crosses a window on its way to another program is not
// someone looking at Keel, and a page open behind the owner's work would otherwise keep them "here" for hours.
export const INPUT_TYPES = ["keydown", "pointerdown", "pointermove", "wheel", "touchstart", "touchmove"] as const;
const PASSING = new Set(["pointermove", "mousemove"]);

export const ownerInput = (type: string, focused: boolean): boolean => !PASSING.has(type) || focused;

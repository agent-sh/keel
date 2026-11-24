// Shared surfaces for popups, so every menu and popover looks the same.
export const popupClass =
  "origin-[var(--transform-origin)] rounded-lg border border-line bg-raised p-1 shadow-3 outline-none " +
  "transition-[scale,opacity] data-starting-style:scale-[0.97] data-starting-style:opacity-0 data-ending-style:scale-[0.97] data-ending-style:opacity-0";

export const itemClass =
  "flex h-8 max-md:h-auto max-md:min-h-8 max-md:py-1.5 cursor-default select-none items-center gap-2.5 rounded-md px-2.5 text-ui text-fg outline-none " +
  "data-highlighted:bg-hover data-disabled:opacity-50 [&>svg]:size-4 [&>svg]:text-faint";

export const iconButton = "grid size-8 place-items-center rounded-md text-faint hover:bg-hover hover:text-fg data-popup-open:bg-hover data-popup-open:text-fg";

// The sheets the rail's foot opens (Inbox, Errors, Loops): one side, one place, one motion. They come from
// the rail's side, where the button pressed is; a wide one (the loops' table) is wider, nothing else.
export const footSheet = (wide = false) =>
  `k-surface fixed left-3 top-3 bottom-3 z-50 ${wide ? "w-[min(60rem,calc(100vw-1.5rem))]" : "w-[min(40rem,calc(100vw-1.5rem))]"} ` +
  "transition-[transform,opacity] duration-(--dur-move) data-starting-style:-translate-x-4 data-starting-style:opacity-0 data-ending-style:-translate-x-4 data-ending-style:opacity-0";

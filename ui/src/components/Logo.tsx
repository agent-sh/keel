// The Keel mark: a level waterline and the keel under it, in one stroke of the ink around it. No
// tile, and no size of its own: where it stands says how large it is (the rail: its icons' size,
// bridge.css). The same path is the page's icon (ui/public/icon.svg) and the apps' (desktop/assets,
// android).
export function Logo() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
      <path d="M2.5 6.5H8L11.5 17.5H14.5L15.5 6.5H21.5" />
    </svg>
  );
}

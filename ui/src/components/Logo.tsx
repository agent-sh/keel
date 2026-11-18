// The Keel mark: a hull over its keel, on a deep-sea tile.
export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className="shrink-0">
      <rect width="32" height="32" rx="8" className="fill-accent" />
      <path d="M6 11.5h20c-1.1 4.9-5 7.6-10 7.6s-8.9-2.7-10-7.6z" className="fill-accent-fg" />
      <path d="M14.6 18.6h2.8l-.7 6.4h-1.4z" className="fill-accent-fg" />
    </svg>
  );
}

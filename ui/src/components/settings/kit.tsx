// The Settings kit: the few parts every section is made of, so that thirty
// sections built by different hands read as one page. Styles in bridge.css
// ("The Settings kit").
//
//   Page     the section's column: an intro line, then its groups, one gap apart.
//   Group    a group's head (its name, a count, a line of what it is, its actions)
//            over one framed box. `bare` keeps the head and drops the box (figures
//            that frame themselves, a chart).
//   Card     the framed box alone.
//   SettingRow  a setting: its label and hint on the left, its control on the right.
//   List, Item  a list with actions: a mark, a name and its line, figures, a status, the
//            actions. Narrow, what is beside the name goes under it.
//   More     the "show all" line under a list cut short.
//   Status   a status in a chip: one of six tones, a word of the vocabulary
//            (src/core/state-words.ts) where it has one.
//   Empty    nothing to show, where the rows would be.
//   Notice   what the page cannot do or see, with its tone.
//   Table    a table that drops its minor columns when narrow and never scrolls the page.
//
// A section uses these and draws no box, group head, status tag or empty line of
// its own (src/ui-conventions.test.ts holds it to that).
import type { ReactNode } from "react";
import { cn } from "../../lib/utils.ts";

type Data = Record<`data-${string}`, string | number | boolean | undefined>;

export function Page({ intro, children, testid, className, ...data }: { intro?: ReactNode; children: ReactNode; testid?: string; className?: string } & Data) {
  return (
    <div className={cn("k-set-page", className)} data-testid={testid} {...data}>
      {intro && <p className="k-set-intro">{intro}</p>}
      {children}
    </div>
  );
}

// `title` is the group's name; a search for it finds the group (lib/settings-find.macro.ts reads it).
export function Group({ title, count, hint, actions, children, bare, pad, testid, className, ...data }: {
  title?: ReactNode; count?: ReactNode; hint?: ReactNode; actions?: ReactNode; children?: ReactNode;
  bare?: boolean; pad?: boolean; testid?: string; className?: string;
} & Data) {
  const head = title !== undefined || hint !== undefined || actions !== undefined;
  return (
    <section className={cn("k-set-group", className)} data-testid={testid} {...data}>
      {head && (
        <div className="k-set-head">
          <div>
            {title !== undefined && <div className="k-set-title"><h3>{title}</h3>{count !== undefined && <span className="k-set-count">{count}</span>}</div>}
            {hint && <p className="k-set-hint">{hint}</p>}
          </div>
          {actions && <div className="k-set-actions">{actions}</div>}
        </div>
      )}
      {children !== undefined && (bare ? children : <div className="k-set-box" data-pad={pad || undefined}>{children}</div>)}
    </section>
  );
}

// (A card of setting rows, as sections drew it before the kit: a Group's box without its head.)
export function Card({ children }: { children: ReactNode }) {
  return <div className="k-card rounded-lg border border-line bg-raised px-5 shadow-1">{children}</div>;
}

export function SettingRow({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="k-setting flex flex-col gap-3 border-b border-line py-4 last:border-0 sm:flex-row sm:items-center sm:gap-8">
      <div className="min-w-0 flex-1">
        <div className="text-base font-medium">{label}</div>
        {hint && <div className="mt-0.5 text-ui text-muted">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

// `dense`: many short rows (figures, names) in a tighter row.
export function List({ children, testid, label, dense }: { children: ReactNode; testid?: string; label?: string; dense?: boolean }) {
  return <ul className="k-set-list" aria-label={label} data-dense={dense || undefined} data-testid={testid}>{children}</ul>;
}

// `name` is the item's own words; `sub` its second line; `meta` its figures (each a span);
// `status` a <Status>; `actions` its buttons. `open` marks the item whose detail is shown.
// `clip` keeps the second line to one line, its whole words in its title. The name is always whole:
// names alike in their first characters (paths, branches, controls) are told apart by their end.
export function Item({ lead, name, mono, title, sub, clip, meta, status, actions, open, onOpen, children, testid, className, ...data }: {
  lead?: ReactNode; name: ReactNode; mono?: boolean; title?: string; sub?: ReactNode; clip?: boolean; meta?: ReactNode; status?: ReactNode; actions?: ReactNode;
  open?: boolean; onOpen?: () => void; children?: ReactNode; testid?: string; className?: string;
} & Data) {
  return (
    <li className={cn("k-set-item", className)} data-lead={lead !== undefined || undefined} data-open={open || undefined} data-testid={testid} {...data}>
      {lead !== undefined && <span className="k-set-lead">{lead}</span>}
      <div className="k-set-main">
        {onOpen
          ? <button type="button" className={cn("k-set-name k-link max-w-full text-left hover:underline", mono && "font-mono")} data-mono={mono || undefined} title={title} aria-expanded={!!open} onClick={onOpen}>{name}</button>
          : <span className={cn("k-set-name", mono && "font-mono")} data-mono={mono || undefined} title={title}>{name}</span>}
        {sub && <div className="k-set-sub" data-clip={clip || undefined} title={clip && typeof sub === "string" ? sub : undefined}>{sub}</div>}
      </div>
      <div className="k-set-meta">{meta}</div>
      {status}
      <div className="k-set-act">{actions}</div>
      {/* The detail of an open item is part of it: a row of its own across the item. */}
      {open && children !== undefined && <div className="k-set-detail">{children}</div>}
    </li>
  );
}

export function More({ children }: { children: ReactNode }) {
  return <li className="k-set-more">{children}</li>;
}

export type Tone = "ok" | "warn" | "broken" | "new" | "info" | "quiet";
export function Status({ tone = "quiet", children, title, testid, ...data }: { tone?: Tone; children: ReactNode; title?: string; testid?: string } & Data) {
  return <span className="k-set-status" data-tone={tone} title={title} data-testid={testid} {...data}>{children}</span>;
}

export function Empty({ children, testid }: { children: ReactNode; testid?: string }) {
  return <p className="k-empty k-set-empty" data-testid={testid}>{children}</p>;
}

export function Notice({ tone, title, children, testid }: { tone?: "warn" | "broken"; title?: ReactNode; children: ReactNode; testid?: string }) {
  return (
    <div className="k-set-notice" data-tone={tone} role={tone ? "status" : undefined} data-testid={testid}>
      {title && <b>{title}</b>}
      {children}
    </div>
  );
}

// A column: its head, and how it lays out. `grow` takes what is left and cuts its words short;
// `end` aligns right (figures); `minor` goes when the box is narrow.
export type Col = { head: ReactNode; grow?: boolean; end?: boolean; minor?: boolean };
export function Table({ cols, children, testid, label }: { cols: Col[]; children: ReactNode; testid?: string; label?: string }) {
  return (
    <div className="k-set-table-wrap">
      <table className="k-set-table" aria-label={label} data-testid={testid}>
        <thead>
          <tr>{cols.map((c, i) => <th key={i} data-end={c.end || undefined} data-minor={c.minor || undefined}>{c.head}</th>)}</tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
// A cell of a Table: the same layout marks as its column.
export function Cell({ col, children, title, className }: { col: Col; children?: ReactNode; title?: string; className?: string }) {
  return <td className={className} title={title} data-grow={col.grow || undefined} data-end={col.end || undefined} data-minor={col.minor || undefined}>{children}</td>;
}

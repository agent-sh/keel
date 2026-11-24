# The sealed record

What a session did is in the store: its events, the approval cards it was
asked, the transfers that left the daemon on its behalf. The sealed record
makes that history checkable: a row that was edited, taken out, put in or moved
shows, and a session's receipts can be handed to someone who has no access to
the daemon and still be checked.

## What is chained

Three chains per session, each row linked to the one before it:

| Chain | Rows | Where the link is kept |
| --- | --- | --- |
| events | every event, all branches, in order | `events.prev`, and the last link on the session's row |
| approval cards | each version of a card as it was stored (a card's own row changes when it is answered) | `seal_cards`, the last link in `seal_heads` |
| outward rows | each row of the outward ledger that names the session | `egress.prev`, the last link in `seal_heads` |

A link is `SHA-256(prev || head || "\n" || body)`: `prev` is the link before it
(32 zero bytes for the first), `head` the JSON array of the row's fields and
`body` its long text as stored. A row keeps its `prev` only; its own link is the
next row's `prev`. The event's link is made in the write that stores the event,
with no extra statement. It costs about 0.33 ms per MB of event text: under 2
microseconds for an ordinary event, about 250 microseconds for a 1 MB event and
1.5 to 2 ms for a 4 MB image body. Storage is 32 bytes per event.

The outward ledger's retention removes its oldest rows. What is left stays
whole, and `verify` says older rows are no longer in the store. A store from
before the record has no links: a session's chain starts with the first event
written after the upgrade, and `verify` names that event ("sealed from event
N") and how many events before it are not covered.

## The daily root

Once a day, soon after the UTC day closes, the heads of every session that
moved since the last root are listed, a Merkle tree is made over them, and the
day's root is `SHA-256(day || root of the day before || tree root)`. The leaves
are kept in `seal_days`, the roots in `seal_roots`, and each root is written as
one line to:

- `<state>/seal/roots.jsonl`, always. Only the daemon appends to it. It is
  outside the writable set of every sandbox a command runs in and outside every
  folder a session is given.
- the file named in Settings, `seal.mirror`, when it is set. Name a file in a
  folder that is synced or mounted off the machine, or one that only appends,
  to keep the roots where nothing on this machine can rewrite them.

The daemon reads and writes both files off its loop, with a time limit of ten
seconds a call, so a stale mount cannot hold it. The mirror is looked at when a
root has been made, after a failed copy, at a start, and when the setting
changes, not every few minutes. When it cannot be read in time, `verify` and
`audit roots` say so and do not count it as a difference.

## What it shows, and what it does not

Without a mirror that is off the machine or only appends, the record shows
accidental and partial edits: a row changed, taken out, put in or moved by a
bug, a stray SQL statement, or a tool that wrote to the store. It does not stop
an actor that runs as the owner. A session with its sandbox off in full auto is
that actor: it can rewrite the store, make every link and head again, rewrite
`roots.jsonl` to match, and change `seal.mirror`. `verify` then says whole.

The mirror is what makes the record tamper-evident: a root that has left the
machine, or sits where the owner's account can only append, cannot be remade
from the store. Keep a copy of the roots there, or hold a bundle against a copy
you kept (`--roots`).

A binary older than the record, run against a store that has the record,
writes events with no link and leaves the session's last link as it was. The
next `verify` names the first event written that way as a break. A newer binary
then goes on from the last link it holds; the events in between stay not
covered.

## Commands

```
keel audit verify SESSION [--roots FILE]   whole, or the row where a chain breaks
keel audit verify [--json]                 the days' roots, held against the roots file
keel audit export SESSION --out FILE       the session's receipts as one bundle
keel audit verify --bundle FILE [--roots FILE]   a bundle, checked with no daemon
keel audit roots                           the days' roots and where they are kept
```

`verify` exits 0 when everything is whole and 1 when not. A bundle holds the
rows, the three heads and, for each day that covers the session, the Merkle path
to that day's root. Alone it proves the rows are consistent with each other and
with the roots it names; compare those roots with a copy you kept (`--roots`)
to prove they are the ones the daemon wrote.

## What it does not do

- Rows a session changes before they are stored are what is sealed: the record
  proves the history was not changed afterward, not that it is true.
- The bundle is written by the read thread to `<state>/seal/bundles` and
  streamed; the file is removed when the stream ends, and any older than an hour
  is removed at the next export.
- Truncating the end of a chain after the last day's root and rewriting the
  head with it is found only from the next root on.
- Outward rows that name no session are chained under one chain of their own
  and appear in the roots; they have no per-session export.

# Spec 515: a running total that is a floor reads `≥`

Issue: https://github.com/princess-pi/wtft/issues/515.
Status: **Spec Approved** (Duppy, 2026-10-14: "I like that as a solution so we definitely want to implement that", on the `≥` form).

Module: `extensions/lib/uncounted-latch.ts` · Seam: `createUncountedLatch`, tested in `tests/wtft-515-floor-marker.test.ts`
Also: `extensions/lib/wtft-chart.ts` — prints the marker.
Also: `extensions/lib/wtft-renderer.ts` — passes `floor` to the chart.
Also: `extensions/lib/chart-call.ts` — passes `floor` to the renderer.
Also: `extensions/lib/wtft-daemon-lib.ts` — `--watch` asks the latch.
Also: `extensions/wtft.ts` — the Pi widget asks the latch.
Also: `extensions/lib/cli/report.ts` — the one-shot report asks the latch over the session and the subagent transcripts discovery finds (discovery may warn on stderr). It does not reuse `scanSessionUncounted`, whose subagent-unreadable verdict a plain run must not set (README exit 9).

## 1. Problem

wtft prices only recorded `usage`. Claude Code bills compactions and away-recaps, and Pi bills compactions, and neither writes
usage for them (spec-149 §4–§5). On session `0e9925e4` (2026-10-14) the chart showed $217.62 while
Claude Code's status line showed $230.63. Duppy's decision: the total stays usage-derived, and the chart
says in one glyph that it is a floor.

## 2. The marker

- **When:** a transcript the surface reads for this session holds an entry that
  `readUncountedBillableClass` classifies: a compaction or a recap.
- **Where:** the total-cost cell of the newest displayed row, in either mode and under either unit:
  `≥$218`. The other rows' totals carry no `≥`; the label area widens for it, which can move the
  compaction step (spec-362). The marker is
  absent whenever the cost columns are not shown, and from `--json`.
- **Surfaces:** the CLI chart (including the one a `--tokens` run prints
  above its summary), `--watch`, the Pi widget and its pager. The wtft.html demos and the fair page pass no `floor`.

## 3. The latch

```ts
export interface UncountedLatchIo {
  size(path: string): number | null;                     // null: could not stat
  readFrom(path: string, offset: number, length: number): Buffer | null; // up to length bytes from offset; null: could not read
}
export interface UncountedLatch {
  seen(paths: Iterable<string>): boolean;
}
export function createUncountedLatch(io?: UncountedLatchIo, chunkBytes?: number): UncountedLatch;
```

- **Latched:** once `seen` returns true it returns true from then on, reading nothing. The Pi widget
  starts a new latch when its session file changes.
- **Incremental:** each call reads only the bytes past where the last call stopped, in chunks of
  the parser's size, and parses only complete lines. A file smaller than that point is read again
  from the start. A file that cannot be stat-ed or read counts as nothing seen, and is tried again
  next call. A line longer than a chunk costs time linear in its length.
- `paths` is iterated only while nothing has been seen, so `--watch` stops discovering subagent
  transcripts once latched.
- `--watch` reads a session transcript that moved from where it now is.
- The default `io` is `node:fs`. `--watch` and the widget call `seen` on every render, so a transcript
  is parsed once, not once per frame.

## 4. Verification

`tests/wtft-515-floor-marker.test.ts`:
- **Latch:** a Claude Code compaction, a recap and a Pi compaction are each seen; plain turns are not;
  appended bytes are the only bytes read again; a line split across reads, including inside a
  multi-byte character, is seen once complete; a line spanning two chunks is seen, and reading stops
  at the first match; a 4 MiB line read 256 bytes at a time finishes in under 2 s; a chunk size of 0
  throws; a shrunken file is read again; a missing file is nothing seen; after a true,
  nothing is read and `paths` is not iterated.
- **Chart:** with `floor` the newest row's total cost reads `≥$…` and no other row does; without it no
  line holds `≥`; a transcript file holding a `compact_boundary`, fed through the latch, draws `≥`,
  and one without draws none.

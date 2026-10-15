# Spec 515: a running total that is a floor reads `≥`

Issue: https://github.com/princess-pi/wtft/issues/515.
Status: **Spec Approved** (Duppy, 2026-10-14: "I like that as a solution so we definitely want to implement that", on the `≥` form).

Module: `extensions/lib/uncounted-latch.ts` · Seam: `createUncountedLatch`, tested in `tests/wtft-515-floor-marker.test.ts`
Also: `extensions/lib/wtft-chart.ts`: prints the marker. `extensions/lib/wtft-renderer.ts` and `extensions/lib/chart-call.ts`: pass the `floor` flag through. `extensions/lib/wtft-daemon-lib.ts` (`--watch`) and `extensions/wtft.ts` (the Pi widget): ask the latch. `extensions/lib/cli/report.ts`: the one-shot report reuses its existing `scanSessionUncounted`, which `--tokens` and `--json` already read.

## 1. Problem

wtft prices only recorded `usage`. Claude Code also bills compactions and away-recaps, and writes no
usage for either (spec-149 §4–§5). On session `0e9925e4` (2026-10-14) the chart showed $218 while
Claude Code's status bar showed $230. Duppy's decision: the total stays usage-derived, and the chart
says in one glyph that it is a floor.

## 2. The marker

- **When:** the session file, or any subagent transcript under it, holds at least one entry that
  `readUncountedBillableClass` classifies (a compaction or a recap).
- **Where:** the total-cost column of the newest displayed row: `≥$218`. Only that cell changes. Older
  rows, the bar, the token columns and `--json` do not. With the cost columns hidden there is no marker.
- **Surfaces:** the CLI chart, `--watch` and the Pi widget. The `--tokens` summary already prints the
  `UNCOUNTED` line, so it gets no marker.

## 3. The latch

```ts
export interface UncountedLatchIo {
  size(path: string): number | null;                 // null: could not stat
  readFrom(path: string, offset: number): string | null; // bytes from offset to end; null: could not read
}
export interface UncountedLatch {
  seen(paths: Iterable<string>): boolean;
}
export function createUncountedLatch(io?: UncountedLatchIo): UncountedLatch;
```

- **Latched:** once `seen` returns true it returns true from then on, reading nothing. A compaction
  that happened stays happened.
- **Incremental:** for each path it reads only the bytes past the offset it reached last time. A trailing
  line with no newline is kept and finished on the next read. A file smaller than its offset is read
  again from 0.
- **A failed stat or read** counts as nothing seen for that path this call.
- The default `io` is `node:fs`. `--watch` and the widget call `seen` on every render, so an 80 MB
  transcript is parsed once, not once per frame.

## 4. Verification

`tests/wtft-515-floor-marker.test.ts`:
- **Latch:** a fake io holding a `compact_boundary` line is seen; one holding only assistant turns is
  not; an appended recap is seen on the next call after reading only the new bytes; a split line is
  seen once its second half arrives; after a true, no further reads happen.
- **Chart:** `chartLines` with `floor: true` puts `≥` before the newest row's total cost and nowhere
  else; with `floor` absent the output has no `≥`.

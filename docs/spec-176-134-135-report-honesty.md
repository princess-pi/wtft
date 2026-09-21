# Spec 176 / 134 / 135 B — the widget and the pending arm say what they know

**Issues:** [#176](https://github.com/princess-pi/wtft/issues/176),
[#134](https://github.com/princess-pi/wtft/issues/134),
[#135](https://github.com/princess-pi/wtft/issues/135) part B ·
**Plan:** P1 of [#194](https://github.com/princess-pi/wtft/issues/194) ·
**Test:** `tests/wtft-176-134-135-report-honesty.test.ts`

## 1. #176: the widget reads the tag's own verdict

The widget reads the tag through `readTagFileWithVerdict`, the same reader the CLI uses, so the
interactions and the verdict come from one read. When the verdict is provisional, every surface
that already carries the #165 line also carries one line for the tag:

`⚠ <reason> — total is provisional`

`<reason>` is `describeProvisionalReason`, moved out of `bin/wtft.ts` into
`extensions/lib/wtft-daemon-lib.ts` beside `TagProvisional`, so the CLI's stderr warning and the
widget line cannot say different things about one tag. The #165 line for a subagent file dropped
at read time stays as it is. If both conditions hold, both lines show, because they have different
causes and different remedies.

The daemon writes `unswept` only between appending a line and the end-of-poll `swept` stamp, or
after a poll that failed. A live widget therefore shows this line only while a poll is in flight
or after one failed, never for the whole session.

## 2. #134 A: an unreadable ledger is not "spawned nothing" — already true, now pinned

`computeSpawnTree` reports a ledger it cannot read as `ledgerError`, and `renderSpawnTree` prints
a "descendants unknown, not zero" block for it. So `/wtft --tokens` already tells the two cases
apart. No code changes here. The test pins it: with the ledger unreadable, `/wtft --tokens`
contains the `ledgerError` block, and with no edges it contains no spawn block.

## 3. #134 B: self-attribution runs only when the ledger has an edge

`SpawnTreeOptions.alreadyAttributed` also accepts a thunk, `() => Set<string>`, and
`computeSpawnTree` calls it only after the no-edges fast path. The CLI and the widget pass a thunk,
so a session with no recorded edges does no subagent discovery for the spawn tree.

## 4. #135 B: the pending arm derives nothing from the file it declared absent

On the pending arms (`emitSessionJson({pending: true})`, `finishEmptyReport({pending: true})`), the
spawn tree gets an empty `alreadyAttributed` set. The ledger is still read, so the report still
shows the session's recorded edges, but the in-self set is no longer computed from a session file
the same report says is not written yet.

## Closer

`tests/wtft-176-134-135-report-honesty.test.ts`:

- **#176:** a tag whose last marker is `_meta.unswept` makes the widget render
  "total is provisional" on the widget, `/wtft --tokens` and `/wtft --pager` surfaces. The same
  tag stamped `swept` renders no provisional line. `wtft --json` on the same session reports
  `provisional.provisional: true`.
- **#134 A:** with the ledger path unreadable, `/wtft --tokens` contains the `ledgerError` text;
  with an empty ledger, it contains no spawn block.
- **#134 B:** `computeSpawnTree` with an empty ledger never calls the `alreadyAttributed` thunk; with
  an edge for the root, it calls it exactly once.
- **#135 B:** `wtft --json` on a session whose log is not written yet, with a ledger edge recorded for
  it, prints no subagent-discovery warning on stderr and still exits 0. The precondition is
  asserted: the same edge is present in the report's `spawned.edges`.

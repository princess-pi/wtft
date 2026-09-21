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
`extensions/lib/wtft-daemon-lib.ts` beside `TagProvisional`, so the CLI and the widget word each
reason the same way. The verdicts can still differ: when the CLI's uncounted scan finds an
unreadable subagent file it replaces the tag's verdict with `subagent-unreadable`, which no tag
carries. The #165 line for a subagent file the widget could
not read stays as it is. If both conditions hold, both lines show, because they have different
causes and different remedies.

A tag reads `unswept` when its last significant line is a classified line with no `_meta.swept`
stamp after it, or an explicit `_meta.unswept` marker. The daemon stamps `swept` at the end of a
clean poll whenever the tag grew or a stale `swept` was retracted since the last stamp, so a
healthy daemon leaves that state within one poll. It persists while polls keep failing, for
example on a permanently unreadable subagent file, and while the session file is absent. The
widget re-reads the tag only when it renders (on `session_start`, `agent_settled`,
`session_tree`, a `/wtft` command, or its 60-second timer), so a line stays on screen until
the next render.

## 2. #134 A: an unreadable ledger is not "spawned nothing" — already true, now pinned

`computeSpawnTree` reports a ledger it cannot read as `ledgerError`, and `renderSpawnTree` prints
a "descendants unknown, not zero" block for it. So `/wtft --tokens` already tells the two cases
apart. No code changes here. The test pins it: with the ledger unreadable, `/wtft --tokens`
contains the `ledgerError` block, and with a clean, empty ledger it contains no spawn block.
A ledger with malformed lines and no edges for this session prints its own one-line block
(spec-116).

One gap is left standing: `widgetSpawnTree` still maps any other throw from the walk to no
tree, which renders nothing. `computeSpawnTree` catches its own ledger read, so no throw is
known to reach that path.

## 3. #134 B: self-attribution runs only when the ledger has an edge

`SpawnTreeOptions.alreadyAttributed` also accepts a thunk, `() => Set<string>`, and
`computeSpawnTree` calls it only after the no-edges fast path. The widget, and the CLI on every
arm except the pending one (§4), pass a thunk, so a session with no recorded edges does no
subagent discovery for the spawn tree.

## 4. #135 B: the pending arm derives nothing from the file it declared absent

On the pending arms (`emitSessionJson({pending: true})`, `finishEmptyReport({pending: true})`), the
spawn tree gets an empty `alreadyAttributed` set. The ledger is still read, so the report still
shows the session's recorded edges, but the in-self set is no longer computed from a session file
the same report says is not written yet.

## Closer

`tests/wtft-176-134-135-report-honesty.test.ts`:

- **#176:** a tag whose last marker is `_meta.unswept` makes the widget, `/wtft --tokens` and
  `/wtft --pager` print the tag's reason line ("no subagent transcript has been read since this
  tag was written — total is provisional"), and not the #165 line. The same tag stamped `swept`
  renders its turn and no provisional line. `wtft --json` on the same session reports
  `provisional.provisional: true`.
- **#134 A:** with the ledger path unreadable, `/wtft --tokens` contains the `ledgerError` text; a
  ledger with one malformed line prints the skipped-line block, which proves the ledger is read;
  with a clean, empty ledger, it contains no spawn block.
- **#134 B:** `computeSpawnTree` on a ledger holding edges only for another session never calls the
  `alreadyAttributed` thunk; with an edge for the root, it calls it exactly once; and a thunk's ids
  skip an edge as `in-self-total` exactly as a Set's do. The two callers passing a thunk is not
  under test. The work the thunk defers (the per-turn `claude -p` cwd-and-time search, plus a
  subagent-directory walk the report path runs anyway) prints nothing when it succeeds, so on a
  readable session no output tells a lazy caller from an eager one.
- **#135 B:** `wtft --json` on a session whose log is not written yet, with a ledger edge recorded for
  it, prints no subagent-discovery warning on stderr and still exits 0. The precondition is
  asserted: the same edge is present in the report's `spawned.edges`.

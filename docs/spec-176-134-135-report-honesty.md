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

`tagProvisionalFromContent` and the daemon's `swept` stamping decide when a tag reads provisional
(`docs/wtft-incremental-render-spec.md` § `_meta.swept`); this branch changes neither.
The widget re-reads the tag only when it renders (on `session_start`, `agent_settled`,
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
  tag was written — total is provisional"). The same tag stamped `swept`
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

## Reconciliation record

Four `spec-reconcile` rounds. Round 1 audited every file the branch touched (fresh-context auditors
on DeepSeek V4.1 Flash); rounds 2-4 re-audited only what the previous round edited.

| Artifact | Claim | Contradicted by | Covered by a test? | Action |
|---|---|---|---|---|
| `CONTEXT.md` Provisional | the widget surfaces the state only from `_subagentUnreadable`, never reads the CLI's verdict | `readInteractions` reads `readTagFileWithVerdict` | ✅ this spec's test | Rewritten: one line per cause |
| `CONTEXT.md` Provisional | the flag comes from discovery alone | `loadSubagentInteractionsChecked`'s `dropped` sets it (#165) | ✅ `wtft-165-widget-subagent-drop.test.ts` | Rewritten |
| `CONTEXT.md` Provisional | "real but not final", opening on the entry's own banned word; reasons described as timing only | `stale-version` is a filename check; `subagent-unreadable` comes from the CLI scan | `reconciled-against-untested` | Rewritten per reason |
| `CONTEXT.md` Tag file | read by `readClassifiedTagFile()` | CLI report path and widget use `readTagFileWithVerdict`; `--watch` seeds from `seedClassifiedTagFile` | `reconciled-against-untested` | Rewritten |
| `CONTEXT.md` CLI | `--other` is a CLI-only mode | the extension implements `/wtft --other` | ✅ `wtft-165-widget-subagent-drop.test.ts` | Removed from the list |
| README, manifest, spec-165 | the uncounted scan never runs on a plain run | the non-pending empty arms scan | `reconciled-against-untested` | "plain run that renders bins" |
| `spec-116` | #134 A/B listed as open advisories | fixed on this branch | ✅ this spec's test | Rows marked fixed |
| `spec-165` Scope | the widget still cannot see the tag verdict | fixed on this branch | ✅ this spec's test | Re-pointed here |
| this spec §1 | swept/unswept mechanics, stated three ways across rounds 1-3 | each wording missed a path | — | Deleted; points to the owning spec |
| this spec's test | four checks that could not fail (vacuous control, unasserted precondition, shared-suffix match, a conjunct no fixture reaches) | — | — | Tightened or deleted |

Older drift in the same files, not caused by this branch: [#196](https://github.com/princess-pi/wtft/issues/196)
(leads, unverified), plus #124, #126, #169 and #91 where they already cover it.

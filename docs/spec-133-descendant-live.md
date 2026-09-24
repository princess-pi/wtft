# Spec 133 — a still-growing descendant makes the tree provisional

**Issue:** [#133](https://github.com/princess-pi/wtft/issues/133) (decision A, 2026-09-16) ·
**Plan:** P2 of [#194](https://github.com/princess-pi/wtft/issues/194) ·
**Test:** `tests/wtft-133-descendant-live.test.ts`

## The contract

One-shot `wtft` is what you run when things are quiet. A counted descendant whose transcript is
still growing means that quiet is not there: the report says so and exits 9. The marker is
**binary**. It says the tree may still grow; it does not estimate by how much.

We cannot know that a child process is alive, only when its transcript last grew. "Not producing
lines" is the requirement, so the transcript's mtime is the measurement, not a proxy for one.

## Shape

- **Liveness.** A counted edge (`resolved: true`) is `live` when the mtime of its transcript, or of any
  subagent transcript discovery lists for it (spec-230), is within
  `IDLE_THRESHOLD_MS` (122 s, the daemon's definition of idle) of now, on either side: a write
  during the walk lands just after `now`, and clock skew is small, but a far-future mtime is not
  live. The walk stats each of those files after parsing them, so an append during the parse counts,
  and in the same `try`, so one that cannot be stat-ed is an `unreadable` edge in `unattributed`,
  never guessed live or quiet. `computeSpawnTree`
  sets `live: boolean` on every counted edge and on no other edge. `SpawnTreeOptions.now` injects
  the clock.
- **Verdict.** When the CLI computes the tree and any edge is `live`, and the run is not already
  provisional for another reason, `provisional` becomes `{ provisional: true, reason:
  "descendant-live" }`: exit 9, the stderr line, and the JSON field, exactly as the other reasons
  do, including the `provisional` entry in `--json`'s `notices[]`. That entry is now built in
  `emitSessionJson`, so the empty arms (`no-data`, `pending-session`) carry it too, for every
  reason; before this change only the populated arm did. The tree never replaces a
  reason already set; the uncounted scan, which runs before it, can still replace the tag's.
- **Vocabulary.** `descendant-live` is a fourth value in the closed `provisional.reason` set.
  `describeProvisionalReason` words it "a descendant session wrote to its transcript in the last
  122 s, so the tree total may still grow"; the remedy is to run wtft again once every descendant
  has been quiet for 122 s. Both take the number from `IDLE_THRESHOLD_MS`.
- **Schema.** `spawned.edges[].live` is a new nested key, and the reason set widens, so
  `wtft/session@4` becomes `wtft/session@5` and `spawned`'s own `wtft/spawn-tree@1` becomes `@2`.
- **Where it applies.** Only CLI runs that compute the spawn tree: `--tokens` and `--json`. A
  plain `wtft` run never reads the ledger, so a live descendant does not make it provisional. The Pi
  widget's `/wtft --tokens` renders the tree but does not read `live`; that rendering is #198.

## Not in this change

The `--watch` rendering in #133's decision (one line per in-flight child) needs the watch loop to
compute the spawn tree, which it does not do today: [#198](https://github.com/princess-pi/wtft/issues/198).

## Closer

`tests/wtft-133-descendant-live.test.ts`:

- `computeSpawnTree` with `now` set 10 s after a child transcript's mtime marks that edge
  `live: true`; with `now` 10 minutes after, `live: false`; an unresolved edge carries no `live`.
- `wtft --json` on a parent whose ledger child was written just now reports
  `provisional: { provisional: true, reason: "descendant-live" }`, `schema: "wtft/session@5"`,
  and exits 9. The same run after the child's mtime is set 10 minutes back reports
  `provisional: false` and exits 0.
- `wtft --tokens` on the live case prints the `descendant-live` sentence on stderr and exits 9.
- A tag that is already provisional (`unswept`) keeps its reason when a descendant is also live.

## Reconciliation record

Two `spec-reconcile` rounds (fresh-context auditors on DeepSeek V4.1 Flash). Round 1 audited P2's
claims, `extensions/lib/wtft-json.ts` in full, and the test; round 2 re-audited what round 1 edited.
`bin/wtft.ts`, `wtft-spawn-tree.ts` and `wtft-daemon-lib.ts` had a full file-level pass on the #176
branch the same day, recorded in #196.

| Artifact | Claim | Contradicted by | Covered by a test? | Action |
|---|---|---|---|---|
| this spec, spec-26 Amendment 4 | `descendant-live` behaves "exactly as the other reasons", notice included | `--json` built `notices[]` before the tree set the reason | ✅ this spec's test | **Code fixed**: the tree runs before the notices are built |
| this spec, README, manifest | "within the last 2 minutes" | `IDLE_THRESHOLD_MS` is 122 s | ✅ this spec's test | Sentences derive the number from the constant |
| spec-26, README, manifest, CONTEXT, EXT_WTFT | `wtft/session@4`, `spawn-tree@1`, a three-value reason set | the bumps this branch made | ✅ `wtft-26-json`, `wtft-116`, `wtft-119` | Updated |
| spec-26, README, manifest | exit 9 means the total may still grow "under the daemon" | `descendant-live` and `subagent-unreadable` are not daemon lag | `reconciled-against-untested` | Reworded to name `provisional.reason` |
| this spec, spec-26 | a plain run "exits 0" with a live descendant | a plain run still exits 9 on a provisional tag | `reconciled-against-untested` | "does not make it provisional" |
| this spec | liveness is an mtime test | an unstat-able transcript counted as live, forever (Macroscope, PR #199) | `reconciled-against-untested` | **Code fixed**: stat inside the parse's `try`; the edge is `unreadable` |
| `--json` empty arms | `notices[]` carries the provisional notice "as for every other reason" | only the populated arm built it, for any reason | ✅ this spec's test (pending arm) | **Code fixed** (pre-PR review): built once, in `emitSessionJson` |
| this spec's test | "stderr names the live descendant"; exit checks compare against the constant | the sentence names no descendant; the constant could change | — | Message renamed; literal 9 pinned |

Older drift found in the same pass, not caused by this branch: #196 (comments).

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

- **Liveness.** A counted edge (`resolved: true`) is `live` when its transcript's mtime is less
  than `IDLE_THRESHOLD_MS` (122 s, the daemon's definition of idle) before now. A transcript that
  parsed but can no longer be stat-ed counts as live: it changed under the read. `computeSpawnTree`
  sets `live: boolean` on every counted edge and on no other edge. `SpawnTreeOptions.now` injects
  the clock.
- **Verdict.** When the CLI computes the tree and any edge is `live`, and the run is not already
  provisional for another reason, `provisional` becomes `{ provisional: true, reason:
  "descendant-live" }`: exit 9, the stderr line, and the JSON field, exactly as the other reasons
  do, including the `provisional` entry in `--json`'s `notices[]`. The tree never replaces a
  reason already set; the uncounted scan, which runs before it, can still replace the tag's.
- **Vocabulary.** `descendant-live` is a fourth value in the closed `provisional.reason` set.
  `describeProvisionalReason` words it "a descendant session wrote to its transcript in the last
  122 s, so the tree total may still grow"; the remedy is to run wtft again once every descendant
  has been quiet for 122 s. Both take the number from `IDLE_THRESHOLD_MS`.
- **Schema.** `spawned.edges[].live` is a new nested key, and the reason set widens, so
  `wtft/session@4` becomes `wtft/session@5`.
- **Where it applies.** Only CLI runs that compute the spawn tree: `--tokens` and `--json`. A
  plain `wtft` run never reads the ledger, so it cannot see a descendant and exits 0. The Pi
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

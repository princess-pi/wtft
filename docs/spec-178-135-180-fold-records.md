# Spec 178 · 135 A · 180 — the daemon records what it folded

**Issues:** [#178](https://github.com/princess-pi/wtft/issues/178),
[#135](https://github.com/princess-pi/wtft/issues/135) part A,
[#180](https://github.com/princess-pi/wtft/issues/180) items 1–6 ·
**Plan:** P3 of [#194](https://github.com/princess-pi/wtft/issues/194), decision D1 ·
**Test:** `tests/wtft-178-fold-records.test.ts`

## The contract

`total` is what the daemon folded into the tag. The spawn walk must skip exactly the sessions
inside `total`, so it needs the same fact the daemon had when it folded. Rediscovering that set
at read time against the filesystem, as it is at read time, is not the same fact. The two drift
in both directions: a child the daemon never folded is dropped from both buckets (#135 A), and
a child that has since moved is counted in both (#178).

So **the daemon records every session it folds, and the CLI reads the record.** Nothing on the
read path rediscovers.

## Shape

### Tag format — the fold record

- **A fourth line kind:** `{"_fold":{"parent":"<session id>","child":"<session id>"}}`.
  `parent` is the tag's own session; `child` is a session whose cost is in this tag's lines.
- **Written by `syncSubagentTranscript`**, the daemon's one fold point, for Task children and
  `claude -p` children alike. It is written after the first parse of a child transcript succeeds.
  That covers the child, plus every session the child's parse folded in, at any depth. The
  records go in the same append as the child's lines, after them. Each session is recorded
  once per daemon life. Readers treat the records as a set, so a restart that re-records is
  harmless.
- **A fold record is data, not a marker.** It changes the report, so it needs a sweep like an
  interaction line: the daemon sets `tagGrewSinceMarker`, and a tag whose last data line is a
  fold record reads `unswept`.
- **`WTFT_TAGGER_VERSION` 2.8.2 → 2.9.0.** A tag written before this change has no fold
  records. It is already a `stale-version` tag: the report is provisional for that reason, and
  the in-self set it yields is empty.
- **No generation field yet.** Rotation generations are P4 (#114). The record is keyed by
  session id, so a generation can be added later without changing the key.

### Reading

- `readTagFileWithVerdict` also returns `folded: Set<string>`, from the same single read as the
  interactions and the verdict. That makes the three one snapshot.
- **CLI in-self set = `folded`.** `computeSpawnTree` adds the root itself. The pending arm still
  passes an empty set, which is P1's contract.
- **Widget in-self set = `folded` ∪ the Task transcripts the widget merges into SELF itself, ∪
  the sessions those transcripts' parses folded.** That is exactly what its SELF contains. No
  discovery runs on either path. `collectSelfAttributedSessionIds` becomes a pure union of what
  it is handed.

### Parser — folds carry their shares

- `attributeClaudeSubAgentCosts` replaces `claudeSubAgentSessionIds` with
  `claudeSubAgentFolds: { id, share }[]` on the spawning interaction.
  - It lists **every session folded into that interaction, at any depth**.
  - `share` is that session's **own** turns, without the sessions it folded, in the same six
    fields `TokenTotals` has.
  - So the shares of one interaction sum to exactly what the fold added to it.

### Spawn walk

- **No re-parse of folded sessions.** A counted descendant's fold ids and shares come from its
  own parse. `foldsOf` and its swallowed throw (#180 item 2) are deleted.
- **What a descendant folded** means the folds carried by the interactions that `total` counts:
  deduplicated and model-tagged, the same set `computeSessionSummary` sums. A fold on an
  interaction outside that set added nothing to the descendant's total, so it is neither
  subtracted nor marked folded. Its own edge, if it has one, still counts it.
- **Subtract a share, never a separately computed total.** For each session a counted
  descendant folded:
  - Already in SELF, already counted under its own edge, or already folded by an earlier
    descendant: its `share` is subtracted from this descendant's total. This fixes #180 item 1:
    in-self and folded ids used to subtract nothing.
  - Otherwise: it is marked `folded`.
  - The subtraction runs over the same interactions the total was summed from, so it cannot go
    below zero. `subtractTotals` loses its clamp and throws when a field would fall below
    −1e-9; values between that and zero are float noise and become 0. A throw here is a bug
    in this module, not a fact about a transcript (#180 item 4).
- **A gap later covered is not a gap.** A session in `unattributed` that a later descendant's
  parse folds has landed in `spawned.total`. Its `unattributed` entry is removed, and its
  outcome becomes `folded`. Its edge row keeps the skip it was reported with (#180 item 3).
- **The `try` covers the parse and the stat only.** Fold arithmetic runs outside it, so a throw
  there is not reported as an `unreadable` edge (#180 item 5).
- **`depthCapped` counts edges past the cap onto a session not already reached.** An edge past
  the cap onto a session seen earlier reports that session's outcome and is not a cut. The code
  is unchanged; the wording in spec-116, spec-26, the README and `CONTEXT.md` is corrected
  (#180 item 6).

### Schemas

`wtft/session@5` and `wtft/spawn-tree@2` are unchanged: no field is added, removed or retyped.
The tag format gains a line kind, and the tagger version marks it.

## Not in this change

- Generation records on rotation, and re-attributing a nested `claude -p` until it is idle:
  P4 (#114, #14).
- A descendant with untagged turns shows `$0.00` with no floor condition (#180 item 7):
  P9, as `descendant-untagged` (D2).

## Closer

`tests/wtft-178-fold-records.test.ts`:

- **Parser.** A root whose turn spawns child C, which spawns grandchild G: the spawning
  interaction's `claudeSubAgentFolds` lists C and G. G's share is G's cost, and C's share is
  C's own cost without G's.
- **Daemon.** The daemon run on that root writes `_fold` records for C and G. The tag reads
  `swept`, and `readTagFileWithVerdict(...).folded` holds both.
- **#178.** Take a tag that recorded C, then make C's transcript unreadable, with a ledger edge
  root → C. C's edge is `in-self-total`, and C contributes zero to `spawned.total`.
- **#180 item 2.** The same, with a ledger edge root → G while C is unreadable. G is
  `in-self-total`.
- **#135 A.** A tag with no fold record for C, C readable, and a ledger edge root → C. C is
  counted in `spawned.total`.
- **#180 item 1.** In-self X, and a ledger descendant D whose parse also folds X: D's edge
  total equals D's own cost. The same holds for two ledger descendants that both fold X: X's
  cost is in `spawned.total` once.
- **#180 item 3.** An edge to X that is `not-found` first, then a descendant whose parse folds
  X: `unattributed` is empty.
- **#180 item 4.** A descendant whose spawning turn is untagged, so its fold is outside its
  total, and whose folded session was counted under its own edge. The descendant keeps its own
  tagged cost; before this change the clamp zeroed it.
- **End to end.** `wtft --json` on a fixture with a fold-recorded child moved away and a ledger
  edge to it: `tree.costUsd` equals `total.costUsd`.

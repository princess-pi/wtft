# Spec 178 · 135 A · 180 — the daemon records what it folded

**Issues:** [#178](https://github.com/princess-pi/wtft/issues/178),
[#135](https://github.com/princess-pi/wtft/issues/135) part A,
[#180](https://github.com/princess-pi/wtft/issues/180) items 1–6 ·
**Plan:** P3 of [#194](https://github.com/princess-pi/wtft/issues/194), decision D1 ·
**Test:** `tests/wtft-178-fold-records.test.ts`

## The contract

`total` is what the daemon folded into the tag. The spawn walk must skip exactly the sessions
inside `total`, so it needs the same fact the daemon had when it folded. Before this change the
CLI rediscovered that set at read time, against the filesystem as it is at read time, which is
not the same fact. The two drifted in both directions: a child the daemon never folded was
dropped from both `total` and `spawned.total` (#135 A), and a child that had since moved was
counted in both (#178).

So **the daemon records every session it folds, and the CLI reads the record.** Nothing on the
read path rediscovers which sessions were folded.

## Shape

### Tag format — the fold record

- **A fourth line kind:** `{"_fold":{"parent":"<session id>","child":"<session id>"}}`.
  `parent` is the tag's own session id (the transcript's filename without `.jsonl`). `child` is
  the filename without `.jsonl` of a transcript the daemon folded into this tag: the session id
  for a `claude -p` child or a Pi sibling, `agent-<name>` for a Task child. Readers key on `child`; `parent` is
  there for a human reading the file.
- **Written by `syncSubagentTranscript`**, the daemon's one fold point, for Task children, Pi
  sibling sessions and `claude -p` children alike. Whenever a parse of a child transcript succeeds, the daemon records
  every session in `foldRecordIds` that it has not recorded yet: the child itself, plus every
  session folded onto one of the child's deduplicated, model-tagged turns, at any depth. A fold
  on an untagged turn lands in `untaggedCostUsd`, not in the total, so it is not recorded. The
  records go in the same append as the child's lines, after them. Each session is recorded
  once per daemon life. Readers treat the records as a set, so a restart that re-records is
  harmless.
- **A fold record is data, not a marker.** It changes the report, so it needs a sweep like an
  interaction line: the daemon sets `tagGrewSinceMarker`, and a tag whose last data line is a
  fold record reads `unswept`.
- **`WTFT_TAGGER_VERSION` 2.8.2 → 2.9.0.** A tag written before this change has no fold
  records, because its writer wrote none, so the in-self set it yields is empty. It is also a
  `stale-version` tag, so the report is provisional for that reason.
  - **The transition, accepted.** A one-shot run that reads such a tag can count a folded child
    under its ledger edge too, which is the #178 double count, until the daemon it just started
    rewrites the tag at 2.9.0. That run exits 9, and the `stale-version` remedy is to run again,
    which reads the rewritten tag. Keeping read-time rediscovery as a fallback for old tags would
    keep the code this change exists to remove.
- **No generation field yet.** Rotation generations are P4 (#114). The record is keyed by
  session id, so a generation can be added later without changing the key.

### Reading

- `readTagFileWithVerdict` also returns `folded: Set<string>`, from the same single read as the
  interactions and the verdict. That makes the three one snapshot.
- **CLI in-self set = `folded`.** `computeSpawnTree` adds the root itself. The pending arm still
  passes an empty set, which is P1's contract.
- **Widget in-self set = `folded` ∪ the Task transcripts the widget merged into SELF itself
  (not the ones that failed to load) ∪ the sessions those transcripts' parses folded.** The
  widget's own read discovers those transcripts to merge them; building the in-self set
  discovers nothing more. `collectSelfAttributedSessionIds` becomes a pure union of what it is
  handed.

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
    descendant (three cases): its `share` is subtracted from this descendant's total. This fixes #180 item 1:
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
  is unchanged; the wording in spec-116 and spec-26 is corrected (#180 item 6).

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
- **Record choice.** `foldRecordIds` on a child with one fold on an untagged turn and one on a
  tagged turn returns the child and the tagged turn's fold only.
- **Daemon.** The daemon run on that root, which also has a Task child, writes `_fold` records
  for C, G and the Task child and nothing else. The tag reads `swept`, and
  `readTagFileWithVerdict(...).folded` holds all three.
- **#178.** The walk decides the skip from the in-self set before it resolves or reads anything.
  With C and G in the set, C's transcript unreadable, and ledger edges root → C and root → G:
  both are `in-self-total` and add nothing (#180 item 2 is the G edge). With C moved so that it
  no longer resolves: still `in-self-total`, never a gap.
- **#135 A.** C outside the in-self set, as a child with no fold record is, C readable, and a
  ledger edge root → C: C is counted in `spawned.total`.
- **#180 item 1.** In-self X, and a ledger descendant D whose parse also folds X: D's edge
  total equals D's own cost. The same holds for two ledger descendants that both fold X: X's
  cost is in `spawned.total` once.
- **#180 item 3.** An edge to X that is `unreadable` first (its newest copy cannot be read),
  then a descendant whose parse folds X's readable copy: `unattributed` is empty, and X's edge
  keeps `skip: "unreadable"`.
- **#180 item 4.** A descendant whose spawning turn is untagged, so its fold is outside its
  total, and whose folded session was counted under its own edge. The descendant keeps its own
  tagged cost; before this change the clamp zeroed it.
- **Items 5 and 6 have no check here.** Item 5 is structural: the walk's fold arithmetic sits
  outside the `try`. Item 6 is wording; its behaviour is pinned by C26b in
  `tests/wtft-116-spawn-ledger.test.ts`.
- **End to end.** `wtft --json` on a tag that records a child since moved to another project
  dir, with a ledger edge to it: the edge is `in-self-total`, and `tree` equals `total` in
  `costUsd` and `outputTokens`. The same tag without the record counts the child.

## Reconciliation record

Three `spec-reconcile` rounds, using fresh-context auditors on DeepSeek V4.1 Flash:
- **Round 1** audited every changed source file against its documents: the walk, the tag contract and the callers. It also ran the test variant and one host-scoped pass.
- **Round 2** re-audited what round 1 edited.
- **Round 3** re-audited this spec and its test.

The loop stopped at round 3, where the findings were re-discovered, declined, or already filed.

| Artifact | Claim | Contradicted by | Covered by a test? | Action |
|---|---|---|---|---|
| this spec | a fold on an untagged turn is neither subtracted nor marked | the daemon recorded it, so the CLI skipped it as `in-self-total` | ✅ U1 | **Code fixed**: `foldRecordIds` records only folds on model-tagged turns |
| this spec | the widget's in-self set is exactly its SELF | Task files that failed to load were in the set | `reconciled-against-untested` | **Code fixed**: only merged files are passed |
| this spec | "no discovery runs on either path" | the widget discovers Task files to merge them | — | Narrowed to "which sessions were folded" |
| this spec, tag format | `child` is a session id | a Task child's record is its `agent-<name>` filename | ✅ D1 | Stated per source |
| this spec, spec-116, tag format, CONTEXT | fold sources are Task and `claude -p` children | Pi sibling sessions are folded and recorded too | `reconciled-against-untested` | Named as a third source |
| spec-116, spec-26 | `depthCapped` counts every cut | an edge past the cap onto a session already reached is not a cut | ✅ C26b in `wtft-116` | Reworded (#180 item 6) |
| spec-116, CONTEXT, spec-26 | `unreadable` means "would not parse" | a stat failure is `unreadable` too | ✅ `wtft-133` | Added |
| spec-26 | `spawned.total` subtracts two cases | three: in SELF, counted, or folded earlier | ✅ W5 | Added the third |
| spec-176 §3 | the CLI passes a thunk | the CLI passes the tag's fold records as a Set | — | Updated |
| spec-116 | the `--tokens` block renders only with an edge | it also renders a ledger error or skipped lines | ✅ `wtft-176` | Updated |
| manifest `--json` | three floor conditions | four (`malformedLedgerLines`) | ✅ `wtft-116` | Added |
| manifest `--tokens` | UNCOUNTED line on every surface; no mention of SPAWNED/TREE | CLI only; the block exists | `reconciled-against-untested` | Scoped and added |
| CONTEXT | no entry for "fold record" | the term is new | — | Entry added |
| this spec's test | W1/W2 rest on the unreadable or moved transcript; P3, R3 and E1 lacked preconditions | the skip is decided before any read; each check could pass vacuously | — | Preconditions W1a, W2a, W6a, U0, E0 added; messages corrected |

Declined, each checked against the code:
- **A fold-only tag reads settled.** `hasClassified` counts a `_fold` line.
- **An in-self id can become `folded`.** An in-self id `continue`s before the mark.
- **The `"_fold"` substring pre-filter misses spaced JSON.** The substring survives any spacing.

Older drift found in the same passes, not caused by this branch: #200.

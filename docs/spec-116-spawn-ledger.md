# Spec — #116 direction A: the spawn ledger

> **Issue:** [#116](https://github.com/princess-pi/wtft/issues/116) — *Cost rollup misses
> launcher-spawned agent sessions.* Direction **A**, chosen by Duppy 2026-09-16.
> **Status:** this document specs the **wtft side** — the ledger format, the writer, the reader,
> and how the tree is reported. The **spawner side** (who calls the writer) is named in
> § Not in this change and tracked elsewhere.

## The gap this closes

A launcher-spawned session is a full `claude` started by a *launcher process* the parent invoked —
`herdr agent start`, a `pr-review` lens, a wrapper script — rather than by a `claude` command the
parent's own transcript contains. Today it contributes **zero** to the parent, for three reasons
that are all properties of the transcripts and none of which a parser can fix:

1. The shell runs the launcher, not `claude`. `commandSpawnsAgent` does fire — it matches
   `claude` anywhere in the command, including the `--kind claude` flag — but the child did not
   inherit the shell's working directory, so since #107 A the no-`cd` fallback deliberately does
   not stand in for it.
2. There is no `cd` on the spawning command. Since #107 A a spawn with no `cd` falls back to the
   session's own working directory, but only when the shell runs `claude` itself — a launcher
   starts its child somewhere the parent's cwd does not name, so nothing is searched for it.
3. The child's cwd is a worktree or a `/tmp` sandbox, so its transcript lands in a project dir the
   parent never wrote to.

**Neither transcript contains a field naming the other** — unless a launcher puts the parent's id
in the child's cwd, which #128's `named` tier reads. There is no edge to re-derive, so no
tagger version bump can reach it — measured on session `9f29d624…180d`, which reported $70.33 while
$69.68 of its own `pr-review` lens children sat **invisible** in ten `/tmp/pr-review-*` sandboxes.
Invisible, not `unattributed` — this document defines that term narrowly, as a RECORDED edge whose
child could not be read, and these children had no record at all. Using the defined word for the
undefined case is how a reader concludes the report already covers them.

Direction A writes the edge down **at spawn time**, when it is free, instead of reconstructing it
afterwards, when it is impossible.

## The ledger

**Path:** `$XDG_STATE_HOME/wtft/spawns.jsonl`, defaulting to `~/.local/state/wtft/spawns.jsonl`.
Append-only. One JSON object per line. No rewriting, no compaction, no deletion by wtft.

```json
{"schema":"wtft/spawn@1","ts":"2026-09-16T05:00:00Z","parent":"<uuid>","child":"<uuid>","mechanism":"pr-review-lens","cwd":"/tmp/pr-review-abc","label":"correctness","model":"opus"}
```

| Field | Required | Meaning |
|---|---|---|
| `schema` | yes | `wtft/spawn@1`. A reader skips any other value rather than guessing. |
| `ts` | yes | ISO-8601 UTC, when the edge was recorded — **not** when the child finished. `wtft spawn-record` fills it from the clock; there is deliberately no `--ts`, because a spawner-supplied timestamp is a way for the ledger to disagree with itself and buys nothing. Validated for ISO-8601 shape on write. |
| `parent` | yes | Session UUID of the spawning session. |
| `child` | yes | Session UUID of the spawned session. |
| `mechanism` | yes | Who made the edge: `pr-review-lens`, `herdr-agent-start`, … Free text, for the report. |
| `cwd` | no | The child's working directory, when the spawner knows it. Never used to *find* the child. |
| `label` | no | A human name for the child (`correctness`, `agent/824`). |
| `model` | no | The model the child was started with. |

**Both UUIDs are validated on write.** An unparseable id is a permanently unresolvable edge, and
catching it at the spawner is the only place it is still cheap.

**The spawner knows the child's id before the child runs.** `claude --session-id <uuid>` takes the
id as input, and `herdr agent start --json` returns it as `agent_session.value`. So the edge is
recorded *before* the spawn, and a child that crashes on line one still leaves a recorded,
resolvable-or-not edge instead of nothing.

**One line, one `write(2)`.** A record is appended with `O_APPEND` in a single write and refused
above 4 KiB, so two spawners appending concurrently cannot interleave a line. To be exact about
what that rests on: POSIX does not promise atomicity for a `write(2)` to a **regular file**, and
`PIPE_BUF` is the *pipe* guarantee. Linux holds the inode lock for the duration of one `write`,
which is what makes a single-call O_APPEND write land whole in practice; 4096 is a deliberately
conservative bound on how much we lean on that, and is where the number comes from.
Every text field — `ts` and `mechanism` included, not only the three optional ones — is capped at
512 bytes to keep that true in practice: five such fields alone are 2560 B (2.5 KiB), and with the
two session ids and the JSON punctuation around all eight fields the LARGEST possible record comes
to just under 3 KiB — an ordinary one, like the example line above, is about 200 bytes — and makes
the 4 KiB refusal a backstop reachable only through JSON escape expansion. The cap counts the
newline, because the newline is part of the write that has to land whole. A **short write** — a
`write(2)` that returns fewer bytes than it was given — is reported as a failed append rather than
retried: a retry would append the remainder as a second record.

## `wtft spawn-record` — the writer

```
wtft spawn-record --parent <uuid> --child <uuid> --mechanism <name>
                  [--cwd <path>] [--label <text>] [--model <name>] [--json]
wtft spawn-record --help
```

`--flag value` and `--flag=value` both work. An **unknown** flag is an error, not a shrug — the
report path silently ignores what it does not recognise (#91), and a typo'd `--mechansim` would
otherwise surface as "`--mechanism` is required", blaming the flag the caller did pass.

A positional subcommand: `argv[2]` exactly, dispatched instead of `main()`, so no session is
loaded, no daemon is started and no session file is read. Two things do still run first, because
they sit at module scope: the config load and the report's own argument parse. And because the
test is positional, `wtft --json spawn-record …` is **not** the subcommand — it is a report run
with some flags the report parser ignores.

| Exit | Meaning |
|---|---|
| 0 | Record appended — `--json` echoes the exact line written, and without it nothing is printed at all. Also `--help`, which appends nothing. |
| 2 | Bad arguments — a missing required flag, an unknown flag, a flag with no value, a malformed session id, or an oversized field. (`ts` is validated too, but nothing on the command line can set it — the flag does not exist and the clock fills it, so that cause is reachable only through the library.) |
| 3 | The record was valid and the ledger could not be written (unwritable state dir, ENOSPC, a short write). The edge is **not recorded**, so the child is **invisible**, not `unattributed` — see *How this is verified*. Nothing repairs a partial line; see *Simplification pass*. |

**It never blocks a spawn.** A spawner calls it and ignores the exit code; the failure is the
spawner's to log, and an unwritten edge leaves the child outside the tree — reported, since #128,
only in `spawned.unrecorded[]` when it matches a tier there.

## Reading, resolving, walking

**`readSpawnLedger()`** returns `{ childrenOf: Map<parent, SpawnEdge[]>, malformedLines: number }`.
It strips a trailing `.jsonl` from `parent` and `child`, so a session recorded once by id and once by
file name is one node (#138).
A line that is not JSON, does not carry `schema: "wtft/spawn@1"`, is missing a required field, or
carries a `parent`/`child` that is not uuid-shaped is **skipped and counted** — the count is
reported, so a broken writer is visible rather than quietly losing money. A blank line is skipped
and not counted: it is whitespace, not a failed record. **The reader enforces none of the writer's
size caps**; those guard the append, not the file.

**The whole file is read, or none of it is.** A ledger over 8 MiB — roughly 40,000 spawns — is
**refused**, and the refusal comes back as `ledgerError` with "prune it" in the message. An earlier
version read the last 8 MiB instead and reported the truncation, which cost a boolean on every
surface, an extra floor condition to explain, a boundary line dropped on every truncated read, and
a silent gap for any reader who ignored the flag. Refusing is simpler *and* stricter: a refusal
cannot omit an edge without saying so.

**Resolution goes through the harness seam** — `HarnessDiscovery.resolveSessionById`, asked of every
registered harness in turn (since #138, through each harness's `indexSessionsById` where it has
one, built once per walk and giving the same answers), so a Pi child resolves through Pi's discovery and a Claude Code child
through its own. This is not a preference: the repo's lookup already recurses past the `sessions/`
subdirectory older Claude Code installs use, skips the derived-data dirs, and takes the **newest**
copy where one id exists in several project dirs — the moved-session case (#155, #6), which is
precisely where a second implementation would price a child from a stale copy. A hand-rolled scan
of `<root>/<slug>/<id>.jsonl` was doing exactly that until the PR review caught it.

**A session id is "contains a uuid"**, the repo's own `isSessionIdBasename` rule, plus two
constraints the ledger adds because the id becomes a filename lookup: one path component, and
bounded at 128 bytes. A bare-uuid rule would mean a Pi session — whose basename is a timestamp
*prefixed* to a uuid — could never be a parent, which left the Pi widget's block unreachable on the
only harness it runs in.

The ledger deliberately does **not** record the session file's path: a worktree move relocates the
file (#6) and a recorded path would rot, while the id does not. A recorded `cwd` is carried into
the report for a human to read — it is never used to find anything.

**An unreadable ledger is not an empty one.** `computeSpawnTree` owns the read, and a failure
comes back as `ledgerError` with an otherwise-empty tree. Without that field an EACCES would
render and serialise exactly like "this session spawned nothing" — #116's own failure mode
reintroduced inside #116's fix. An *absent* ledger is not an error: nothing has spawned yet.

**The walk** is breadth-first through `childrenOf`, from the reported session and from every
session already inside a total (`docs/spec-230-231-232-spawn-tree-gaps.md` §2):

- **A session is counted at most once.** A `visited` set means a session is queued at most once,
  and the `outcomeOf` map records what happened the first time it was reached — except that an
  `unresolved` session becomes `folded` when a later descendant covers it — so a diamond (two
  recorded edges to the same child) or a cycle contributes its cost once, not twice.
- **The walk is breadth-first**, which is a correctness property rather than a taste: it reaches
  every session at its MINIMUM depth. Depth-first marked a child seen at whatever depth ledger
  order happened to reach it first, so a session recorded both at the end of a long chain and
  directly under the root had its own children cut although they sit two levels down — the reported
  tree depended on the order lines were appended in.
- **Depth is bounded at 5** and the bound in force is reported. Direct children are depth 1, so
  five generations are walked and the sixth is cut. An in-self session's edges start at depth 2,
  and a session a descendant at depth *d* folds or lists as a subagent has its edges at *d* + 2,
  so the same cap applies below them. A cut is an edge past the cap onto a session
  not already reached; it is reported with `skip: "depth-capped"`, and `depthCapped` counts the
  cuts — not the sessions behind them, which are not enumerated. An edge past the cap onto a
  session reached earlier reports that session's outcome instead, and is not a cut. That is what a bound is; a non-zero `depthCapped` means the tree is known to
  be partial.
- **A child that does not resolve is `unattributed`** — the edge, its mechanism and its timestamp
  are reported with a `reason`, and its cost is `null`, never `0`. An unresolvable child is a
  *gap*, and a zero would launder it into a fact. Two reasons, kept apart: `not-found` (the lookup
  came back empty — the file is absent, or somewhere this process cannot read, and the walk cannot
  tell those apart, which is why the name does not claim absence) and `unreadable` (a file that
  cannot be read, has lines and not one that parses, or cannot be stat-ed — the child's own
  transcript, any subagent transcript discovery lists for it, or that discovery itself; the only
  skip class that is a bug rather than a fact). **One entry per session, not per edge**: two edges
  onto the same missing child are one gap. An entry is removed when a later descendant folds that
  session or lists it as a subagent, because its money has then landed.
- **The walk continues past a gap.** A child we cannot read may still have recorded children of
  its own, and those may be perfectly readable; its grandchildren are edges in the *ledger*, not
  entries in the file that is missing. Dropping the subtree with its parent loses real, resolvable
  money over one absent file.
- **`skip` is a six-value contract**: `not-found`, `unreadable`, `already-counted`,
  `already-seen-unresolved`, `in-self-total`, `depth-capped`. Only the first two are
  `unattributed`. `already-seen-unresolved` exists because `already-counted` asserts the money
  landed, which is false for a second edge onto a child the first visit could not read. Once a
  later descendant has covered that child, a further edge onto it reads `already-counted`.
  `in-self-total` is a child whose cost is already inside `total`: a session the tag's fold
  records name (`docs/spec-178-135-180-fold-records.md`): a `claude -p` child at any depth
  (#138), or a Pi sibling session whose header names this session as `parentSession`; or the
  reported session itself, reached round a cycle. The records also name Task children under
  `<session>/subagents/` (#82/#83), but a ledger id must contain a UUID and a Task child's
  `agent-<name>` does not, so no edge reaches one. It is reported and never added, because billing twice is
  the expensive direction to be wrong in. `already-counted` is the same claim about the tree's
  own total, and covers a `claude -p` session a resolved descendant's parse folded in, or a
  subagent transcript discovery lists for that descendant: its money is in `spawned.total`. A
  resolved descendant's parse lists every session it folded on a deduplicated, model-tagged turn,
  at any depth, with that session's share. A session that is already in some total has its share
  subtracted from the descendant's; a subagent transcript already in some total is left out of the
  descendant whole. Any other is marked folded, and its own ledger children are walked. A Pi
  sibling of a descendant is such a subagent transcript, so it is priced inside whichever reaches
  it first: the descendant, or its own edge. A subagent transcript is marked folded whatever its
  turns are; an untagged turn in it is named in the descendant's `descendantUntagged` entry, not
  added to `spawned.total`.

## What gets reported

**`total` keeps meaning SELF.** This change does not move a single dollar into or out of the
existing TOTAL row, and nothing that was in it leaves it. The descendant money is a **new, named
quantity that sits beside it** — the same shape as the UNCOUNTED block (#149), and for the same
reason: a number the reader has never seen before must arrive labelled, not folded into one they
already trust.

**`--json`** gains a `spawned` object and a `tree` total:

```json
"spawned": {
  "schema": "wtft/spawn-tree@4",
  "descendants": 3,
  "edges": [{"parent":"…","child":"…","mechanism":"pr-review-lens","ts":"…",
             "label":"correctness","model":"opus","cwd":"/tmp/pr-review-abc","depth":1,
             "resolved":true,"path":"/home/…/<child>.jsonl","total":{…},"live":false},
            {"parent":"…","child":"…","mechanism":"pr-review-lens","ts":"…","depth":1,
             "resolved":false,"path":null,"total":null,"skip":"not-found"}],
  "unattributed": [{"child":"…","mechanism":"…","ts":"…","label":"…","reason":"not-found"}],
  "depthCapped": 0,
  "maxDepth": 5,
  "malformedLedgerLines": 0,
  "ledgerError": null,
  "descendantUntagged": [],
  "total": {…},
  "unrecorded": []
},
"tree": {…}
```

`unrecorded` is #128's list of sessions no edge names, never summed into `total`, `spawned.total`
or `tree` —
`docs/spec-128-unrecorded-spawns.md`.

`tree` = `total` + `spawned.total`, as a field, so a consumer never has to add two numbers and
guess whether it double-counted. `label`, `model`, `cwd` and `skip` are present on an edge only
when they apply; `label`, `ts`, `mechanism`, `child` and `reason` are the shape of a gap. Because
`spawned.total` covers **resolved** descendants only (each with its subagent transcripts), `tree` is a **floor** under any of FIVE
conditions, and checking the first alone reads a truncated tree as complete: `unattributed` is
non-empty, `depthCapped` is non-zero, `ledgerError` is non-null, `malformedLedgerLines` is
non-zero, or `descendantUntagged` is non-empty (`docs/spec-194-p9-housekeeping.md` § H1). `ledgerError` and `malformedLedgerLines` are the traps. A ledger that could not be read sets none of the others, so a
consumer checking only those reads a zeroed tree as a complete lineage. And a malformed ledger line
**was a record**: its edge is lost, it produces no `unattributed` entry, and the count is the only
trace it leaves — so a tree with `malformedLedgerLines > 0` and none of the other four can still be
missing a descendant. Round 5 found this condition missing from all six surfaces that state it.

**`--tokens`** gains a block below TOTAL, rendered when this session has at least one edge, or when the ledger could not be read or had a line skipped (the block then says so instead):

```
SPAWNED    3 session(s) priced from 6 recorded edge(s) (#116) —
           NOT in TOTAL above, which is this session's own turns
           pr-review-lens  correctness                     $12.34
           pr-review-lens  reasoning                       $18.02
           herdr-agent-start  agent/824                    $26.67
           pr-review-lens  contract                    (not-found)
           pr-review-lens  crossfile                (depth-capped)
           herdr-agent-start  agent/831         (already-counted)
           1 unattributed — cost unknown, deliberately not estimated
           1 edge(s) past the depth cap of 5, not walked
           1 unusable ledger line(s) skipped
           1 descendant(s) with untagged turns — $0.00 left out of their edge totals (#180)
SPAWNED    subtotal                                        $57.03
TREE       TOTAL + SPAWNED                                 $127.36
```

**Every edge gets a row, skipped ones included** — the headline's two numbers agree with the rows
by construction, and they are deliberately in different units: sessions *priced*, from edges
*recorded*. Every skipped edge adds an edge without adding a session.

A skipped edge prints its **reason** where its cost would be. A dash or a `$0.00` would both read
as "this child was free", which is the one thing we do not know about it. The last four
indented lines appear only when they have something to say. The `SPAWNED subtotal` row exists so
`TREE` names an addend the block actually prints — the rows above it cannot be summed by eye once
one of them carries a reason instead of a number.

Three other shapes the block can take, none of them the same silence:

- **the ledger could not be read** — it says so, names the error, and prints **no `TREE` row**,
  because there is no tree to total.
- **no edges for this session, but the ledger has unusable lines** — it says that, because a
  damaged ledger is a fact about the ledger rather than about this session and is reported nowhere
  else on this surface.
- **no model-tagged turns at all** — the block still prints, below the "no model-tagged
  interactions" sentence. A session whose own turns are untagged can still have launched real
  money, and reporting that as nothing is the silence this issue is about.

**The Pi widget** (`extensions/wtft.ts`) renders the same block, including the ledger-error one.
It is a reader of the same report, and a Pi user seeing `TOTAL` with $69 of lens children unlisted
is exactly the gap this issue is about. It shows a failure rather than hiding it: the only case
that degrades to no block at all is a throw, which a widget refresh running every turn must
survive.

## How this is verified

The issue's own Closer, as `tests/wtft-116-spawn-ledger.test.ts`:

1. A parent transcript whose bash command is the `herdr agent start …` line — the one measured to
   yield no directory to search, since the shell runs the launcher rather than `claude`.
2. A child transcript with its own UUID in a different project dir.
3. A spawn record for the pair.

Then `wtft --json` reports the parent's self cost, the child's cost, a `tree` that is their sum,
and the edge's `mechanism`. That half is met, by D9–D13e.

**The second half is NOT met, and this spec is not going to reword it.** The issue's Closer says:

> Delete the record and the same run reports the child as **unattributed**, with the cost still
> visible somewhere — never dropped.

Direction A deletes the record and the child becomes *invisible*, not unattributed: with nothing
recorded, there is no id to look up and no edge to report. `unattributed` here means only "an edge
we have, whose child we could not read" — a narrower thing than the Closer asks for.

An earlier draft of this document quietly restated the clause as "reports `spawned.descendants` of
0", which the PR review caught. Moving an acceptance criterion to meet the implementation is worse
than missing it, because it removes the record that anything is outstanding.

**What the unmet clause actually needs** is a *listing* — the report the issue sanctions for
direction D and forbids for attribution: *"at most to **list** unattributed sessions near a parent,
which is a report, not a claim."* Sessions whose first timestamp falls near this session's turns, in
a project dir under this repo or its worktrees, shown with their cost and **never summed into
`tree`**. That is a second mechanism with its own design question (what counts as "near", and how a
peer session running at the same time is kept out of the list), so it is **#128**, not a late
addition here.

#128 has since landed: an unrecorded launcher child is listed in `spawned.unrecorded[]` with its
cost and a tier, never summed — `docs/spec-128-unrecorded-spawns.md`, whose Closer is this clause
run against the same kind of fixture.

Plus, each with its own test: UUID and ISO-8601 validation on write; the 4 KiB refusal, *executed*
through escape expansion rather than asserted as a constant; 24 concurrent appends making 24 intact
lines; a malformed line counted rather than swallowed; a diamond counted once **and its second edge
reported as `already-counted`**; a cycle terminating with the root on disk, so the guard is what is
measured rather than a missing fixture; the depth cut reported as an edge at the depth that
exceeded the cap; an unresolvable child reported as `unattributed` with a `null` cost, **and its
readable grandchild still counted**; `unreadable` distinguished from `not-found`; `label`,
`model` and `cwd` reaching the report; exit 2 for a typo'd flag that names itself, exit 3 for an
unwritable ledger; and the rendered `TREE` figure read off the table and held to `TOTAL + SPAWNED`
and to `--json`. The THREE chmod-000 cases — C21 (unreadable ledger), C24 (unreadable child) and
D23 (the rendered ledger error) — skip **visibly** when the process can read such a file.
`tests/wtft-131-132-spawn-tree-accounting.test.ts` pins the fold accounting: a grandchild folded in
two levels down is billed once under four ledger orders, and a session folded into a resolved
descendant is counted once in both orders: reported `already-counted` when the descendant is
reached first, subtracted from the descendant's total when its own edge is; a Pi sibling of a
descendant is priced once, inside the descendant when it is reached first and under its own edge
otherwise (spec-230).
`tests/wtft-129-projects-root.test.ts` pins that a parse folds a `claude -p` child found under
`WTFT_CLAUDE_PROJECTS_DIR`, and that no second `.ts` file under `extensions/` or `bin/` contains the literal `".claude", "projects"` pair.

## Not in this change

- **The spawner side.** `pr-review` and `agent-new` calling `wtft spawn-record` lives in
  `princess-pi-tools`, and this change ships first so there is something to call.
- **Folding descendants into TOTAL.** A separate decision, and it needs the interaction-level
  attribution rework in #107 / #14 / #94 first.
- **Listing an unrecorded child.** The Closer's second clause — #128, since landed
  (`docs/spec-128-unrecorded-spawns.md`). A spawner that never calls
  `spawn-record` is invisible to the walk; #128's listing reports it instead.
- **Live growth.** A long-lived interactive child's cost is read at the moment `wtft` runs; it is a
  snapshot and will be stale, which is #14 and is not made worse here.

---

## Reconciliation record (spec-reconcile, 2026-09-16)

Five auditors in fresh context, one per bounded artifact set, plus the Tier-4 host-scoped pass
(this branch touches `bin/` and `extensions/`, so reverse scope applied). The table is the
`#116`-scoped rows — every contradiction the audit found *in what this branch built or touched*.
Pre-existing drift the file-level sweep surfaced is filed, not listed here; see below.

| Artifact | Claim | Contradicted by | Covered by a test? | Action |
|---|---|---|---|---|
| this spec | "`computeSpawnTree` owns the read" | `SpawnTreeOptions.ledger` bypassed the try/catch, and `bin/wtft.ts`'s pending arm used it — emitting `ledgerError: null` for a ledger nobody opened | ✅ C21/C22, D13c | **Code fixed**: the option is deleted; the pending arm reads the ledger |
| this spec | "a node past the cap is reported … never silently dropped" | the walk `continue`s without recursing, so the subtree beyond a cut is not enumerated | ✅ C13b | Prose fixed — `depthCapped` counts cuts, not sessions |
| this spec | "A child that does not resolve is `unattributed`" | its whole subtree vanished with it, including readable grandchildren | ✅ C23/C23b/C23c | **Code fixed**: the walk continues past a gap |
| `wtft-renderer.ts` | `renderTokenSummary` returns one sentence with no model-tagged turns | a session with untagged turns and $69 of children reported nothing | ✅ (suite-wide green; the block now follows the sentence) | **Code fixed** |
| `wtft-renderer.ts` | a ledger of only malformed lines rendered as silence | `edges.length === 0` returned before the malformed-lines line | ⬜ `reconciled-against-untested` | **Code fixed** |
| `wtft-spawn-ledger.ts` | "one record is one atomic append" | `fs.writeSync`'s return was ignored; a short write left a truncated line and exited 0 | ⬜ `reconciled-against-untested` (a short write is not reproducible on demand) | **Code fixed**: a short write is exit 3 |
| this spec | "`ts` \| yes \| ISO-8601 UTC" | nothing validated it; `--ts banana` round-tripped | ✅ A9b | **Code fixed**: validated, and `--ts` removed |
| `wtft-spawn-ledger.ts` | "`line` — 1-based line number in the ledger" | after a tail read it is an offset into the window | n/a — field deleted | **Code fixed**: `SpawnEdge.line` is gone, and nothing read it |
| `wtft-spawn-tree.ts` | the ledger records `cwd` | the walk dropped it before the report | ✅ C25 | **Code fixed** |
| `wtft-spawn-tree.ts` | `emptyTotals` copied from `wtft-renderer.ts` | CLAUDE.md: "Shared code goes in `@princess-pi/libs`, never copied in" | ✅ (typecheck + suite) | **Code fixed**: exported and imported |
| `CONTEXT.md` | **Session** `_Avoid_: … transcript` | the new contract value was `no-transcript` | ✅ C24 | **Renamed** to `not-found` (via `no-session-file`; the PR review then showed the file may exist and simply be unreachable) |
| this spec, `spec-26-json.md` | "`PIPE_BUF` on Linux … atomic" | PIPE_BUF is the *pipe* guarantee; a regular file relies on the inode lock | n/a | Prose fixed — the real basis is stated, and 4096 named as a conservative bound |
| `spec-26-json.md` | example key order | `JSON.stringify` emits the literal's order, which put `spawned` 3rd | ✅ D13e | **Code fixed**: emission, interface and example all agree |
| `spec-26-json.md` | "`computeSessionSummary` … is the single aggregation" | it is called N+1 times per run since #116 | ✅ D22 (both surfaces agree) | Prose fixed — one *implementation*, many calls |
| `spec-26-json.md` | "the single exception of `uncounted`" | `spawned` is also passed in, and `tree` is computed inside the builder | ✅ D12/D21b | Prose fixed — three departures, named |
| `spec-26-json.md` | exit table omits 2 and 3 | the manifest it names as the source carries both | ✅ D8f/D8i | Prose fixed |
| this spec | "shares nothing with the report path" | `loadConfig` and `parseWtftCliArgs` run at module scope regardless | n/a | Prose fixed, and the positional-`argv[2]` rule stated |
| `extensions/wtft.ts` | "degrades to no block rather than throwing" | `computeSpawnTree` stopped throwing; the widget shows the error block | ⬜ `reconciled-against-untested` (no Pi harness in the suite) | Prose fixed |
| `wtft-renderer.ts` | "split out so the daemon/watch paths can reuse" | no daemon or watch path calls it — nor `renderUncountedBillables` | n/a | Prose fixed for the #116 one |
| test suite | "A9 the record cap is PIPE_BUF" | `MAX_RECORD_BYTES === 4096`, a constant compared to itself | ✅ A9 now executes the refusal | **Test fixed** |
| test suite | "C10 the root is never a descendant of itself" | passed with the guard deleted — the root had no session file on disk | ✅ C10 now puts one there | **Test fixed** |
| test suite | "D21 a TREE line beside TOTAL" | `/TREE/.test(out)` — a substring, not the number | ✅ D21/D21b/D22 | **Test fixed** |

Three rows are marked `reconciled-against-untested` — the malformed-lines render, the short-write
failure and the Pi widget's prose — and each is named in the table. The suite went from 68 to 99
assertions in this pass, and to 112 after PR review round 1.

**Filed rather than fixed** — the file-level sweep surfaced substantial drift that predates this
branch and is not about the spawn ledger: #123 (`wtft-renderer.ts` docstrings and banners), #124
(`docs/EXT_WTFT.html`), #125 (`CONTEXT.md` `_Avoid_` lists vs settled practice), #126 (the
manifest's CLI-vs-Pi divergences) and #127 (two exit-code paths that report success on failure).
Fixing them here would have buried a 600-line change in a 2,000-line one.

## PR review round 1 (2026-09-16)

Eight blocking findings, each reproduced against the code before adopting. All eight were real:
seven are fixed — six in code, one in prose — and one is declared rather than reworded (its own
row below says why). The table above's rows are unchanged, and these are additional.

| Finding | Verified? | Action |
|---|---|---|
| DFS order could depth-cap a subtree within the bound by another path | **Yes** — a session recorded both at the end of a chain and directly under the root | **Code**: breadth-first, so every session is reached at its minimum depth. C26/C26b/C26c |
| A ledger edge could double-count a child already folded into SELF | **Yes** — `cd /tmp/x && claude -p --session-id <uuid>` is both mechanisms at once | **Code**: `alreadyAttributed`; the edge is reported `in-self-total` and never added. Since #178 the CLI seeds it from the daemon's recorded fold ids and the widget from `collectSelfAttributedSessionIds`. C27–C27d |
| A repeat edge onto an unreadable child claimed `already-counted` | **Yes** — `seen.add` ran before the resolve | **Code**: the repeat repeats the first visit's outcome; one missing session is one gap. C28/C28b |
| `no-session-file` claimed absence the run cannot establish | **Yes** — an unreadable projects root produces the same outcome | **Code**: renamed `not-found`, and the name stops claiming |
| The Pi widget's root id could never match a ledger parent | **Yes** — Pi basenames are timestamp-prefixed, and the ledger demanded a bare uuid | **Code**: a session id is "contains a uuid", the repo's own rule |
| The child lookup disagreed with discovery's layout and duplicate rules | **Yes** — no `sessions/` recursion, no newest-mtime rule | **Code**: resolution goes through `HarnessDiscovery.resolveSessionById`. C29/C29b |
| `tree` is a floor in more cases than the docs named | **Yes** — depth cuts and the tail bound too | Prose, on all four surfaces |
| **Deleting the record makes the child disappear, not unattributed** | **Yes, and the spec had reworded the Closer to match** | **Declared, not reworded** — see *How this is verified*. The listing the clause needs is **#128** |

Ten advisory findings were taken as well, all prose: the `2 KiB` figure (that is the *maximum*
record; an ordinary one is ~200 bytes), the `--tokens` example that no renderer could produce, the
SPAWNED headline that counted priced sessions while saying "recorded", the widget catch's named
case that could not throw, the stale "shares nothing with the report path", the memo rationale that
described an invariant the cache does not have, the `ts` exit-2 cause that is unreachable from the
command line (the flag is gone), and three test comments restating claims this spec had already
retracted. One was declined: `spawned.ledgerError` having no exit code is deliberate, and
`docs/spec-26-json.md` now says why.

## PR review round 2 (2026-09-16)

Ten blocking findings. Nine were real; one is refuted below with the code that disproves it.

| Finding | Verified? | Action |
|---|---|---|
| Children of an `in-self-total` session were never walked | **Yes** — only that child's own transcript is inside SELF; the launcher children *it* recorded are not | **Code**: the seeded ids are descended into once. This is the nesting the issue expects — a `claude -p` child dispatching its own lenses, every one of them dropped. C30/C30b |
| A descendant's own folded children could be billed twice | **Yes** — `parseSessionFile` rolls them into the descendant, and the root's guard does not reach a descendant | **Code**: each descendant contributes its own self-attributed ids to the walk, from the parse it already did |
| The Pi widget passed no `alreadyAttributed` | **Yes** — `readInteractions` merges every subagent into SELF | **Code**: the widget passes the same guard the CLI does |
| A short write corrupted the NEXT spawner's record | **Yes** — an unterminated fragment merges with the following `O_APPEND` | **Accepted, not repaired**: see *Simplification pass*. The merge costs one further edge and is reported as a counted malformed line. C32/C32b |
| The 8 MiB truncation reached no field | **Yes** — and the manifest claimed it was "reported in the document" | **Code**, then SIMPLIFIED AWAY: the windowed read is gone entirely (see *Simplification pass*), so there is no truncation left to report. C31/C31b |
| Exit 3 said the child becomes "unattributed"; the spec says invisible | **Yes** — my own contradiction, introduced with the Closer declaration | Prose: the exit-code tables say **invisible** |
| The spec called the walk depth-first, then breadth-first | **Yes** — plus a docstring naming two variables that no longer exist | Prose |
| `tree` floor: two surfaces still gave the narrow guarantee | **Yes** — the round-1 table claimed "all four surfaces" and missed `wtft-json.ts` and one spec line | Prose. Stated as three named conditions everywhere now |
| The ~2.2 KiB maximum record is not derivable | **Yes** — five 512-byte fields alone are 2.5 KiB; with two ids and keys it is under 3 | Prose |

**Refuted — the self-attribution set does not lose `commands` through the tag file.**
The finding reasoned that `collectSelfAttributedSessionIds` needed `interaction.commands` to
rediscover `claude -p` children, and that tag-derived interactions might not carry them. Both
fields survive the round trip — `serializeClassified` writes `cmd` and `t`, and
`classifiedToInteraction` reads both back — so the finding was refuted on the wire format.
It is moot as of #178: the set is now built from the daemon's recorded fold records and the folds
already on the interactions, and nothing on the read path rediscovers a child from its commands.

## PR review round 3 (2026-09-16) — the round limit, and where it leaves this

`PR_REVIEW_ROUND_LIMIT` is 3, and round 3 reached it (`pr-open` exit 10, no PR created). **The limit
was not raised.** Three findings were bugs introduced by rounds 1 and 2's own fixes, so they are
fixed here rather than handed over; the rest are recorded with their disposition.

| Finding | Verified? | Action |
|---|---|---|
| **High** — the descendant double-count guard was order-dependent | **Yes** — a session counted as its own edge first, then folded into a later descendant, was billed twice; two depth-1 edges in the wrong ledger order were enough | **Code**: `countedTotals` remembers what each counted session contributed, and a descendant that also folds it in has it subtracted back out. Order-independent in both directions, pinned by `tests/wtft-131-132-spawn-tree-accounting.test.ts` |
| Fragment termination skipped the throwing case its own comment claimed to cover | **Yes** — on a throw, `written` is 0, so the `written > 0` guard was false | **Code**: termination is attempted whenever the write did not complete, and the error says whether it succeeded instead of promising that it did |
| `tree` read as complete when the ledger could not be read | **Yes** — `ledgerError` set none of the three documented floor conditions | Prose, four surfaces: it is a **fourth** condition, and the one a consumer is likeliest to miss |
| The `--tokens` headline's denominator counted edges while saying "sessions" | **Yes** | Prose + the rendered string: two units, named as such |
| Both specs still listed a `ts` cause for exit 2 that no command line can reach | **Yes** — round 1 removed the flag and the manifest, not the specs | Prose |

**Refuted — `unreadable` does not depend on an unverified assumption.** The finding suggested
`parseSessionFile` might warn rather than throw on a read failure, which would classify an
unreadable descendant as a `counted` $0 — the zero-laundering this spec forbids. It throws:
`tests/wtft-116-spawn-ledger.test.ts` C24 chmods a descendant to 000 and asserts
`unattributed[0].reason === "unreadable"`, and that assertion passes on this host. The behaviour is
pinned by a test, not by an assumption.

**Declined — the in-self set is re-derived rather than read back from the tag.** True, and
deliberate: the tag file does not carry `claudeSubAgentSessionIds`, so re-running the same
discovery over the same `cmd` and `t` fields is the only way to ask. Round 2 established that both
fields survive the tag round trip. Making the daemon serialise the ids is a tag-format change with
a version bump, which is a decision rather than a fix. *Superseded:* that decision was taken as
D1 on #194, and the daemon now records its folds (`docs/spec-178-135-180-fold-records.md`).

**Where this stops.** The remaining review state is accepted rather than argued down: the next gate
is Macroscope's single billed round at `pr-submit`, against the finished diff.

## Simplification pass (Duppy, 2026-09-16)

> "For disk-out-of-space errors or even memory-out-of-space errors, I'm okay with the simplest code
> path: abort all these tools, just reconstruct and parse files, and wait until there is enough
> disk space and memory. I don't want to spend a lot of time trying to handle out-of-memory and
> out-of-disk-space errors."

Two things built in review rounds 2 and 3 existed only to soften a full disk. Both came out, and
the net is **−53 lines of source** across the branch.

**1. Fragment termination, gone.** A short write left a partial line, and the next spawner's
`O_APPEND` merged into it, so one failure cost two edges. Round 2 wrote a best-effort terminating
newline; round 3 found that the guard skipped the throwing case its own comment claimed to cover;
the fix for that added two conditional error messages. All of it is now one `writeSync`, one count
check, one throw.

*What we accept instead:* under ENOSPC the fragment stays, and the next successful record merges
into it. That costs one further edge, and it is **reported, not silent** — the merged line comes
back from `readSpawnLedger` as a counted `malformedLines`, which every surface prints. Twenty lines
of repair machinery bought the difference between one reported loss and two, at the moment the disk
is full and the remedy is a disk with space on it.

**2. The 8 MiB tail window, gone — replaced by a refusal.** The reader took the last 8 MiB of an
oversized ledger and reported the truncation. That cost a boolean on `SpawnLedger`, another on
`SpawnTree`, a fourth floor condition in four documents, an extra render branch, a boundary line
dropped on every truncated read, and a silent gap for any reader who ignored the flag. Now the
reader takes the whole file or refuses it, and the refusal arrives as `ledgerError` with "prune it"
in the message.

**Simpler *and* stricter**, which is why this one is not a trade: a refusal cannot omit an edge
without saying so, and a window always could.

**Not removed, and here is the reasoning.** The `countedTotals` / `subtractTotals` pair that makes
descendant double-counting order-independent is the other piece of machinery this branch carries,
and it is *not* in this class: it does not soften a resource failure, it stops `tree` reporting a
number that is wrong in the expensive direction. Removing it would trade ~20 lines for a wrong
total whenever a spawner records an edge for a child some other mechanism already folded in.
Worth knowing it is there; it is the branch's remaining concentration of subtlety. *Superseded:*
`countedTotals` is gone. A descendant now subtracts the share its own parse recorded for each
session already counted, which is exact (`docs/spec-178-135-180-fold-records.md`).

## Review round 4 — the round that checked whether the last three landed

Nineteen findings, nine blocking. The finding that matters most is not on the list: **four of
the corrections this document already recorded as fixed had never been written to the file.**
Round 1 and round 2 each closed with a table row saying so, and the stale sentence was still
there. A table row is a claim like any other, and nothing was checking it.

So every correction in round 4 was grep-verified before the commit, and the grep is in the
commit message rather than in a promise.

| # | Finding | Verified | Action |
|---|---|---|---|
| 1 | `CONTEXT.md` glossary teaches the retired 8 MiB tail-window read | Yes | Prose — the ledger is read whole or refused |
| 2 | `CONTEXT.md` Self/tree lists "older than the ledger's tail read" as a floor condition | Yes | Prose — the three real floor conditions, matching README and this spec |
| 3 | `docs/EXT_WTFT.html` spec index repeats the 8 MiB claim | Yes | Prose |
| 4 | "roughly 2.2 KiB" maximum record is not derivable from the constants | Yes | Prose — recomputed at just under 3 KiB; the "4 KiB only via escape expansion" conclusion survives |
| 5 | Walk comment names `seen` and `alreadyCounted`, neither of which exists | Yes | Prose — `outcomeOf`, `visited`, `countedTotals`; the spec's walk section too |
| 6 | `bin/wtft.ts` still claims spawn-record "shares nothing with the report path" | Yes | Prose — the module-scope work is admitted |
| 7 | Widget catch names a case that cannot reach it | Yes | Prose — stated as a last-resort guard with no named reachable case |
| 8 | Round-1 record's counts do not match its own table | Yes | Prose — eight real, seven fixed, one declared; ten advisories, not twelve |
| 9 | `projectsDir` export rationale names a caller that does not exist | Yes | Prose — the export rationale corrected |
| 10 | `DEFAULT_MAX_DEPTH` claims the cap prevents a filesystem walk | Yes | Prose — the cap bounds chain length, not breadth, and `resolveSessionById` walks per edge |
| 11 | Subtraction comment claims "exact" for two different summation paths | Yes | Prose — stated as expected, not guaranteed, with the `Math.max(0, …)` clamp named |
| 12 | **The rendered empty-report arms drop the spawned lineage** | Yes | **Code** — `finishEmptyReport` renders the block; D24 |

Two findings needed no change and are recorded as already-correct rather than re-fixed: the
ordinary-record figure (already ~200 bytes, consistent with 8 MiB ≈ 40,000 spawns), and the
three `reconciled-against-untested` rows.

### Finding 12, which was a real bug

`--json` reported `spawned` on the pending and no-data arms through `emitSessionJson`. The
rendered arms returned inside `finishEmptyReport`, before `renderTokenSummary` was reached. So
a parent whose own tag had no classified data yet — **the ordinary state of a launcher that
spawns and then waits**, which is the whole case this issue exists for — printed nothing about
children worth real money and exited 0. Two surfaces, one state, opposite answers, and the
rendered one was the silence #116 was opened to end.

D24 pins it end to end: an empty own-total with a recorded edge now prints

```
Daemon started on session c47f1a90-111… — no data yet. Try again in a moment.

SPAWNED    1 session(s) priced from 1 recorded edge(s) (#116) —
           NOT in TOTAL above, which is this session's own turns
```

with `total` still exactly 0 and `tree` carrying the descendant's $0.17, and `--json`
reporting the same one descendant.

**A fixture bug wearing the costume of the contract violation.** D24's first draft gave the
empty parent the same session uuid as the populated fixture. The moved-session follow (#155)
resolved the empty path to the populated copy, and the run reported that session's $0.0315 as
"the empty parent's own total" — which is exactly what folding descendants into `total` would
look like. Worth recording because the failing assertion was right and the fixture was wrong,
and the tempting move was to relax the assertion.

### Still open after round 4

| Finding | Where it goes |
|---|---|
| The Closer's second clause — an unrecorded child is dropped, not listed as unattributed | **#128**, declared in this spec, needs a direction chosen |
| `in-self-total` reported for an id folded into a DESCENDANT, where the money is in `spawned.total` rather than in `total` | **#131** — decided B: the id reports `already-counted`; fixed |
| An `in-self` child is queued but never parsed, so a grandchild it folded in could be billed twice | **#132** — verified: the fold is recursive, so it was billed twice; the walk now closes both fold sets transitively |
| A live descendant is priced from a one-shot parse and reported as settled, with no `provisional` | Semantics to pin down; no field currently says the tree may still grow |
| Self-attribution discovery runs eagerly even when the ledger holds no edges for the session | **#134 B** — fixed: `alreadyAttributed` takes a thunk (spec-176); since spec-230 it is called whenever the ledger holds any edge |
| The widget swallows spawn-tree throws into a silence identical to "spawned nothing" | **#134 A** — an unreadable ledger reaches the widget as `ledgerError`, pinned by spec-176's test; any other throw still renders no block |

## Review round 5 — the ceiling, and the regressions round 4 shipped

Sixteen findings, eight blocking. `pr-open` exited **10**: the review-round ceiling
(`PR_REVIEW_ROUND_LIMIT`, 3 blocking rounds). **The limit was not raised.** The PR is not open,
and that is a decision for Duppy rather than for the fix loop — which is the entire reason the
ceiling exists.

**Five of the sixteen were introduced by round 4**, hours earlier. They are fixed here because
a defect shipped this afternoon is not a re-discovered finding; it is this round's own output.

| Finding | What round 4 did |
|---|---|
| `bin/wtft.ts` — the empty rendered arm printed `SPAWNED` *without* `--tokens`, while the populated arm prints it only inside `if (opts.tokens)` | **The fix for a mode disagreement introduced a fresh mode disagreement.** Plain `wtft` showed the lineage while the session had no data and dropped it the moment data arrived. Now gated on `--tokens`, matching the populated path and the README |
| `discovery.ts` — the docstring said `projectsDir` was "left exported and untouched" | The diff **created** the export, and the rationale it gave argued against having one |
| `wtft-spawn-tree.ts` — `subtractTotals`' own docstring still claimed the subtraction is "exact" | Round 4 corrected the claim **at the call site** and left the function's own copy standing. This is the unwritten-correction pattern round 4 was *named for*, one round later |
| `bin/wtft.ts` — the memo comment said "two call sites" | The same commit added the third. This file's own rule is that a wrong call-site count is how a reader learns to distrust the comments |
| `wtft-json.ts` — "`tree` is an addition of two results, not a third way of counting" | Ignores `subtractTotals`. The surviving guarantee is "nothing counts a turn a second way"; "addition only" is not true |

### The one that was a real contract gap: a fourth floor condition

Six surfaces stated that `tree` is a floor under **three** conditions. A **malformed ledger
line was a record**: its edge is lost, it produces no `unattributed` entry, and
`malformedLedgerLines` is the only trace it leaves. So a tree with `malformedLedgerLines > 0`
and none of the other three can still be missing a descendant, and a consumer following the
documented check reads it as complete.

Fixed in all six: `README.md`, `CONTEXT.md`, `docs/spec-26-json.md`, this file,
`extensions/lib/wtft-json.ts`, `extensions/lib/wtft-spawn-tree.ts`.

### Two more terms used against their own definitions

- The headline example said `$69.68 … unattributed`. This document defines `unattributed`
  narrowly — a **recorded** edge whose child could not be read — and those children had no
  record at all. They were **invisible**, which is the word for the case #116 exists to close.
  Using the defined word for the undefined case is how a reader concludes the report already
  covers them. Fixed in `README.md` and here.
- "The two chmod-000 cases" — the suite has three: C21, C24 and D23.

### Carried forward, unfixed, each with an owner

`pr-open` found these again; they are the same items round 4 recorded, and they are issues
rather than spec sections so they can be listed, assigned and closed.

| Finding | Issue |
|---|---|
| The Closer's second clause: an unrecorded child is invisible, not unattributed | **#128** — Duppy picks the direction |
| `in-self-total` names `total` when the money is in `spawned.total` | **#131** — fixed: decided B |
| A double-count guard that misses ids already marked `in-self`, from `alreadyAttributed` or from an earlier descendant | **#132** — the grandchild case is fixed: both fold sets are closed transitively, for every member that resolves. A descendant folding an id already marked `in-self` or `folded` is **#180** |
| A live descendant priced from a one-shot parse and reported as settled | **#133** — Duppy |
| The widget's silent failure, and eager discovery on the no-edge path | **#134** — fixed by spec-176 |
| The in-self set re-derived at CLI time and compared against a total the daemon folded earlier; and the pending arm re-deriving what `pending` was meant to freeze | **#135** — Princess Pi |

**The stop rule held.** Two rounds of re-discovered findings is the signal to stop and report,
and `PR_REVIEW_ROUND_LIMIT` is never raised to get past it.

## Macroscope, on PR #136 — the ledger is untrusted input, and it was read as if it were not

Six findings on the opened PR. Three restate ones already filed (#131/#132, #135, #134 B) and
are left with their issues. Three were new, and two of those were hangs.

### Terminal injection through `mechanism` and `label` (Medium)

Both fields are **free text supplied by a spawner**, and the `SPAWNED` block prints them into a
padded column. A newline round-trips through JSON perfectly — `JSON.stringify` escapes it,
`JSON.parse` restores it — so the padded row was really two, and a spawner could
**forge report lines showing whatever money it liked**. An `ESC` starts an OSC sequence that the
reader's terminal executes.

Neither is exotic. A label is the obvious place to put a command line, and command lines carry
escape codes.

**Two layers, because one is not enough.** The writer refuses every C0/C1/DEL character
outright, naming the field — that is the by-construction half, and a bad record never reaches
the file. The renderer sanitises anyway, because the ledger is *a file on disk*: it can be
hand-edited, and it can hold records written by an older binary that had no such check. A
renderer that trusts its input is the one place a writer guarantee cannot reach. The
substitution is U+FFFD rather than deletion, so a reader **sees** that something was there; a
silently shortened label reads as the spawner's own text.

This is the repo's own rule arriving where it was missing: everything not authored by Duppy is
data. The ledger is written by launchers, and the report was rendering it as if it were ours.

### The same column, measured in the wrong space (Medium)

A later round found the row's OTHER half wrong. `full.length > 40` and `padEnd(40)` both count
UTF-16 **code units**; a terminal lays out **columns**. A BMP wide character — CJK, Hangul, the
fullwidth forms — is one code unit and two columns, so forty of them slipped past the width
guard untouched, `padEnd` added nothing, and every money figure in the block shifted right by
forty. Measured: `貓`×40 put the money column at 85 where ASCII put it at 65.

This is **#130's defect wearing different clothes** — a count taken in one space and spent in
another. There it was a byte offset used as a string index; here it is a code-unit count used
as a column width. `getVisualLength` already existed, in the same file, for exactly this.

`fitVisual(str, width)` now truncates and pads in the space the terminal actually uses, and the
row calls it. Astral emoji are the reason a casual fixture would have missed this: a surrogate
pair is two code units **and** two columns, so the two measures agree by coincidence and a 🐱
label renders correctly against the broken code. The test uses CJK deliberately and asserts
that divergence as a precondition (`D28`), so it cannot quietly stop exercising the bug.

**And the test guarding the injection above could not fail.** Deleting `safe()` from the row
left `D25c` and `D25d` GREEN — verified by mutation, not by reading. Two independent causes:
`D25c`'s payload sat beyond the 40-column field, so *truncation* removed it rather than the
sanitiser; and `D25d` asserted that no OSC sequence survived when the fixture **contained no
OSC sequence at all** — the absence of something never present. Both fixtures now put the
payload inside the visible field, and all three assertions fail under that mutation and pass
when it is reverted. A green suite was not evidence; the mutation was.

### A FIFO at the ledger path hung the report, and the writer (High, High)

`readLedgerText` did `statSync(path)` and then `readFileSync(path)`. That sequence is wrong
twice:

- **TOCTOU.** The size that passed the 8 MiB check belonged to a file that may have grown before
  the second call opened it — and growing is the *normal* case, since spawners append
  concurrently. The advertised refusal did not hold, and the report path could read a ledger of
  any size into memory.
- **A named pipe never returns.** `readFileSync` on a FIFO with no writer blocks forever, so
  `wtft --json` **hung** rather than reporting `spawned.ledgerError`. `statSync` describes a FIFO
  perfectly happily. The writer had the same shape: `openSync(file, "a")` blocks on a FIFO before
  it can exit 3.

Both now **open once with `O_NONBLOCK` and ask the descriptor**: `fstat` it, refuse anything that
is not a regular file, check the size of the thing actually opened, and read from that same
descriptor with a bounded buffer. There is no second lookup for a race to sit inside, and
`O_NONBLOCK` makes the FIFO case return instead of hang while being inert on a regular file.

**Measured, not argued.** D26 against the pre-fix code: `signal=SIGTERM, error=spawnSync node
ETIMEDOUT` on the reader, and the same on `spawn-record`, which exited `null` instead of 3. The
timeout *is* the assertion — a test that only checked an exit code would have passed by hanging.

### One fixture that had quietly stopped testing its subject

A9 reached `MAX_RECORD_BYTES` using `\u0001` as filler, 6 wire bytes per character and the
cheapest route to 4096. The new writer check refuses control characters on a *different* branch
first, so A9 began passing for the wrong reason and no longer exercised the record cap at all.
The filler is now a double-quote: 2 wire bytes against 1 on the field cap, so five capped fields
still overflow 4096 and the cap stays reachable.

Worth recording because nothing failed. A guard added in one place silently retired a test in
another, and the only signal was a changed error message inside a passing assertion.


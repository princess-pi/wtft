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

1. The command head is the launcher, not `claude`, so `commandSpawnsAgent` never fires.
2. There is no `cd` on the spawning command, so `cwdForClaudeSpawn` returns null and
   `attributeClaudeSubAgentCosts` hits its `if (!cwd) continue`.
3. The child's cwd is a worktree or a `/tmp` sandbox, so its transcript lands in a project dir the
   parent never wrote to.

**Neither transcript contains a field naming the other.** There is no edge to re-derive, so no
tagger version bump can reach it — measured on session `9f29d624…180d`, which reported $70.33 while
$69.68 of its own `pr-review` lens children sat unattributed in ten `/tmp/pr-review-*` sandboxes.

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
spawner's to log, and an unwritten edge degrades to exactly today's behaviour.

## Reading, resolving, walking

**`readSpawnLedger()`** returns `{ childrenOf: Map<parent, SpawnEdge[]>, malformedLines: number }`.
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
registered harness in turn, so a Pi child resolves through Pi's discovery and a Claude Code child
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

**The walk** is breadth-first from the reported session through `childrenOf`:

- **A session is counted at most once.** A `visited` set means a session is queued at most once,
  and the `outcomeOf` map records what happened the first time it was reached — so a diamond (two
  recorded edges to the same child) or a cycle contributes its cost once, not twice.
- **The walk is breadth-first**, which is a correctness property rather than a taste: it reaches
  every session at its MINIMUM depth. Depth-first marked a child seen at whatever depth ledger
  order happened to reach it first, so a session recorded both at the end of a long chain and
  directly under the root had its own children cut although they sit two levels down — the reported
  tree depended on the order lines were appended in.
- **Depth is bounded at 5** and the bound in force is reported. Direct children are depth 1, so
  five generations are walked and the sixth is cut. Each cut is an edge in the report carrying
  `skip: "depth-capped"`, and `depthCapped` counts the cuts — not the sessions behind them, which
  are not enumerated. That is what a bound is; a non-zero `depthCapped` means the tree is known to
  be partial.
- **A child that does not resolve is `unattributed`** — the edge, its mechanism and its timestamp
  are reported with a `reason`, and its cost is `null`, never `0`. An unresolvable child is a
  *gap*, and a zero would launder it into a fact. Two reasons, kept apart: `not-found` (the lookup
  came back empty — the file is absent, or somewhere this process cannot read, and the walk cannot
  tell those apart, which is why the name does not claim absence) and `unreadable` (a file that
  would not parse — the only skip class that is a bug rather than a fact). **One entry per session,
  not per edge**: two edges onto the same missing child are one gap.
- **The walk continues past a gap.** A child we cannot read may still have recorded children of
  its own, and those may be perfectly readable; its grandchildren are edges in the *ledger*, not
  entries in the file that is missing. Dropping the subtree with its parent loses real, resolvable
  money over one absent file.
- **`skip` is a six-value contract**: `not-found`, `unreadable`, `already-counted`,
  `already-seen-unresolved`, `in-self-total`, `depth-capped`. Only the first two are
  `unattributed`. `already-seen-unresolved` exists because `already-counted` asserts the money
  landed, which is false for a second edge onto a child the first visit could not read.
  `in-self-total` is a child whose cost is already inside `total` — a `claude -p` child the
  parent's own turn names (#138), a Task child under `<session>/subagents/` (#82/#83), or the
  reported session itself reached round a cycle. It is reported and never added, because billing
  twice is the expensive direction to be wrong in.

## What gets reported

**`total` keeps meaning SELF.** This change does not move a single dollar into or out of the
existing TOTAL row, and nothing that was in it leaves it. The descendant money is a **new, named
quantity that sits beside it** — the same shape as the UNCOUNTED block (#149), and for the same
reason: a number the reader has never seen before must arrive labelled, not folded into one they
already trust.

**`--json`** gains a `spawned` object and a `tree` total, and the document schema bumps to
`wtft/session@2`:

```json
"spawned": {
  "schema": "wtft/spawn-tree@1",
  "descendants": 3,
  "edges": [{"parent":"…","child":"…","mechanism":"pr-review-lens","ts":"…",
             "label":"correctness","model":"opus","cwd":"/tmp/pr-review-abc","depth":1,
             "resolved":true,"path":"/home/…/<child>.jsonl","total":{…}},
            {"parent":"…","child":"…","mechanism":"pr-review-lens","ts":"…","depth":1,
             "resolved":false,"path":null,"total":null,"skip":"not-found"}],
  "unattributed": [{"child":"…","mechanism":"…","ts":"…","label":"…","reason":"not-found"}],
  "depthCapped": 0,
  "maxDepth": 5,
  "malformedLedgerLines": 0,
  "ledgerError": null,
  "total": {…}
},
"tree": {…}
```

`tree` = `total` + `spawned.total`, as a field, so a consumer never has to add two numbers and
guess whether it double-counted. `label`, `model`, `cwd` and `skip` are present on an edge only
when they apply; `label`, `ts`, `mechanism`, `child` and `reason` are the shape of a gap. Because
`spawned.total` covers **resolved** descendants only, `tree` is a **floor** under any of THREE
conditions, and checking the first alone reads a truncated tree as complete: `unattributed` is
non-empty, `depthCapped` is non-zero, or `ledgerError` is non-null. The last is the trap: a ledger
that could not be read sets neither of the other two, so a consumer checking only those reads a
zeroed tree as a complete lineage.

**`--tokens`** gains a block below TOTAL, rendered only when this session has at least one edge:

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
SPAWNED    subtotal                                        $57.03
TREE       TOTAL + SPAWNED                                 $127.36
```

**Every edge gets a row, skipped ones included** — the headline's two numbers agree with the rows
by construction, and they are deliberately in different units: sessions *priced*, from edges
*recorded*. A diamond, a cycle, an in-self child and a depth cut each add an edge without adding a
session.

A skipped edge prints its **reason** where its cost would be. A dash or a `$0.00` would both read
as "this child was free", which is the one thing we do not know about it. The last three
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
   return `null` from `cwdForClaudeSpawn`.
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

Until #128 lands, an unrecorded launcher child is **silently missing**, exactly as it is today —
which is why #116 stays open when this merges.

Plus, each with its own test: UUID and ISO-8601 validation on write; the 4 KiB refusal, *executed*
through escape expansion rather than asserted as a constant; 24 concurrent appends making 24 intact
lines; a malformed line counted rather than swallowed; a diamond counted once **and its second edge
reported as `already-counted`**; a cycle terminating with the root on disk, so the guard is what is
measured rather than a missing fixture; the depth cut reported as an edge at the depth that
exceeded the cap; an unresolvable child reported as `unattributed` with a `null` cost, **and its
readable grandchild still counted**; `unreadable` distinguished from `not-found`; `label`,
`model` and `cwd` reaching the report; exit 2 for a typo'd flag that names itself, exit 3 for an
unwritable ledger; and the rendered `TREE` figure read off the table and held to `TOTAL + SPAWNED`
and to `--json`. The two chmod-000 cases skip **visibly** when the process can read such a file.

## Not in this change

- **The spawner side.** `pr-review` and `agent-new` calling `wtft spawn-record` lives in
  `princess-pi-tools`, and this change ships first so there is something to call.
- **Folding descendants into TOTAL.** A separate decision, and it needs the interaction-level
  attribution rework in #107 / #14 / #94 first.
- **Listing an unrecorded child.** The Closer's second clause — #128. A spawner that never calls
  `spawn-record` is invisible here, exactly as it is today.
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
| A ledger edge could double-count a child already folded into SELF | **Yes** — `cd /tmp/x && claude -p --session-id <uuid>` is both mechanisms at once | **Code**: `alreadyAttributed`, seeded by `collectSelfAttributedSessionIds`; the edge is reported `in-self-total` and never added. C27–C27d |
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
The finding reasons that `collectSelfAttributedSessionIds` needs `interaction.commands` for its
`claude -p` arm, and that tag-derived interactions may not carry them. The tag-file wire format is
`extensions/lib/wtft-daemon-lib.ts`, and it does: `serializeClassified` writes `cmd:
interaction.commands` and `t: interaction.timestamp`, and `classifiedToInteraction` reads both back
(`commands: obj.cmd || []`). Both fields the arm needs survive the round trip, and they are in the
"must stay in sync" pair the file names as its single source of truth. The finding was right that
the code assumed it — the assumption is now checked, and this paragraph is the check's record.

## PR review round 3 (2026-09-16) — the round limit, and where it leaves this

`PR_REVIEW_ROUND_LIMIT` is 3, and round 3 reached it (`pr-open` exit 10, no PR created). **The limit
was not raised.** Three findings were bugs introduced by rounds 1 and 2's own fixes, so they are
fixed here rather than handed over; the rest are recorded with their disposition.

| Finding | Verified? | Action |
|---|---|---|
| **High** — the descendant double-count guard was order-dependent | **Yes** — a session counted as its own edge first, then folded into a later descendant, was billed twice; two depth-1 edges in the wrong ledger order were enough | **Code**: `countedTotals` remembers what each counted session contributed, and a descendant that also folds it in has it subtracted back out. Order-independent in both directions. ⬜ `reconciled-against-untested` — see #129 |
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
a version bump, which is a decision rather than a fix.

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
Worth knowing it is there; it is the branch's remaining concentration of subtlety, and #129 is why
it has no regression test.

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
| 9 | `projectsDir` export rationale names a caller that does not exist | Yes | Prose — nothing outside the file imports it; the export is kept, the reason corrected |
| 10 | `DEFAULT_MAX_DEPTH` claims the cap prevents a filesystem walk | Yes | Prose — the cap bounds chain length, not breadth, and `resolveSessionById` walks per edge |
| 11 | Subtraction comment claims "exact" for two different summation paths | Yes | Prose — stated as expected, not guaranteed, with the `Math.max(0, …)` clamp named (#129) |
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
| `in-self-total` reported for an id folded into a DESCENDANT, where the money is in `spawned.total` rather than in `total` | Needs a decision: a seventh skip value, or a narrower contract for the existing one |
| An `in-self` child is queued but never parsed, so a grandchild it folded in could be billed twice | Unverified assumption about how deep `attributeClaudeSubAgentCosts` folds; #129 blocks the test |
| A live descendant is priced from a one-shot parse and reported as settled, with no `provisional` | Semantics to pin down; no field currently says the tree may still grow |
| Self-attribution discovery runs eagerly even when the ledger holds no edges for the session | Advisory, performance only |
| The widget swallows spawn-tree throws into a silence identical to "spawned nothing" | Advisory; the CLI reports `ledgerError`, the widget does not |

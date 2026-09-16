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
512 bytes to keep that true in practice, which puts an ordinary record at roughly 2 KiB and makes
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
| 2 | Bad arguments — a missing required flag, an unknown flag, a flag with no value, a malformed UUID, a `ts` that is not ISO-8601, or an oversized field. |
| 3 | The record was valid and the ledger could not be written (unwritable state dir, ENOSPC, a short write). |

**It never blocks a spawn.** A spawner calls it and ignores the exit code; the failure is the
spawner's to log, and an unwritten edge degrades to exactly today's behaviour.

## Reading, resolving, walking

**`readSpawnLedger()`** returns `{ childrenOf: Map<parent, SpawnEdge[]>, malformedLines: number }`.
A line that is not JSON, does not carry `schema: "wtft/spawn@1"`, is missing a required field, or
carries a `parent`/`child` that is not uuid-shaped is **skipped and counted** — the count is
reported, so a broken writer is visible rather than quietly losing money. A blank line is skipped
and not counted: it is whitespace, not a failed record. **The reader enforces none of the writer's
size caps**; those guard the append, not the file.

The read is bounded at 8 MiB from the tail. A truncated read starts mid-line, and a partial first
line is indistinguishable from a whole one from inside the window, so the first line is dropped
unconditionally — which past 8 MiB (roughly 40,000 spawns) costs one intact record. Edges older
than that window are not read, and appear in neither `edges` nor `malformedLedgerLines`.

**Resolution** maps a child UUID to a session file by looking for `<child>.jsonl` **one level**
under the Claude Code projects root — `~/.claude/projects/`, or `WTFT_CLAUDE_PROJECTS_DIR` where
that is set, the same seam discovery uses. One level, because a launcher-spawned session is a
top-level session in its own project dir; a Task-tool child under `<session>/subagents/` is a
different mechanism with its own discovery (#82/#83) and would be double-counted if it resolved
here.

The ledger deliberately does **not** record the session file's path: a worktree move relocates the
file (#6) and a recorded path would rot, while the UUID does not. A recorded `cwd` is carried into
the report for a human to read — it is never used to find anything.

**An unreadable ledger is not an empty one.** `computeSpawnTree` owns the read, and a failure
comes back as `ledgerError` with an otherwise-empty tree. Without that field an EACCES would
render and serialise exactly like "this session spawned nothing" — #116's own failure mode
reintroduced inside #116's fix. An *absent* ledger is not an error: nothing has spawned yet.

**The walk** is depth-first from the reported session through `childrenOf`:

- **A session is counted at most once.** A `seen` set over session ids means a diamond (two
  recorded edges to the same child) or a cycle contributes its cost once, not twice.
- **Depth is bounded at 5** and the bound in force is reported. Direct children are depth 1, so
  five generations are walked and the sixth is cut. Each cut is an edge in the report carrying
  `skip: "depth-capped"`, and `depthCapped` counts the cuts — not the sessions behind them, which
  are not enumerated. That is what a bound is; a non-zero `depthCapped` means the tree is known to
  be partial.
- **A child that does not resolve is `unattributed`** — the edge, its mechanism and its timestamp
  are reported with a `reason`, and its cost is `null`, never `0`. An unresolvable child is a
  *gap*, and a zero would launder it into a fact. Two reasons, kept apart: `no-session-file` (no
  file by that uuid) and `unreadable` (a file that would not parse — the only skip class that is a
  bug rather than a fact).
- **The walk continues past a gap.** A child we cannot read may still have recorded children of
  its own, and those may be perfectly readable; its grandchildren are edges in the *ledger*, not
  entries in the file that is missing. Dropping the subtree with its parent loses real, resolvable
  money over one absent file.
- **`skip` is a four-value contract**: `no-session-file`, `unreadable`, `already-counted`,
  `depth-capped`. Only the first two are `unattributed`.

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
             "resolved":false,"path":null,"total":null,"skip":"no-session-file"}],
  "unattributed": [{"child":"…","mechanism":"…","ts":"…","label":"…","reason":"no-session-file"}],
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
`spawned.total` covers **resolved** descendants only, `tree` is a **floor** whenever
`unattributed` is non-empty.

**`--tokens`** gains a block below TOTAL, rendered only when this session has at least one edge:

```
SPAWNED    3 descendant session(s) recorded in the spawn ledger (#116) —
           NOT in TOTAL above, which is this session's own turns
           pr-review-lens  correctness                     $12.34
           pr-review-lens  reasoning                       $18.02
           herdr-agent-start  agent/824                    $26.67
           pr-review-lens  contract               (no-session-file)
           1 unattributed — cost unknown, deliberately not estimated
           2 edge(s) past the depth cap of 5, not walked
           1 unusable ledger line(s) skipped
SPAWNED    subtotal                                        $57.03
TREE       TOTAL + SPAWNED                                 $127.36
```

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
and the edge's `mechanism`. **Delete the record** and the same run reports `spawned.descendants`
of 0 — and the assertion that pins the gap is that the *self* number is unchanged either way, so
the ledger only ever adds.

Plus, each with its own test: UUID and ISO-8601 validation on write; the 4 KiB refusal, *executed*
through escape expansion rather than asserted as a constant; 24 concurrent appends making 24 intact
lines; a malformed line counted rather than swallowed; a diamond counted once **and its second edge
reported as `already-counted`**; a cycle terminating with the root on disk, so the guard is what is
measured rather than a missing fixture; the depth cut reported as an edge at the depth that
exceeded the cap; an unresolvable child reported as `unattributed` with a `null` cost, **and its
readable grandchild still counted**; `unreadable` distinguished from `no-session-file`; `label`,
`model` and `cwd` reaching the report; exit 2 for a typo'd flag that names itself, exit 3 for an
unwritable ledger; and the rendered `TREE` figure read off the table and held to `TOTAL + SPAWNED`
and to `--json`. The two chmod-000 cases skip **visibly** when the process can read such a file.

## Not in this change

- **The spawner side.** `pr-review` and `agent-new` calling `wtft spawn-record` lives in
  `princess-pi-tools`, and this change ships first so there is something to call.
- **Folding descendants into TOTAL.** A separate decision, and it needs the interaction-level
  attribution rework in #107 / #14 / #94 first.
- **Pi children, and anything not one level under the projects root.** Resolution searches Claude
  Code's project dirs, one level deep; a Pi child, or a session file nested deeper, is
  `unattributed` with reason `no-session-file` until the harness seam grows a lookup (#156).
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
| `CONTEXT.md` | **Session** `_Avoid_: … transcript` | the new contract value was `no-transcript` | ✅ C24 | **Renamed** to `no-session-file` while it was still free |
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

One row is `reconciled-against-untested` three times over; each is named above. The suite went
from 68 to 99 assertions in this pass.

**Filed rather than fixed** — the file-level sweep surfaced substantial drift that predates this
branch and is not about the spawn ledger: #123 (`wtft-renderer.ts` docstrings and banners), #124
(`docs/EXT_WTFT.html`), #125 (`CONTEXT.md` `_Avoid_` lists vs settled practice), #126 (the
manifest's CLI-vs-Pi divergences) and #127 (two exit-code paths that report success on failure).
Fixing them here would have buried a 600-line change in a 2,000-line one.

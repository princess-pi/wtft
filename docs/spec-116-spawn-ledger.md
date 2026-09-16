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
| `ts` | yes | ISO-8601 UTC, when the edge was recorded — **not** when the child finished. |
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

**One line, one `write(2)`.** A record is appended with `O_APPEND` in a single write and is refused
above 4 KiB (`PIPE_BUF` on Linux), so two spawners appending concurrently cannot interleave a line.
`cwd`, `label` and `model` are each capped at 512 bytes to keep that true in practice.

## `wtft spawn-record` — the writer

```
wtft spawn-record --parent <uuid> --child <uuid> --mechanism <name>
                  [--cwd <path>] [--label <s>] [--model <s>] [--json]
```

A positional subcommand, checked before flag parsing, so it shares nothing with the report path.

| Exit | Meaning |
|---|---|
| 0 | Record appended. `--json` echoes the exact line written. |
| 2 | Bad arguments — missing required flag, malformed UUID, oversized field. |
| 3 | The ledger could not be written (unwritable state dir, ENOSPC). |

**It never blocks a spawn.** A spawner calls it and ignores the exit code; the failure is the
spawner's to log, and an unwritten edge degrades to exactly today's behaviour.

## Reading, resolving, walking

**`readSpawnLedger()`** returns `{ childrenOf: Map<parent, SpawnEdge[]>, malformedLines: number }`.
A line that is not JSON, or does not carry `schema: "wtft/spawn@1"`, or is missing a required
field, is **skipped and counted** — the count is reported, so a broken writer is visible rather
than quietly losing money. The read is bounded at 8 MiB from the tail, dropping a leading partial
line; past that the ledger is older than any live session's lineage.

**Resolution** maps a child UUID to a transcript by looking for `<child>.jsonl` under
`~/.claude/projects/*/`. The ledger deliberately does **not** record the transcript path: a
worktree move relocates the file (#6) and a recorded path would rot, while the UUID does not.

**The walk** is depth-first from the reported session through `childrenOf`:

- **A session is counted at most once.** A `seen` set over session ids means a diamond (two
  recorded edges to the same child) or a cycle contributes its cost once, not twice.
- **Depth is bounded at 5** and stated. A lens child spawning its own children nests, so this
  recurses; a node past the cap is reported as `depth-capped`, never silently dropped.
- **A child that does not resolve is `unattributed`** — the edge, its mechanism and its timestamp
  are reported with a `reason`, and its cost is `null`, never `0`. An unresolvable child is a
  *gap*, and a zero would launder it into a fact.

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
  "edges": [{"parent":"…","child":"…","mechanism":"pr-review-lens","ts":"…","depth":1,
             "resolved":true,"path":"/home/…/<child>.jsonl","total":{…}}],
  "unattributed": [{"child":"…","mechanism":"…","ts":"…","reason":"no-transcript"}],
  "depthCapped": 0,
  "malformedLedgerLines": 0,
  "total": {…}
},
"tree": {…}
```

`tree` = `total` + `spawned.total`, as a field, so a consumer never has to add two numbers and
guess whether it double-counted.

**`--tokens`** gains a block below TOTAL, rendered only when this session has at least one edge:

```
SPAWNED    3 descendant session(s) recorded in the spawn ledger (#116) — NOT in
           TOTAL above, which is this session's own turns
           pr-review-lens  correctness            $12.34
           pr-review-lens  reasoning              $18.02
           herdr-agent-start  agent/824           $26.67
           1 unattributed (no transcript) — cost unknown, not estimated
TREE       TOTAL + SPAWNED                        $127.36
```

**The Pi widget** (`extensions/wtft.ts`) renders the same block. It is a reader of the same
report, and a Pi user seeing `TOTAL` with $69 of lens children unlisted is exactly the gap this
issue is about. It degrades to no block rather than throwing — a widget refresh runs every turn,
there is no stderr to warn on, and an unreadable ledger must not take the panel down.

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

Plus, each with its own test: UUID validation on write, the 4 KiB refusal, concurrent appends not
interleaving, a malformed line counted rather than swallowed, a diamond counted once, a cycle
terminating, the depth cap reporting rather than dropping, and an unresolvable child reported as
`unattributed` with a `null` cost.

## Not in this change

- **The spawner side.** `pr-review` and `agent-new` calling `wtft spawn-record` lives in
  `princess-pi-tools`, and this change ships first so there is something to call.
- **Folding descendants into TOTAL.** A separate decision, and it needs the interaction-level
  attribution rework in #107 / #14 / #94 first.
- **Pi children.** Resolution searches Claude Code's project dirs only; a Pi child is
  `unattributed` with reason `no-transcript` until the harness seam grows a lookup (#156).
- **Live growth.** A long-lived interactive child's cost is read at the moment `wtft` runs; it is a
  snapshot and will be stale, which is #14 and is not made worse here.

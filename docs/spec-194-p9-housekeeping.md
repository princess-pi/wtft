# spec-194 P9 — housekeeping: #180 item 7, #151, #30, #15, #208

P9 of [#194](https://github.com/princess-pi/wtft/issues/194). Five small changes that
share a PR because none is big enough to carry its own review round. Each part names
its decision, its surfaces, and the test that closes it.

## H1 — `descendantUntagged`, the fifth floor condition (#180 item 7, D2)

**Observed.** A counted descendant's untagged turns (no model id: `(unknown)` or
`<synthetic>`) are dropped from its edge total. `computeSpawnTree` strips
`untaggedCostUsd` so it cannot leak into `spawned.edges[].total`, as spec-89 U1 requires.
A descendant whose turns are all untagged therefore renders `$0.00`, and no floor
condition says that anything was left out.

**Decision (Duppy, D2 on #194):** a named floor condition. Spelled as a JSON key like its
four siblings:

```json
"descendantUntagged": [
  { "child": "<session id>", "untaggedInteractions": 3, "untaggedCostUsd": 0.0 }
]
```

- One entry per **counted** descendant (an edge with `resolved: true`) whose own parse
  holds at least one untagged interaction. The counts come from the same
  `computeSessionSummary` call that prices the edge. They are that summary's
  `untaggedInteractions` and `total.untaggedCostUsd`.
- Never added to `spawned.total`, `tree`, or any edge total. The money stays outside,
  exactly as a session's own untagged cost stays outside `total.costUsd`.
- `tree` is a floor under **five** conditions: `unattributed` non-empty, `depthCapped`
  non-zero, `ledgerError` non-null, `malformedLedgerLines` non-zero, or
  `descendantUntagged` non-empty.
- `untaggedCostUsd` is often `0`, because untagged lines on the measured corpus carry
  `c: 0`. The condition still holds then, because the turns exist and none of their
  tokens is in the tree. A consumer that wants to know whether *money* is missing reads
  the cost.
- `--tokens` prints one line under the SPAWNED rows when the list is non-empty:
  `N descendant(s) with untagged turns — $X not in SPAWNED (#180)`.
- **Schemas.** `wtft/spawn-tree@3` → `@4`, and `wtft/session@7` → `@8`, per spec-26's
  rule that a nested key bumps the document too.

**Closer** (`tests/wtft-180-descendant-untagged.test.ts`): a root with one ledger child
whose only turn is `<synthetic>`, and one child with a tagged turn plus an untagged turn
that has a non-zero `c`. `--json` lists both children in `descendantUntagged` with
their counts and cost. `spawned.total` excludes the untagged cost. A tagged-only child
is not listed. `--tokens` prints the line. The fixture's precondition is asserted too:
the all-untagged child's edge total is `$0`.

## H2 — a committed `.meta.json` corpus (#151, direction A)

**Observed.** `M7b` is the only test that can see a harness rename of a `.meta.json`
field, and it skips wherever `~/.claude` is absent, including CI.

**Decision (#194, A):** commit a small corpus of real harness `.meta.json` files at
`tests/fixtures/meta-corpus/`, one per shape the reader distinguishes: a depth-1
`general-purpose` child, a named agent type, a depth-2 child carrying `parentAgentId`,
and a Dynamic Workflow child (no `description`, no `toolUseId`). A `README.md` beside
them records where they came from, when, and how to refresh them.

- **`M7c`** runs everywhere. For every corpus file, the two required names are present,
  the near-universal pair is present unless `agentType` is `workflow-subagent`, and
  `readSubagentMeta` accepts the file.
- **`M7b`** stays host-gated and gains one assertion: every key the newest real file
  carries appears somewhere in the corpus. A harness that adds or renames a key then
  fails on a host that has one, naming the refresh steps. That is the ageing check
  direction A needs.

**Closer:** rename `spawnDepth` in one corpus file, run the suite with `HOME` pointing at
an empty directory, and `M7c` FAILs rather than skipping.

## H3 — `install-wtft` checks the `claude` PATH guard (#30, narrowed)

**Context.** The shim #30 asked for shipped as princess-pi-tools' `claude-nsp-guard`,
deployed as `~/bin/claude` by `install-workflow-tools`. What #30 still owes wtft is the
install-side check. A guard that is installed but loses the PATH race looks correct and
guards nothing.

**Identity.** A file is the guard when one of its first 160 lines is exactly
`# nsp-guard-identity: 9a1c-claude-nsp-guard-sentinel`. That is the sentinel
`install-workflow-tools` itself matches before it overwrites `~/bin/claude`. It is
documented in princess-pi-tools `docs/dev-workflow-spec.md`, which makes it the
producer's contract rather than prose scraped here.

**The scan** walks `PATH` in order, skipping empty components as the guard itself does,
and looks at each executable file named `claude`:

| `nspGuard.state` | Meaning | Exit |
|---|---|---|
| `ok` | the first `claude` on PATH is the guard | unchanged |
| `shadowed` | a guard is on PATH, but a different `claude` comes first | **5**, status `nsp-guard-shadowed` |
| `absent` | no guard anywhere on PATH, including no `claude` at all | unchanged |

- **`absent` is not a failure.** The guard ships from princess-pi-tools, which is
  private, so a host without it is a normal wtft install, not drift. Human mode prints
  a one-line note. Presence on this host is `install-workflow-tools --check`'s job.
- **`shadowed` is exit 5**, with the remedy printed: put the guard's directory before
  the winner's on PATH. Nothing is deleted.
- **Precedence:** it is set only when every other check is `ok`. Drift, build failure,
  `no-dir`, `config-left` and a wtft PATH shadow all outrank it.
- **JSON:** `nspGuard: { "state", "found", "guard" }`. `found` is the first `claude` on
  PATH, or `null`. `guard` is the first guard on PATH, or `null`. `install-wtft@1` is kept:
  `configMigration` was added the same way, as an additive key, without a bump.
- **Limit, stated:** a caller that runs a `claude` binary by absolute path bypasses the
  guard. The guard's own `--help` says so.

**Closer** (`tests/wtft-46-install-wtft.test.ts` §10): a fake guard (a file carrying the
sentinel) with a decoy `claude` earlier on PATH exits 5, `nspGuard.state` is `shadowed`,
and both paths are named. The guard first is exit 0, `ok`. No guard is exit 0, `absent`.
A file that only *mentions* the sentinel mid-line does not count as a guard.

## H4 — the subagent read path is pinned (#15)

**Observed.** #15 asked for a paragraph stating the subagent read path's invariants.
That paragraph now exists: `docs/wtft-incremental-render-spec.md` § Sub-Agent Transcript
Read Path, with § `attributeClaudeSubAgentCosts`: Per-Call, Not Global and
§ `deduplicateInteractions`: Return Order Is Not Chronological. The producer half of the
tag contract is `docs/wtft-tag-format.md` §4. What is still missing is #15's Closer: a
test that pins the sentences to the code they describe.

**Added.**
- A short **on-disk layout** subsection in the read-path section, from the evidence on
  #15: the `<session>/subagents/agent-*.jsonl` shape, the parent transcript holding no
  sidechain records, and the two harnesses treating a directory named `subagents`
  oppositely.
- **`tests/wtft-15-read-path-doc-claims.test.ts`** quotes each sentence from the spec, then
  drives the real code to prove it:
  - the per-call rule: one call over two turns that name the same nested child
    attributes it once, and two calls over the halves attribute it twice;
  - the order rule: `deduplicateInteractions` on an id-bearing turn followed by a later
    id-less one returns the id-less turn first;
  - the layout rule: `discoverSubagentSessionFiles` finds `agent-*.jsonl` under
    `<session>/subagents/`, not a sibling `.meta.json` or a non-`agent-` file, and Claude
    Code's session discovery never lists a transcript under `subagents/`.

Rewording a pinned sentence fails the suite, so it cannot quietly drift from the code.
#15 closes with this PR. Its resolution goes in its body.

## H5 — `before-after.ts` reads a frozen corpus (#208)

**Observed.** `research/other-corpus/before-after.ts` snapshots the transcripts it
selects, but `parseSessionFile` discovers nested `claude -p` children live, from the
real projects root. A child still being written between the BEFORE and AFTER passes
moves the totals with no classifier change. Found while reading it: the gained/lost
subagent check reads `claudeSubAgentSessionIds`, a field no current `Interaction`
carries. Both sets are always empty, so a lost subagent is never reported.

**Changes.**
- The snapshot is a **projects-shaped tree**: each selected Claude Code transcript keeps
  its path relative to the projects root, and each Pi transcript its path relative to
  the Pi sessions root.
- **Discovery pass, then freeze.** Both builds parse the live selection once. Every
  `claudeSubAgentFolds[].file` either build names, at any depth, is copied into the
  snapshot at its own relative path. A child only one build finds is still in the
  snapshot, so the lost check can still fire.
- Both measured passes run with `WTFT_CLAUDE_PROJECTS_DIR` set to the snapshot's projects
  root, the #129 seam. A fake `HOME` does not work, because bun caches `os.homedir()` at
  process start.
- Subagent ids come from `claudeSubAgentFolds[].id`, falling back to
  `claudeSubAgentSessionIds` for a BEFORE build old enough to carry only that.
- The selection roots honour `WTFT_CLAUDE_PROJECTS_DIR` and `WTFT_PI_SESSIONS_DIR`, so
  the script can run against a fixture.

**Closer** (`tests/wtft-208-before-after-snapshot.test.ts`): a fixture projects root
with a parent whose turn spawns a `claude -p` child.
- **Snapshot:** the child is copied into the snapshot. After the live child grows, the
  snapshot parent's cost is unchanged. The precondition is asserted too: the live
  parent's cost did move.
- **End to end:** the script run with `--before` set to this same checkout exits 0, and
  names no subagent as lost.
- **Ids:** the fold id is the reported subagent id.

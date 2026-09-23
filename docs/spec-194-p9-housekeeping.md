# spec-194 P9 — housekeeping: #180 item 7, #151, #30, #15, #208

P9 of [#194](https://github.com/princess-pi/wtft/issues/194). Five small changes that
share a PR because none is big enough to carry its own review round. Each part names
its decision, its surfaces, and the test that closes it.

## H1 — `descendantUntagged`, the fifth floor condition (#180 item 7, D2)

**Observed.** A counted descendant's untagged turns (no model id: `(unknown)` or
`<synthetic>`) are dropped from its edge total. `computeSpawnTree` strips
`untaggedCostUsd` so it cannot leak into `spawned.edges[].total`, as spec-89 U1 requires.
A descendant whose turns are all untagged therefore renders `$0.00`, and before this
change no floor condition said that anything was left out. The row still renders `$0.00`;
what changes is that the omission is reported: `--json` names each such descendant, and
`--tokens` counts them on one line.

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
- **One overlap, stated.** An untagged turn that spawned a `claude -p` child carries that
  child's share in its cost, so the child's share is inside `untaggedCostUsd`. The walk
  does not mark such a child folded, so if the ledger also records it, the child is priced
  again under its own edge and is inside `spawned.total` too. `untaggedCostUsd` can
  therefore overstate what is missing.
- `tree` is a floor under **five** conditions: `unattributed` non-empty, `depthCapped`
  non-zero, `ledgerError` non-null, `malformedLedgerLines` non-zero, or
  `descendantUntagged` non-empty.
- `untaggedCostUsd` is often `0`: the untagged turns on this host's corpus are mostly
  `<synthetic>` ones carrying no usage. An `(unknown)` or model-less turn can carry a
  harness-native cost, and server-tool cost is included too. The condition still holds
  when it is `0`, because the turns exist and none of their
  tokens is in the tree. A consumer that wants to know whether *money* is missing reads
  the cost.
- `--tokens`, and the Pi widget, which renders the same block, print one line under the
  SPAWNED rows when the list is non-empty:
  `N descendant(s) with untagged turns — $X left out of their edge totals (#180)`. It says
  edge totals, not SPAWNED, because of the overlap above.
- **Schemas.** `wtft/spawn-tree@3` → `@4`, and `wtft/session@7` → `@8`, per spec-26's
  rule that a nested key bumps the document too.

**Closer** (`tests/wtft-180-descendant-untagged.test.ts`): a root with three ledger
children: one whose only turn is `<synthetic>` with all-zero usage, one with a tagged turn plus
an untagged turn carrying a harness-native cost of $0.25, and one tagged-only. The test
drives `computeSpawnTree`, `renderSpawnTree` and `buildSessionJson` directly, the
functions behind `--tokens` and `--json`. The first two children are listed in
`descendantUntagged` with their counts and cost, and the tagged-only one is not.
Neither the mixed child's edge total nor `spawned.total` holds the $0.25. The SPAWNED
block prints the line. The fixture's precondition is asserted too: the all-untagged
child's edge total is `$0`.

## H2 — a committed `.meta.json` corpus (#151, direction A)

**Observed.** `M7b` is the only test that can see a harness rename of a `.meta.json`
field, and it skips wherever `~/.claude` is absent, including CI.

**Decision (#194, A):** commit a small corpus of real harness `.meta.json` files at
`tests/fixtures/meta-corpus/`: seven files whose keys together cover every key in the 16
key sets seen on this host. Two are Dynamic Workflow children (no `description`, no
`toolUseId`); the others are a depth-2 child carrying `parentAgentId`, a fork, a named agent
type, a named dispatch, and one carrying `cwd`. The reader itself branches on none of these. A `README.md` beside
them records where they came from, when, and how to refresh them.

- **`M7c`** runs everywhere. For every corpus file, the two required names are present,
  the near-universal pair is present unless `agentType` is `workflow-subagent`, and
  `readSubagentMeta` accepts the file with every optional field it carries (`description`,
  `toolUseId`, `model`, `parentAgentId`, `isFork`) intact. The presence checks guard the
  committed data;
  the reader check is the one that exercises code. M7c sees the harness as it was when
  the corpus was captured, not as it is today.
- **`M7b`** stays host-gated and gains one assertion: every key the newest real file
  carries appears somewhere in the corpus. A harness that adds or renames a key, on the
  newest sidecar, then fails on a host that has one, pointing at the refresh steps in the
  corpus README. A key the
  harness stops writing is not caught by this check. That is the ageing check
  direction A needs.

**Closer:** rename `spawnDepth` in one corpus file, run the suite with `HOME` pointing at
an empty directory, and `M7c` FAILs rather than skipping.

## H3 — `install-wtft` checks the `claude-nsp-guard` shim (#30, narrowed)

**Context.** The shim #30 asked for shipped as princess-pi-tools' `claude-nsp-guard`,
deployed as `~/bin/claude` by `install-workflow-tools`. What #30 still owes wtft is the
install-side check. A guard that is installed but loses the PATH race looks correct and
guards nothing.

**Identity.** A file is the guard when one of its first 160 lines is exactly
`# nsp-guard-identity: 9a1c-claude-nsp-guard-sentinel`. That is the sentinel
`install-workflow-tools` itself matches before it overwrites `~/bin/claude`. The full
string and the whole-line, first-160-lines rule live in princess-pi-tools'
`bin/install-workflow-tools`; its `docs/dev-workflow-spec.md` names the check but abbreviates
the string, and does not yet say wtft reads it too (duppypro/princess-pi-tools#1021). wtft also
requires the file to be executable, which the producer's check does not.

**The scan** walks `PATH` in order and looks at each executable file named `claude`. It
skips empty components as the guard itself does, although a shell would search the current
directory there, so a `claude` in the cwd that a shell would run first is not seen:

| `nspGuard.state` | Meaning | Exit |
|---|---|---|
| `ok` | the first `claude` on PATH is the guard | unchanged |
| `shadowed` | a guard is on PATH, but a different `claude` comes first | **5**, status `nsp-guard-shadowed` |
| `absent` | no guard anywhere on PATH, including no `claude` at all | unchanged |

- **`absent` is not a failure.** The guard ships from princess-pi-tools, which is
  private, so a host without it is a normal wtft install, not drift. On an `ok` run
  human mode prints a one-line note. Presence on this host is
  `install-workflow-tools --check`'s job.
- **`shadowed` is exit 5**, with the remedy printed: put the guard's directory before
  the winner's on PATH. Nothing is deleted.
- **Precedence:** it is set only when every other check is `ok`. Drift, build failure,
  `no-dir`, `config-left` and a wtft PATH shadow all outrank it. When one of drift,
  `config-left` or a wtft shadow wins, human mode still names a shadowed guard on an
  `Also:` line, as it already does for a wtft shadow.
- **JSON:** `nspGuard: { "state", "found", "guard" }`. `found` is the first `claude` on
  PATH, or `null`, and is set even when `state` is `absent`. `guard` is the first guard on PATH, or `null`. `install-wtft@1` is kept:
  `configMigration` was added the same way, as an additive key, without a bump.
- **Limit, stated:** a caller that runs a `claude` binary by absolute path bypasses the
  guard. The guard's own `--help` says so.

**Closer** (`tests/wtft-46-install-wtft.test.ts` §10): a fake guard (a file carrying the
sentinel) with a decoy `claude` earlier on PATH exits 5, `nspGuard.state` is `shadowed`,
and both paths are named. The guard first is exit 0, `ok`. No guard is exit 0, `absent`.
A file that only *mentions* the sentinel mid-line does not count as a guard. With a wtft
shadow as well, the exit is 2 and the guard is named on an `Also:` line.

## H4 — the subagent read path is pinned (#15)

**Observed.** #15 asked for a paragraph stating the subagent read path's invariants.
That paragraph now exists: `docs/wtft-incremental-render-spec.md` § Sub-Agent Transcript
Read Path, with § `attributeClaudeSubAgentCosts`: Per-Call, Not Global and
§ `deduplicateInteractions`: Return Order Is Not Chronological. `docs/wtft-tag-format.md`
§4 states both halves of the tag contract: the producer may write one message id more than
once, and a consumer collapses them. What is still missing is #15's Closer: a
test that pins the sentences to the code they describe.

**Added.**
- A short **on-disk layout** subsection in the read-path section, from the evidence on
  #15: the `<session>/subagents/agent-*.jsonl` shape, the parent transcript holding no
  sidechain records, the Pi sibling pattern, and session discovery skipping a directory
  named `subagents` in both harnesses (so a Pi subagent sibling, which is not in one, is
  listed as a session).
- **`tests/wtft-15-read-path-doc-claims.test.ts`** quotes the pinned sentences from the
  spec, then drives the real code behind each:
  - the per-call rule: one call over two turns that name the same `claude -p` child
    attributes it once, two calls over the halves attribute it twice, and a second call
    over the same objects attributes it again;
  - the order rule: `deduplicateInteractions` on an id-bearing turn followed by a later
    id-less one returns the id-less turn first;
  - the layout rule: `discoverSubagentSessionFiles` finds `agent-*.jsonl` under
    `<session>/subagents/`, not a sibling `.meta.json`, a non-`agent-` file or anything
    under `wtft-tags/`; it finds a Pi sibling by `parentSession`; and neither harness's
    session index lists a transcript under a `subagents/` directory below a project
    directory, while Pi's does list the sibling.

Rewording a pinned sentence fails the suite, so it cannot quietly drift from the code.
#15 closes with this PR. Its resolution goes in its body.

## H5 — `before-after.ts` reads a frozen corpus (#208)

**Observed, before this change.** `research/other-corpus/before-after.ts` snapshotted the
transcripts it selected, but `parseSessionFile` discovers `claude -p` children live, from
the projects root `projectsDir()` names. A child still being written between the BEFORE
and AFTER passes moved the totals with no classifier change. Found while reading it: the
gained/lost subagent check read `claudeSubAgentSessionIds`, a field no current
`Interaction` carries, so both sets were always empty and a lost subagent was never
reported.

**Changes.**
- The snapshot is a **projects-shaped tree**: each selected Claude Code transcript keeps
  its path relative to the projects root, and each Pi transcript its path relative to
  the Pi sessions root.
- **Discovery pass, then freeze.** Both builds parse the live selection once. Every
  `claudeSubAgentFolds[].file` either build names, at any depth, is copied into the
  snapshot at its own relative path. A child only one build finds is still in the
  snapshot, so the lost check can still fire. Three things stay out, each with a stderr
  note: children only a build whose discovery parse throws would have found; a fold file
  outside the Claude Code projects root; and a file whose copy fails (a selected
  transcript that fails to copy is still counted in the session header and contributes
  nothing).
- Both measured passes run with `WTFT_CLAUDE_PROJECTS_DIR` set to the snapshot's projects
  root, the #129 seam. A fake `HOME` does not work, because bun caches `os.homedir()` at
  process start.
- Subagent ids come from `claudeSubAgentFolds[].id`, falling back to
  `claudeSubAgentSessionIds` for a BEFORE build old enough to carry only that. Such a
  build, and one whose folds carry no `file` yet, names no fold files, so its children
  are frozen only when AFTER finds them too; a build older than the #129 seam reads the
  live projects root in its measured pass anyway. The freeze holds when both builds carry
  `claudeSubAgentFolds[].file`.
- The snapshot directory is removed when the script exits, including on an error; a run
  killed by a signal leaves its `wtft-ab-*` directory behind. `--before` is resolved against the current
  directory, so a relative checkout path works.
- The selection roots honour `WTFT_CLAUDE_PROJECTS_DIR` and `WTFT_PI_SESSIONS_DIR`, so
  the script can run against a fixture.

**Closer** (`tests/wtft-208-before-after-snapshot.test.ts`): a fixture projects root
with a parent whose turn spawns a `claude -p` child.
- **Snapshot:** the child is copied into the snapshot. After the live child grows, the
  snapshot parent's cost is unchanged. The precondition is asserted too: the live
  parent's cost did move.
- **End to end:** the script run with `--before .` from this checkout exits 0, names no
  subagent as lost, reports a total that includes the frozen child's cost, and leaves no
  snapshot directory behind.
- **Ids:** the fold id is the reported subagent id.

## Reconciliation record (2026-09-23)

Seven fresh-context auditors, one per changed source file plus the read-path tests and one for
host-scoped documents, then a second pass over the lines the first fix round changed. Every
finding this branch caused is fixed below, or left standing with its reason. Findings about text that
was already on `main` are #233. The three that move money are #230, #231 and #232, and one
producer-side gap is duppypro/princess-pi-tools#1021.

| Artifact | Claim | Contradicted by | Covered by a test? | Action |
|---|---|---|---|---|
| `install-wtft --help` | nothing on `nspGuard`, on how the guard is recognised, or on exit 5's precedence | `finish()`, `is_nsp_guard` | reconciled-against-untested (§10 drives the behaviour, not the help text) | Fixed |
| `install-wtft` human mode | a shadowed guard is silent when another status wins | `finish()` | ✅ V10e for a wtft shadow; the drift and `config-left` lines untested | Fixed in code: an `Also:` line, like a wtft shadow |
| user-facing strings | three names for one shim | `finish()` | — | Fixed: `claude-nsp-guard`; glossary entry added |
| spec-194 H3 | the sentinel "documented in dev-workflow-spec" | the spec abbreviates it | — | Fixed; producer gap filed as ppt#1021 |
| spec-194 H3 | empty PATH components skipped "as the guard does" | a shell searches the cwd there | reconciled-against-untested | Fixed: stated as a limit |
| spec-26 `tree.*`, spec-116 | "the last two are the traps", "the other three" | five conditions now | — | Fixed |
| spec-26 Amendment 7 | "each such descendant" (all-untagged) | any untagged turn qualifies | ✅ D3/D4 | Fixed |
| spec-26 | "every number in that block is in `spawned`" | the untagged-cost line is a sum | ✅ R1 | Fixed |
| spec-116 example, sample | no `descendantUntagged`; "the last three" lines | `@4` carries it; four lines | ✅ D8, R1 | Fixed |
| README, CONTEXT, manifest | the `--tokens` untagged line is undocumented | `renderRecordedSpawns` | ✅ R1 | Fixed |
| spec-26 row, H1, README | untagged cost "never in `spawned.total`" | an untagged turn's `claude -p` share can be counted under that child's own edge | reconciled-against-untested | Fixed: overlap stated |
| spec-194 H1 | `c: 0`, two children, "`--json` lists" | native cost, three children, library calls | ✅ | Fixed |
| `tests/wtft-180` D7, J3 | "the untagged $0.25 is not added" | both passed whatever the edge held | — | Fixed: now fail if it leaks |
| read-path layout | `wf_<id>` "one level down"; "only `agent-*.jsonl`"; "only reader"; subagent "never listed" | two levels; Pi siblings; meta reader and daemon watch; Pi lists siblings | ✅ L3–L7 | Fixed |
| read-path per-call | the invariant, unqualified | an attributed turn is skipped and seeds nothing | ✅ A5–A7 | Fixed; the second-call double count is now stated and pinned |
| spec-194 H2/H4, corpus README, spec-137 | "shape the reader distinguishes"; M7c "checks the harness"; "harness treats `subagents` oppositely"; "producer half is §4" | the reader has no shapes; M7c reads a snapshot; both skip it; §4 states both halves | ✅ M7b/M7c | Fixed |
| spec-194 H5, EXT_WTFT | "every fold file is copied" | three exclusions; old BEFORE builds | reconciled-against-untested | Fixed: stated |
| `before-after.ts` | a relative `--before` fails; the snapshot is never removed; a fold with no `file` crashes; a failed per-file `mkdir` aborts the run | the import specifier; `mkdtemp`; `foldFilesOf`; `copyUnder` | ✅ E5–E7 for the first three; the per-file `mkdir` untested | Fixed in code |
| `tests/wtft-208` E | passes with discovery broken | never checked the child | — | Fixed: E4 |
| spec-107, spec-52 | #107 C "is P9, not in this change"; command without `bun` | shipped; needs `bun` | — | Fixed |
| `nspGuard` | no `remedy` key, unlike `shadow` | — | — | Left standing: `found` and `guard` carry both paths; a remedy string would be prose in a field |
| `tests/wtft-208` fixture | Pi-format lines only | — | — | Left standing: the `claude -p` path does not depend on the transcript format |
| M7c presence checks | exercise no production code | — | — | Left standing: they guard the committed data; the reader check exercises code |
| second pass, round-1 lines | precedence left out of exit-5 sentences, `Also:` overclaimed for `build-failed`/`no-dir`, "names" where `--tokens` only counts, the corpus key-set count, `--help` coverage marked tested, and a `before-after.ts` crash on folds with no `file` | `finish()`, `renderRecordedSpawns`, `foldFilesOf` | ✅ E7 for the crash; the new stderr notes untested | Fixed |
| third pass, round-2 lines | exit 5 dropped the "no wtft on PATH" note; the discovery-parse note did not say which build failed; "exits normally" narrower than the handler; the record's own coverage column | `finish()`, the discovery pass, `process.on("exit")` | reconciled-against-untested | Fixed. The pass's remaining findings are about wording added by the pass before it (glossary words used for the script's own "lost" label and the `fork` agent type, host measurements quoted with their date, the partly-driven layout clauses, and manifest text already filed in #233). Per the review-loop stop rule the reconcile stops here |
| spec-26 "every number in that block" | could be read as covering UNRECORDED | "that block" is SPAWNED | — | Left standing: UNRECORDED is its own block, listed separately above it |
| `nsp-guard-shadowed` | contains the avoided "nsp guard" | a status code | — | Left standing: a machine string keeps its spelling; the glossary says so |
| `pr-review` round 1 | 13 findings (2 Medium): `head \| grep -q` under `pipefail` read a large guard as absent (reproduced: exit 141); M7c blind to a rename of an optional field; the untagged line saying "not in SPAWNED" despite the overlap; an unquoted `find` root; `--help` splitting the sentinel; stale pointers in comments | `is_nsp_guard`, M7c, `renderRecordedSpawns`, `pickTranscripts` | ✅ V10g, M7c optional fields, R1 | Fixed; the line now reads "left out of their edge totals". Declined: the claim that `parseSubagentMeta` may not exist — it is the private parser `readSubagentMetaChecked` calls |

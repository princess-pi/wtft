# Spec — #128: listing unrecorded spawns

> **Issue:** [#128](https://github.com/princess-pi/wtft/issues/128) — *List launcher-spawned
> sessions that no spawn ledger edge accounts for — a report, never an attribution.*
> Direction **E**, decided by Duppy 2026-09-16: `entrypoint: sdk-cli`, plus a confidence tier.
> Tracked as **P6** of [#194](https://github.com/princess-pi/wtft/issues/194).

## The gap this closes

#116's Closer has two clauses. The spawn ledger meets the first. The second — *delete the record
and the same run reports the child, with its cost still visible somewhere, never dropped* — needs a
mechanism the ledger does not have: with no record there is no id to look up, so the child is
**invisible**, not `unattributed`.

This change adds that mechanism as a **list**, never a claim. `spawned.unrecorded[]` names sessions
that look like this session's children and that no ledger edge accounts for, each with its own
cost (`null` when it cannot be parsed) and the reason it was listed. **Nothing in the list is ever summed into `tree` or `total`**,
and nothing in it changes the exit code.

## Who gets listed

A session is a **candidate** when its transcript was written to at or after this session's first
command — the harness prunes by mtime, not by start time. A candidate is listed under one of two
**tiers**:

| Tier | Rule | Confidence |
|---|---|---|
| **`named`** | The candidate's recorded `cwd` contains this session's id. No start-time test and no `entrypoint` test | Certain — the launcher named the parent |
| **`inferred`** | The harness says a program started it (`entrypoint: sdk-cli`), its `cwd` is inside this repo's worktree fan-out or a temp sandbox, and its first timestamp falls inside a **launch span** | Probable — a guess, and labelled as one |

Anything else is not listed. Outside `named`, a session a human started (`entrypoint: cli`) never
is, which is what keeps a peer session out by construction rather than by timing: measured
on this host, 934 of 946 human-started sessions (#128's decision comment). A `named` row is listed
whoever started it, because the name is the evidence.

Nothing is listed at all for a session that ran no command: with no launch span there is nowhere
to start the scan, so `unrecorded` is `[]` without a look.

- **`basis`** says which arm listed a row: `cwd-names-parent` for `named`; `worktree` or `tmp` for
  `inferred`.
- **Temp sandbox** means a `cwd` under `/tmp` or under `os.tmpdir()`. Both, because the harness
  can run with `TMPDIR` pointing somewhere else while launchers still use `/tmp`.
- **Worktree fan-out** is `fanOutCwd` applied to this session's **last recorded** cwd — the repo
  and every checkout of it, the same rule the picker's `Ctrl+W` scope applies to its own target.
  A candidate whose `cwd` is one of those directories or below one is inside it — the main clone
  and this session's own checkout included, which is why `--tokens` says "checkouts". It is empty
  when that cwd is in no git repository — a directory outside a repo has no worktrees, so a child
  there can only be `tmp` or `named` — and when no cwd can be read from the transcript.
- **The ledger could not be read** (`spawned.ledgerError`): no edge is known, so a session some
  other parent recorded cannot be excluded, and may be listed. The `--tokens` header then says so
  instead of "no spawn record names".
- **One id in two project directories** is a moved session; only its newest copy by mtime is
  classified — the copy every other reader prices — so an older copy is never listed in its place.

### The launch span

A launcher only runs from a command, and a child cannot start before the command that launched
it. So a launch span opens at every turn of this session that ran a command, and stays open for
**`UNRECORDED_WINDOW_MS` = 30 minutes** — long enough to cover a whole `pr-review` run, which takes
6 to 23 minutes on this host. Overlapping spans are merged. "Span", not "window": the glossary
reserves "window" for the picker's time window, and the daemon's 15-second discovery window is a
different thing again.

- Turns come from the **tag file**, so a Task subagent's turns count too: a subagent that runs a
  launcher spawns on this session's behalf.
- A session's first timestamp is fixed, and Claude Code writes the transcript from its first line
  (measured: file birth within 200 ms of the first timestamp), so a candidate either began inside
  a span or never will.

**Road not taken — closing the span at the next turn.** A foreground command blocks the session,
so its child starts before the next turn. A backgrounded one does not: the turn after it is often
a text-only "waiting" reply, and the child starts during the idle gap that follows. Closing at the
next turn would drop exactly the children of backgrounded launchers.

### Exclusions

A candidate is not listed when its money is already somewhere, or someone else owns it:

- this session itself;
- **any** ledger child, under any parent — a recorded edge elsewhere says whose it is;
- every session the tree walk reached — counted, folded, unresolved, or already in `total`;
- every session the tag's fold records name (`alreadyAttributed`);
- a candidate that another listed candidate's own parse folds — its cost is already inside that
  row, so listing it too would show it twice.

The first, third and fourth are the walk's own state; the second is one pass over the ledger already in
memory. So the exclusion is exact for recorded edges and costs no extra read.

## The shape

### The harness seam

`HarnessDiscovery` gains one **optional** method:

```ts
listSpawnCandidates?(sinceMs: number): SpawnCandidate[];

interface SpawnCandidate {
	path: string;
	sessionId: string;
	cwd: string;
	/** First timestamp in the transcript, epoch ms. */
	startedAt: number;
	/** Who started it, when the harness records that. null = the harness does not say. */
	launchedBy: "program" | "human" | null;
}
```

It answers a location-and-schema question — where transcripts live and what their fields mean —
which is exactly what the seam exists to hold. The tier rules, the launch span and the exclusions are
semantics and stay on the shared side.

**Claude Code** implements it. It lists every project directory under the projects root, keeps
the ones whose mtime is at or after `sinceMs` (creating a transcript updates its directory's mtime,
so a directory last written before `sinceMs` holds no transcript created after it; one created
earlier and still being written is skipped only when its directory is that old), keeps each top-level `*.jsonl` whose own
mtime is at or after `sinceMs` (a symlinked directory or transcript counts, followed to its target), and reads the head of each for `timestamp`, `cwd` and `entrypoint`.
`entrypoint: "sdk-cli"` is `program`, `"cli"` is `human`, anything else is `null`. **A read error is loud;
only a path that is gone is quiet** (#212). ENOENT — no projects root on a host without Claude
Code, or a directory or transcript deleted mid-scan, or a dangling symlink — is skipped: nothing
is there to list. Any other error, at the root, a project directory or a transcript, is thrown,
and the report fails with exit 1 and the OS error naming the path. So `[]` never hides an
access error. Measured 2026-09-22, a full scan of this host's tree (2,290 directories, 6,753
transcripts) met no unreadable entry, so in normal use the rule costs nothing. The head read is the first 20 lines within the first
64 KiB; a transcript with no timestamp or no `cwd` there cannot be classified and is not a
candidate.

**Pi** does not implement it: Pi's session header carries no field that separates a programmatic
start from a human one. A Pi child is therefore never listed. Filed as
[#209](https://github.com/princess-pi/wtft/issues/209).

### The listing

`extensions/lib/wtft-unrecorded.ts`:

- **`spawnWindows(turns)`** — the merged `[start, end]` launch spans, from deduplicated turns carrying
  at least one command.
- **`listUnrecordedSpawns({ rootSessionId, rootCwd, turns, exclude, rootFile? })`** — asks every discovery
  that has `listSpawnCandidates`, applies the tiers, drops the exclusions, prices each survivor
  with `parseSessionFile` and `computeSessionSummary` (`untaggedCostUsd` dropped, as for an edge),
  drops what another row folds, and returns the rows sorted by `ts`. The pricing parse is handed
  this session's own transcript as never-foldable: a candidate's own `claude -p` discovery
  matches on time and place, and could otherwise find the parent itself.

`computeSpawnTree` takes a new option, `unrecorded: { turns, rootCwd, rootFile? }`. When given, the tree
carries `unrecorded: UnrecordedSpawn[]`, listed after the walk so the walk's outcomes feed the
exclusion. The early return for a session with no edges now skips only the walk, and the
`alreadyAttributed` thunk is still called to feed the exclusion. The widget does
not pass the option: the scan is a one-shot report's cost, not a per-poll one.

```ts
interface UnrecordedSpawn {
	child: string;
	path: string;
	cwd: string;
	/** ISO-8601 UTC — the child's first timestamp. */
	ts: string;
	tier: "named" | "inferred";
	basis: "cwd-names-parent" | "worktree" | "tmp";
	/** null, never zero, when the child could not be parsed. */
	total: TokenTotals | null;
	skip?: "unreadable";
}
```

### Surfaces

- **`--json`:** `spawned.unrecorded[]`. `wtft/spawn-tree@2` → `@3` and `wtft/session@5` → `@6`,
  because a nested key was added. `[]` means looked and found none — or, for a session that ran
  no command (the pending and no-data arms included), that there was no launch span to look in. A read error never sits behind
  a `[]`: it fails the run. A harness that is disabled, or that does not implement
  `listSpawnCandidates`, is not looked in at all.
- **`--tokens`, CLI only:** an `UNRECORDED` block, last, after the `UNCOUNTED` line and the
  `SPAWNED` block, shown whenever the list is non-empty — whether or not a `SPAWNED` block prints.
  The widget renders the same table without it.
  A `named` row prints on its own, under its `cwd` fitted to 30 columns, with `(unreadable)` where
  its cost would be when it could not be parsed. `inferred` rows collapse to **one line per
  basis**, carrying the count and the readable rows' summed cost, with a second line saying how many were
  unreadable and so are not in that sum; a group with no readable row prints `(unreadable)`, never
  `$0.00`:

  ```
  UNRECORDED 122 session(s) no spawn record names (#128) —
             NOT in TOTAL or TREE: a list, not a claim; every row is in --json
             named     /tmp/pr-review.<id>.bugs              $0.17
             inferred  43 in this repo's checkouts           $3.77
             inferred  78 in temp sandboxes                  $1.13
  ```

  **Why collapse:** measured on this host 2026-09-22, one long session listed 121 `inferred` rows.
  A row per session would bury the `TOTAL` table. `--json` keeps every row.
- **Exit 9** is untouched. The list is a report; nothing in it can make a number in the report
  change.

### The daemon's unbounded arm

#107's spec left one arm for this change: a `pendingClaudeCommands` turn that searched and found
nothing was re-discovered every poll for the daemon's life. It is now bounded like the found and
nothing-to-search arms, by the 15-second discovery window plus the 2-second settle margin. The two
failure arms — discovery threw, or a candidate was unreadable — still retry until the read
succeeds. The bound drops a child from the tag only when its transcript reaches disk more than
the 2-second settle margin after its own first timestamp — measured, Claude Code creates the
file within 200 ms of it. A child that begins after the discovery window could never have matched
anyway. A child whose
first line lands after the discovery window but inside a launch span is listed here, if it is
programmatic and in the fan-out or a temp sandbox, instead of being retried forever.

## What it measured on this host

Run against the session that shipped P1–P5 of #194 (2026-09-21 to 22):

- **43 `inferred`/`worktree` rows**, in bursts of 4 to 13 inside one second, each burst in one of
  that session's own feature worktrees. That is the shape of a `spec-reconcile` auditor fan-out,
  which records no spawn edge. This arm reads as the session's own spend.
- **78 `inferred`/`tmp` rows**, mostly under `/tmp/pp-test-*`, `/tmp/help-contract-*` and
  `/tmp/pr-review-probe-*` — `claude -p` children of another repo's test suite running at the same
  time. This arm is mostly peer noise on a busy host, which is what the `inferred` label is for.
  The fix for it is the `named` tier, not a tighter span: time and place cannot tell two
  concurrent sessions' children apart.

## What it costs

One `stat` per project directory (2,243 on this host, 2026-09-22); then, only for directories
touched since the session's first command, one `readdir` per directory and one `stat` per
transcript in it; and one head read per recent transcript. Pricing is one `parseSessionFile` per listed row. Paid only by `--json` and
`--tokens`.

## Verification

`tests/wtft-128-unrecorded-spawns.test.ts`, against a sandboxed projects root
(`WTFT_CLAUDE_PROJECTS_DIR`) and a sandboxed ledger (`XDG_STATE_HOME`):

- **The #116 Closer, second clause:** a parent whose Bash turn runs the `herdr agent start` line and
  a launcher child in `/tmp` with `entrypoint: sdk-cli`. With the record, the child is an edge and
  `unrecorded` is empty. With the record deleted, the child is in `unrecorded` as `inferred`/`tmp`
  with its cost, and `tree` equals `total`.
- A human-started peer (`entrypoint: cli`) inside the launch span is absent.
- A programmatic peer outside every launch span is absent.
- A candidate recorded under a *different* parent in the ledger is absent.
- A candidate whose `cwd` contains the parent's id is `named`, even with `entrypoint: cli`.
- A candidate in a worktree of the parent's repo is `inferred`/`worktree`; a child in a directory
  that is no repo is not called a worktree.
- A session the tag's fold records name (`alreadyAttributed`) is absent.
- A candidate's price never folds the parent's own transcript.
- A grandchild folded by a listed candidate is listed once, inside its parent's row.
- `--tokens` prints the `UNRECORDED` block for a session with no recorded edges, and nothing
  when the list is empty.
- Unit: `spawnWindows` opens 30 minutes, merges overlapping spans, and ignores turns with no command.
- Daemon: a spawning turn that found nothing leaves the pending queue once its discovery window
  has closed, and the child that appears later is listed with its cost.

## Not in this change

- **Pi children** — no programmatic-start field. [#209](https://github.com/princess-pi/wtft/issues/209).
- **The launcher side of `named`** — naming a sandbox after its parent session is
  [duppypro/princess-pi-tools#883](https://github.com/duppypro/princess-pi-tools/issues/883).
  `named` lights up for each launcher as it adopts the convention.
- **The widget** — no `UNRECORDED` line; its polling budget is not the report's.

---

## Reconciliation record (spec-reconcile, 2026-09-22)

Six fresh-context auditors: listing and tree, harness seam, CLI and renderer, daemon, the test
file, and the host-scoped documents (none of which makes a #128 claim). Pre-existing drift they
found in text this branch did not change is filed as
[#210](https://github.com/princess-pi/wtft/issues/210).

| Artifact | Claim | Contradicted by | Covered by a test? | Action |
|---|---|---|---|---|
| spec-128, README, spec-26 | a human-started session is never listed | `classify` tests `named` before `launchedBy` | ✅ T7 | Fixed: "outside `named`" |
| spec-128 | a candidate began after the first command | the harness prunes by mtime; `named` has no time test | ✅ C4, T7 | Fixed |
| spec-128, spec-26 | `[]` means looked and found none | no command turn → `[]` before any scan | ✅ T15 | Fixed: both meanings stated |
| spec-128 | every unreadable path is reported | the projects root: absent → empty, other errors thrown | reconciled-against-untested | Fixed |
| spec-128 | first 20 lines | also capped at 64 KiB | reconciled-against-untested | Fixed |
| spec-128 | fan-out = the picker's `Ctrl+W` set | built from the session's last recorded cwd | ✅ T8 | Fixed |
| spec-128 | (silent) null cwd / non-repo cwd | a session's own dir counted as a worktree outside a repo | ✅ D4 | **Code fixed**: fan-out only inside a repo |
| spec-128 | (silent) the pricing parse | a candidate's `claude -p` discovery could fold the parent's transcript | ✅ F2 | **Code fixed**: root passed as never-foldable |
| spec-128 | (silent) ledger unreadable | other parents' children cannot be excluded | reconciled-against-untested | Fixed |
| spec-128 | UNRECORDED prints where no SPAWNED block does | SPAWNED prints for a damaged ledger with no edges; UNCOUNTED comes first; widget has none | ✅ E7 | Fixed |
| spec-128 | the arm is bounded like its neighbours | the two failure arms still retry | ✅ D3 | Fixed |
| spec-128 | a late-writing child is listed | only if inside a launch span and programmatic | ✅ D4 | Fixed |
| spec-128, CONTEXT | "spawn window" | Interval's `_Avoid_` reserves "window" | n/a | Renamed "launch span" |
| spec-26 Amendment 5 | none of them is summed anywhere | `--tokens` sums each inferred basis | ✅ E8 | Fixed |
| README, manifest, CONTEXT, spec-26 | each with its own cost | an unreadable row has `total: null` | reconciled-against-untested | Fixed |
| README, manifest | a `/tmp` sandbox | `/tmp` or `os.tmpdir()` | reconciled-against-untested | Fixed |
| README, manifest, CONTEXT | one row per session under `--tokens` | inferred rows collapse per basis | ✅ R2 | Fixed |
| README, CONTEXT | `tier` only | every row carries `basis` too | ✅ T1, T8 | Fixed |
| README, CONTEXT (Launcher-spawned session) | neither transcript names the other | a `named` child's cwd does | ✅ T7 | Fixed |
| `docs/adding-a-harness.md` | the interface block | omits `listSpawnCandidates` | ✅ C1 | Fixed |
| spec-114, spec-107 | the found-nothing arm is unbounded | bounded by this change | ✅ D3 | Fixed |
| `[wtft]` warning | "may be missing"; "a session transcript" | `_Avoid_` "missing"; directories are reported too | n/a | Fixed |
| test file | W1–W4 move with the constant; C5 and T12 vacuous; D3 names the wrong window | — | — | W0 added; C5, T12 deleted; D3 relabelled |
| second pass: spec-26, spec-128 | "spawn window"; "each with its own cost"; `[]` meanings | rename missed in spec-26; null cost; an unreadable path also yields `[]` | ✅ T15 | Fixed |
| second pass: spec-128, adding-a-harness | "every transcript written at or after `sinceMs`" | the directory prune skips a transcript created earlier | ✅ C4 | Fixed: "created at or after" |
| second pass: adding-a-harness | no method → never listed; silent on throwing | `launchedBy: null` still allows `named`; the root read may throw | reconciled-against-untested | Fixed |
| second pass: README, manifest, renderer | "in this repo's worktrees" | the fan-out includes the main clone and the session's own checkout | ✅ R2 | Label is now "checkouts" |
| second pass: spec-128, spec-26 | Pi records nothing | `parentSession` exists, for siblings | n/a | Fixed |
| third pass: renderer | "summed cost" per inferred basis | a group with no readable row printed `$0.00` | ✅ R4 | **Code fixed**: prints `(unreadable)` |
| third pass: spec-26, CONTEXT, manifest | "Claude Code only" | the rule is "implements `listSpawnCandidates`" | n/a | Fixed |
| third pass: README, manifest | "no ledger edge names"; "within 30 minutes of" | already-counted sessions are excluded too; the span runs forward only | ✅ T10, W1 | Fixed |
| third pass: spec-128 | listing signature; sample column | `rootFile` missing; money one column left | ✅ F2 | Fixed |

### pr-review round 1 (DeepSeek V4.1 Flash, 2026-09-22)

| Finding | Verdict | Action |
|---|---|---|
| Two candidates that fold each other were both dropped | Verified — reproduced as M1, which listed neither | **Code fixed**: a mutual pair keeps the row with the first path; ✅ M1 |
| `listSpawnCandidates` skips the older `sessions/` subdirectory layout | True, and kept: a new transcript is written top-level, and the directory-mtime prune cannot see a nested file's creation anyway | Left standing |
| `isInside` rejected a component starting with `..` (`/tmp/..cache`) | Verified | **Code fixed**; reconciled-against-untested |
| `alreadyAttributed` docstring promised laziness the option no longer has | Verified | Claim deleted |
| Daemon comment's "never will match" premise | Verified: the child can match; the turn is simply not searched again | Comment deleted |
| Duplicate sanitiser in `renderRecordedSpawns` | Verified | One `safeSpawnText` for both blocks |
| spec-133 row names old schemas as current | Verified | "at the time" |
| `--tokens` help implied UNCOUNTED follows UNRECORDED | Verified | Order stated |
| adding-a-harness "created at or after" vs an mtime prune | Verified | "written at or after" |
| Module header cites an issue number | Verified | Deleted |

### pr-review round 2

| Finding | Verdict | Action |
|---|---|---|
| The unreadable count was clipped by the 30-column name fit | Verified: `121 in this repo's checkouts, ` | **Code fixed**: its own line; ✅ R4 |
| `spawned.unrecorded` may not reach `--json` | Refuted: `buildSessionJson` emits `spawned: input.spawned`, and E1–E3 read the key from real `--json` output | Declined |
| `listSpawnCandidates` docstring said "began at or after" | Verified | Corrected |
| spec-116, the `spawn-record` help: a never-recorded child is invisible / leaves no trace | Verified | Corrected for the listing and the `named` tier |
| spec-128 "nothing is lost by the bound" | Verified for a transcript that lands on disk late | Corrected, with the measured file-birth lag |
| EXT_WTFT spec-176 row: the thunk runs only with a ledger edge | Verified | Corrected |
| Docstrings citing #128 | Verified | Citation removed |

### pr-review round 3 (the round limit)

| Finding | Verdict | Action |
|---|---|---|
| A duplicate session id kept the first copy found, not the newest | Verified — reproduced as N1 | **Code fixed**: newest mtime wins; ✅ N1 |
| With the ledger unreadable, the header still said "no spawn record names" | Verified — reproduced as R5 | **Code fixed**: the header says the ledger could not be read; ✅ R5 |
| "The first three read state the walk already has" | Verified: the second is a pass over the ledger | Corrected |
| spec-116: "never summed into anything" | Verified: `--tokens` sums each inferred basis | Qualified |

### Macroscope, on the Draft (PR #211)

| Finding | Verdict | Action |
|---|---|---|
| Medium: a newer ineligible copy let an older eligible copy through | Verified — reproduced as N2 | **Code fixed**: newest copy chosen before classifying; ✅ N2 |
| Low: `spawn-record` help said a failed append degrades to exactly the old behaviour | Verified | Corrected |
| Low: "no ledger edge names" is unqualified when the ledger could not be read | Verified | Qualified in spec-26 and the manifest |

### #212 — loud read errors (Duppy, 2026-09-22)

Macroscope's High on PR #211 asked for a read failure to be caught and skipped. Duppy's decision
went the other way, and further: `[]` must only ever mean "looked and found none", so every read
error in the scan fails the run, not only the root's; only ENOENT is quiet. Pinned by L1–L5b in
`tests/wtft-128-unrecorded-spawns.test.ts`, including `--json` exiting 1 with no document for an
unreadable project directory and for an unreadable transcript.

| Artifact | Claim | Contradicted by | Covered by a test? | Action |
|---|---|---|---|---|
| spec-128, spec-26, README, manifest | a read error anywhere is loud | the newest-copy stat swallowed every error | reconciled-against-untested (reachable only by a race) | **Code fixed**: only ENOENT is quiet there too |
| spec-128 | a still-written older transcript is skipped | only when its directory is older too | reconciled-against-untested (C4 sets both mtimes old) | Corrected |
| spec-128 | `[]` meanings | a disabled harness, or one without the method, is not looked in | n/a | Stated |
| README, manifest | "the Claude projects tree" | any harness implementing the method can throw | n/a | Generalised |
| (pre-existing) | the auditor's other findings | — | — | Filed on #210 as AJ–AN |

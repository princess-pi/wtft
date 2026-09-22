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
cost and the reason it was listed. **Nothing in the list is ever summed into `tree` or `total`**,
and nothing in it changes the exit code.

## Who gets listed

A session is a **candidate** when its transcript began after this session's first command. A
candidate is listed under one of two **tiers**:

| Tier | Rule | Confidence |
|---|---|---|
| **`named`** | The candidate's recorded `cwd` contains this session's id | Certain — the launcher named the parent |
| **`inferred`** | The harness says a program started it (`entrypoint: sdk-cli`), its `cwd` is inside this repo's worktree fan-out or a temp sandbox, and it began inside a **spawn window** | Probable — a guess, and labelled as one |

Anything else is not listed. In particular a session a human started (`entrypoint: cli`) never is,
which is what keeps a peer session out by construction rather than by a time window: measured on
this host, 934 of 946 human-started sessions (#128's decision comment).

- **`basis`** says which arm listed a row: `cwd-names-parent` for `named`; `worktree` or `tmp` for
  `inferred`.
- **Temp sandbox** means a `cwd` under `/tmp` or under `os.tmpdir()`. Both, because the harness
  can run with `TMPDIR` pointing somewhere else while launchers still use `/tmp`.
- **Worktree fan-out** is `fanOutCwd(<this session's cwd>)` — the repo and every checkout of it,
  the same set the picker's `Ctrl+W` scope uses. A candidate whose `cwd` is one of those
  directories or below one is inside it.

### The spawn window

A launcher only runs from a command, and a child cannot start before the command that launched
it. So the window opens at every turn of this session that ran a command, and stays open for
**`UNRECORDED_WINDOW_MS` = 30 minutes** — long enough to cover a whole `pr-review` run, which takes
6 to 23 minutes on this host. The windows of all such turns are merged.

- Turns come from the **tag file**, so a Task subagent's turns count too: a subagent that runs a
  launcher spawns on this session's behalf.
- A session's first timestamp is fixed, and Claude Code writes the transcript from its first line
  (measured: file birth within 200 ms of the first timestamp), so a candidate either began inside
  a window or never will.

**Road not taken — closing the window at the next turn.** A foreground command blocks the session,
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

The first three read state the walk already has, so the exclusion is exact for recorded edges and
costs nothing extra.

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
which is exactly what the seam exists to hold. The tier rules, the window and the exclusions are
semantics and stay on the shared side.

**Claude Code** implements it. It lists every project directory under the projects root, keeps
the ones whose mtime is at or after `sinceMs` (creating a transcript updates its directory's mtime,
so an older directory cannot hold a newer transcript), keeps each top-level `*.jsonl` whose own
mtime is at or after `sinceMs`, and reads the head of each for `timestamp`, `cwd` and `entrypoint`.
`entrypoint: "sdk-cli"` is `program`, `"cli"` is `human`, anything else is `null`. A transcript
whose head cannot be read is warned about on stderr through the existing
`warnUnreadableTranscript` and skipped.

**Pi** does not implement it: Pi's session header carries no field that separates a programmatic
start from a human one. A Pi child is therefore never listed. Filed as
[#209](https://github.com/princess-pi/wtft/issues/209).

### The listing

`extensions/lib/wtft-unrecorded.ts`:

- **`spawnWindows(turns)`** — the merged `[start, end]` windows, from deduplicated turns carrying
  at least one command.
- **`listUnrecordedSpawns({ rootSessionId, rootCwd, turns, exclude })`** — asks every discovery
  that has `listSpawnCandidates`, applies the tiers, drops the exclusions, prices each survivor
  with `parseSessionFile` and `computeSessionSummary` (`untaggedCostUsd` dropped, as for an edge),
  drops what another row folds, and returns the rows sorted by `ts`.

`computeSpawnTree` takes a new option, `unrecorded: { turns, rootCwd }`. When given, the tree
carries `unrecorded: UnrecordedSpawn[]`, listed after the walk so the walk's outcomes feed the
exclusion. The early return for a session with no edges now skips only the walk. The widget does
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
  because a nested key was added. `[]` means looked and found none.
- **`--tokens`:** an `UNRECORDED` block after the `SPAWNED` block, shown whenever the list is
  non-empty — including for a session with no recorded edges, where no `SPAWNED` block prints:

  ```
  UNRECORDED 2 session(s) no spawn record names (#128) —
             NOT in TOTAL or TREE: a list, not a claim
             inferred  /tmp/pr-review-az2eci2a                $0.42
             named     /tmp/pr-review.<id>.bugs               $0.17
  ```

  The `cwd` is the row's name, fitted to 40 columns. An unreadable row prints `(unreadable)` where
  its cost would be.
- **Exit 9** is untouched. The list is a report; nothing in it can make a number in the report
  change.

### The daemon's unbounded arm

#107's spec left one arm for this change: a `pendingClaudeCommands` turn that searched and found
nothing was re-discovered every poll for the daemon's life. It is now bounded like its neighbours,
by the discovery window plus the settle margin. Nothing is lost by the bound: a child's first
timestamp is fixed, discovery matches on it, and a child that begins after the window could never
have matched. A child that writes nothing until after the window closes — none is known — would
now be listed here instead of being retried forever.

## What it costs

One `stat` per project directory (2,243 on this host, 2026-09-22), then one `readdir` and one `stat`
per file only in directories touched since the session's first command, and one head read per
recent transcript. Pricing is one `parseSessionFile` per listed row. Paid only by `--json` and
`--tokens`.

## Verification

`tests/wtft-128-unrecorded-spawns.test.ts`, against a sandboxed projects root
(`WTFT_CLAUDE_PROJECTS_DIR`) and a sandboxed ledger (`XDG_STATE_HOME`):

- **The #116 Closer, second clause:** a parent whose Bash turn runs the `herdr agent start` line and
  a launcher child in `/tmp` with `entrypoint: sdk-cli`. With the record, the child is an edge and
  `unrecorded` is empty. With the record deleted, the child is in `unrecorded` as `inferred`/`tmp`
  with its cost, and `tree` equals `total`.
- A human-started peer (`entrypoint: cli`) in the same window and directory is absent.
- A programmatic peer outside every window is absent.
- A candidate recorded under a *different* parent in the ledger is absent.
- A candidate whose `cwd` contains the parent's id is `named`, even with `entrypoint: cli`.
- A candidate in a worktree of the parent's repo is `inferred`/`worktree`.
- A `claude -p` child the parent's own parse folded is absent — its cost is in `total`.
- A grandchild folded by a listed candidate is listed once, inside its parent's row.
- `--tokens` prints the `UNRECORDED` block for a session with no recorded edges, and nothing
  when the list is empty.
- Unit: `spawnWindows` merges overlapping windows and ignores turns with no command.
- Daemon: a spawning turn that found nothing leaves the pending queue once its window has closed.

## Not in this change

- **Pi children** — no programmatic-start field. [#209](https://github.com/princess-pi/wtft/issues/209).
- **The launcher side of `named`** — naming a sandbox after its parent session is
  [duppypro/princess-pi-tools#883](https://github.com/duppypro/princess-pi-tools/issues/883).
  `named` lights up for each launcher as it adopts the convention.
- **The widget** — no `UNRECORDED` line; its polling budget is not the report's.

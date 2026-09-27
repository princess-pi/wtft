# Spec 277 — a cost record for every PR

`bun run pr-cost` prints one JSON document for a branch. It records what the branch cost to build.
The document goes into the PR body, so the process that ships features can be measured before and
after a change to it. The script is `pr-cost.ts` at the repo root, beside `build.ts`. It is a repo tool,
so it is not shipped or installed, and `--help` does not list it.

## 1. Usage

```
bun run pr-cost [--branch <name>] [--pr <n>] [--write-pr]
```

- `--branch`: defaults to the current branch. A detached HEAD with neither flag is a bad call.
  The worktree is the current checkout when it is on that branch, else
  `<clone>/.claude/worktrees/<branch>`.
- `--pr`: defaults to the PR whose head is the branch, if there is one. `--pr` alone names a
  merged PR. Its branch comes from the PR, and its head is always the PR's own head, fetched from
  `pull/<n>/head`, because a local branch of that name may be stale or deleted. That is how the
  baseline for past PRs is taken.
- `--write-pr`: writes the document into that PR's body, between `<!-- pr-cost:begin -->` and
  `<!-- pr-cost:end -->`. If the markers are there, the block between them is replaced. If they
  are not, the block is added at the end.

Run it just before `pr-offer-merge`. Spend keeps growing until the merge, so a record taken at
`pr-open` would undercount.

Exit codes: 0 when the document was printed and, under `--write-pr`, written. 2 on a bad call. 1 on any other failure. `--write-pr` with no PR, or with a PR lookup that failed, exits 1 before printing anything. So
does a head that is already in `origin/main`, which has no changes of its own to measure.
Every field the script cannot measure is `null`, and one `gaps[]` entry names the reason. A gap
is never reported as zero.

## 2. The document (`wtft-pr-cost@1`)

| Key | What it holds |
|---|---|
| `branch`, `base`, `head`, `pr` | the branch name, its merge-base with `origin/main`, its tip, and the PR number. `pr` is `null` when the branch has no PR, and also when the lookup failed, which adds a `pr` gap |
| `files` | `{ source, tests, docs }`: counts over `git diff --name-only base..head`. `tests/**` is tests. `docs/**` (manifests included) and every root `*.md` are docs. Everything else, except `bun.lock`, is source |
| `sessions` | `{ transcripts, turns, costUsd, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }`: every Claude Code turn that ran in the worktree or reached into it (§3) |
| `tests` | `{ runs, suiteRuns, failedSuiteRuns, reruns, unreadableLines }`: from the worktree's `tmp/test-runs.jsonl` (§4) |
| `prReview` | `{ rounds, findings[], unreadableLogs, costUsd }`: one findings count per `reviewed` `pr-review` run log for this branch, oldest first. A run with any other status found nothing to count. `costUsd` is `null` (§5) |
| `macroscope` | `{ rounds }`: one round per PR commit that has a Macroscope check run which concluded. A `skipped` run (a Draft) or a `cancelled` run is not a round |
| `reconcile` | always `null` for now, with a gap (§5) |
| `gaps[]` | `{ field, reason }`, one per field that could not be measured. It also has an entry when a log line or run log did not parse, since the count is then a floor |

## 3. Which turns count

A turn counts when it ran in the worktree or reached into it:
- **Ran in it:** its transcript line's `cwd` is the worktree or a directory below it.
- **Reached into it:** a file it read or wrote is under the worktree, or one of its commands names
  the worktree's path. Both the absolute spelling and the `~/` spelling count. A session whose
  `cwd` is the main clone does its branch work this way, with `cd <worktree> && …`.

A main-clone turn that touches no worktree, such as a merge, a cleanup or a status-issue edit,
belongs to no branch and is left out. So is a text-only turn between two tool calls that reach in.
The record is a floor.

A turn that reaches into two worktrees counts in both records.

- **Transcripts read:** every `*.jsonl` in each `~/.claude/projects` directory named for this
  clone or one of its worktrees, plus every transcript under a session's `subagents/`, at any
  depth (workflow agents sit one level deeper). A directory counts when its name is the clone's
  slug, or starts with it, under either slug encoding the discovery code accepts. A missing
  projects directory lists nothing.
- **Time bound:** only files modified since the branch began are read. The start is the earlier
  of two times: when the parent of the branch's first own commit was committed, and when the
  earliest own commit was authored. `base` is later than both once main has been merged in. A
  rebase moves the parent but keeps the author dates.
- **None found:** `sessions` is `null`, with a gap. That happens when the work ran on another host
  or in another harness.
- **Pricing:** the wtft parser (`parseSessionFile`), the same code that prices `wtft --json`. A
  line's `cwd` is joined to its interaction by message id.
- **`claude -p` children:** they are counted where the parser folds them, which is inside the turn
  that spawned them, at that turn's cwd. A transcript that some parsed transcript folds is not
  also counted on its own.

*Road not taken:* `wtft --json` per session, as #277 first proposed. It has no per-turn cwd, and
this session's own transcript crosses several branches. Adding a cwd filter to the product CLI
would put a repo-process feature into the tool's public surface.

## 4. Test runs

`bun run test` (`tests/run.ts`) appends one line per run to `tmp/test-runs.jsonl` in the
checkout it runs in: `{ utc, suites: [{ name, ok }] }`. `tmp/` is gitignored, and the file goes
when `pr-cleanup` removes the worktree. So the record must be taken before cleanup, which §1
already requires.

- `runs`: lines. `suiteRuns`: suites across all lines. `failedSuiteRuns`: those with `ok: false`.
- `reruns`: `suiteRuns` minus the distinct suite names, so the second and later runs of each suite.
- A suite run on its own (`bun tests/x.test.ts`) is not recorded.

## 5. Gaps this version leaves standing

| Field | Why it is null | Where it is tracked |
|---|---|---|
| `prReview` cost | lens sessions run in `/tmp/pr-review-*`, and the run log does not name them | https://github.com/duppypro/princess-pi-tools/issues/1098 |
| `reconcile` | spec-reconcile writes no record of its findings | https://github.com/duppypro/princess-pi-tools/issues/1099 |
| Pi sessions | only Claude Code transcripts carry a per-line `cwd` | left standing: no branch work here runs in Pi today |
| Work on another host | transcripts are read from this host only | left standing: `sessions` is `null` with a gap, never zero |

## 6. Verification

`tests/wtft-277-pr-cost.test.ts`, against fixtures:
- Files are counted per class.
- Turns count when they ran in the worktree or reached into it (a `cd`, a `~/` spelling, a file
  path). A subagent transcript's turns count too. A sibling worktree whose name extends this one
  does not count.
- A worktree that no turn reached gives `null`.
- A folded transcript is not counted twice.
- `pr-review` logs are read per branch, and a missing directory is a gap, not zero.
- `tests/run.ts` appends its line, and the reader derives `reruns`.

Closer (#277): the next three merged PRs carry the block in their bodies.

## 7. Baseline

Taken 2026-09-27 with `bun run pr-cost --pr <n>` on merged PRs. The `tests` field is `null` for
all four, because their worktrees are gone.

| PR | Branch | Sessions USD | Turns | Files src / tests / docs | pr-review findings per round | Macroscope rounds |
|---|---|---:|---:|---|---|---:|
| #286 | `270-daemon-health` | 31.15 | 260 | 5 / 3 / 9 | 11, 6 | 4 |
| #292 | `281-spawner-claims-lease` | 53.38 | 401 | 6 / 5 / 10 | 16, 13, 7 | 3 |
| #298 | `288-half-block-and-ticks` | `null`: built on another host | — | 5 / 12 / 7 | 17, 3 | 2 |
| #299 | `270-cli-arms` | 11.41 | 51 | 7 / 3 / 8 | 15 | 3 |

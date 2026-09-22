# Spec — #107 A/B: discovery per spawning command, and the no-`cd` fallback

> **Issue:** [#107](https://github.com/princess-pi/wtft/issues/107) — findings **A** and **B**.
> **P5 of** [#194](https://github.com/princess-pi/wtft/issues/194). Finding **C** (an injectable
> root for `before-after.ts`) is P9 and is not in this change.
> **Waits on:** P3's fold records and P4's generation records, both merged.

## The gap this closes

A `claude -p` child's cost reaches its parent only if discovery looks in the project directory that
child's transcript landed in. Today the lookup is **one directory per turn**, derived from a `cd`
inside the spawning command, and a turn with no `cd` gets none at all.

**A — a spawn with no `cd` is dropped.** `cwdForClaudeSpawn` returns null and both callers hit
`if (!cwd) continue`. The ordinary case — `claude -p 'go'` run in the session's own working
directory, no `cd` needed — is exactly the case that yields null. The daemon does not re-queue it,
so that child's cost never reaches the tag file for the life of the process.

**B — two spawns in one turn search one directory.** `interaction.commands` is an array of Bash
calls, each with its own shell. `cd /a && claude -p 'x'` and `cd /b && claude -p 'y'` in one
assistant turn produce two children in two project dirs; only `/a` is searched, and `/b`'s child
drops.

Both end the same way: the session total silently under-reports and nothing raises a failure.

## The contract

**Discovery is per spawning command, not per turn.** Every command in the turn that spawns
contributes one search directory; the turn searches all of them and sums every child it finds.

**A spawn with no `cd` searches the session's own working directory.** "Own working directory" is
resolved from the session's own transcript with `resolveLastCwd` (`extensions/lib/harness/session-cwd.ts`),
not from the transcript's path.

- *Why the transcript's cwd and not `path.dirname(sessionPath)`:* the two agree for a Claude
  session, because the project dir is the slug of the cwd the session started in. They do **not**
  agree for a Pi session, whose transcript lives outside `~/.claude/projects` entirely — a `claude -p`
  it spawns still lands under the slug of the cwd, so the cwd is the portable key and the directory
  is not. Using the directory would also make any non-Claude transcript's own siblings candidates,
  which is how an unrelated session gets billed onto this one.
- *What it gives up:* `resolveLastCwd` reads the **last** `cwd` the transcript records. A session
  resumed in a second directory attributes its earlier no-`cd` spawns against the later cwd and
  misses them. Stated rather than fixed: the alternative is a per-entry cwd on every interaction,
  which is #97/#138 territory and costs a field on every line.

**A turn whose spawns yield no directory at all is still dropped** — an expandable `cd` target
(`cd $(mktemp -d)`) with an unknown session cwd has nothing to search. That is unchanged, and it is
one of the reasons #128 (P6) will report as `unrecorded`.

## The shape

`extensions/lib/wtft-parser.ts`:

- **`claudeSpawnCwds(commands, ownCwd): string[]`** replaces `cwdForClaudeSpawn(commands)`. One
  entry per spawning command — its own `cd` target, or `ownCwd` when it has none — deduped, in
  command order. Empty when nothing spawns, or when every spawn's directory is unknown.
  `cwdForClaudeSpawn` is **deleted**: returning a single cwd is finding B.
- **`discoverClaudeSubAgentFilesForTurn(commands, parentTimestamp, ownCwd, windowMs?)`** runs one
  `discoverClaudeSubAgentSessionFiles` per entry and unions the results: files deduped by path,
  the first `unreadable` kept, and `searched` naming how many directories were looked in — 0 is
  the "nothing to search" case a caller must not mistake for "looked and found nothing".
- **`discoverClaudeSubAgentSessionFiles(cwd, ts, windowMs?)` keeps its signature.** It is the
  per-directory scan, and three test suites and `bin/wtft.mjs` re-export it.
- **`attributeClaudeSubAgentCosts(interactions, ownCwd?)`** takes the fallback cwd and uses the
  per-turn discovery. `parseSessionFile` passes `resolveLastCwd(filePath)`, so a nested child's own
  grandchildren resolve against the child's cwd, not the root session's.
- **`claudeSpawnWindowClosesAt(interactions, ownCwd?)`** filters on `claudeSpawnCwds(...).length > 0`
  rather than on a single non-null cwd, so P4's discovery window opens for a no-`cd` spawn too.

`bin/wtft-daemon.ts`: the `pendingClaudeCommands` drain calls the per-turn discovery with
`resolveLastCwd(sessionPath)`. Its `if (!cwd) continue` — which dropped the item **without
re-queueing it**, so the turn was never retried — becomes a `searched === 0` check that keeps the
item pending while its window is open, the same rule every other miss follows.

## What it costs

One `readdirSync` per additional distinct directory per turn, only while that turn's discovery
window is open (15s + the 2s settle, P4's bound). A turn with one spawn and a `cd` searches exactly
what it searches today. A no-`cd` spawn adds the session's own project dir, which is the directory
the daemon already stats every poll for its own transcript.

`resolveLastCwd` is memoised on `(path, mtimeMs, size)`, so the fallback costs one tail read per
transcript change, not one per turn.

## Verification

Unit, over `claudeSpawnCwds`:

- a bare spawn with a known own cwd yields that cwd
- two spawns in two directories yield both, in command order
- a `cd` spawn and a bare spawn in one turn yield the `cd` target and the own cwd
- a bare spawn with no known own cwd yields nothing
- a `cd` in a **non-spawning** command still supplies nothing (the #106 finding B guard — this
  change must not reopen it)

End to end, in a sandboxed `HOME`:

- **A closer:** a session whose only spawn is a bare `claude -p` reports that child's tokens.
  Fails against `main`, which reports zero.
- **B closer:** one turn with two spawns in two directories attributes both children. Fails
  against `main`, which attributes one.
- **Daemon:** the same bare-spawn session, run through the daemon, puts the child's cost in the tag
  file — the path that also proves the pending item is retried rather than dropped.

Plus the existing suites, unchanged: `tests/wtft-106-other-reclaim.test.ts` (cwd extraction),
`tests/wtft-129-projects-root.test.ts` (slug variants), `tests/wtft-420-subagent-call-site.test.ts`
(one production call site), `tests/wtft-114-generation-records.test.ts` (P4's windows).

## Not in this change

- **#107 C** — an injectable projects root for `research/other-corpus/before-after.ts`. P9.
- **#116's launcher-spawned sessions.** Reason 2 of that spec ("no `cd`, so the cwd is null") stops
  being a reason here, but reason 3 — the child's cwd is a worktree or a `/tmp` sandbox the parent
  never wrote to — still holds, so a launcher-spawned child stays invisible to the parser and the
  spawn ledger remains its only route.
- **#128's `unrecorded[]` reasons** (P6). This change reduces the set; it does not report it.

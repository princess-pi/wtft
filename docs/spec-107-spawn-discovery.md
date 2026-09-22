# Spec — #107 A/B: discovery per spawn, and the no-`cd` fallback

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

**Discovery is per spawn, not per turn.** Every spawn in the turn contributes one search
directory; the turn searches all of them and sums every child it finds. One Bash call is one
shell, so the unit is the segment rather than the command string: a `cd` between two spawns moves
the second and not the first, and a `cd` after the last spawn is where the shell went next, not
where anything ran. Each spawn takes the `cd` state standing when the shell reached it, which is
also what keeps a segment that merely names claude (`which claude`) from ending the scan.

**A spawn with no `cd` searches the session's own working directory.** "Own working directory" is
resolved from the session's own transcript with `resolveLastCwd` (`extensions/lib/harness/session-cwd.ts`),
not from the transcript's path.

- *Why the transcript's cwd and not `path.dirname(sessionPath)`:* the two agree for a Claude
  session, because the project dir is the slug of the cwd the session started in. They do **not**
  agree for a Pi session, whose transcript lives outside `~/.claude/projects` entirely — a `claude -p`
  it spawns still lands under the slug of the cwd, so the cwd is the portable key and the directory
  is not. Using the directory would also make any non-Claude transcript's own siblings candidates,
  which is how an unrelated session gets billed onto this one.
- *What it gives up, twice over:* `resolveLastCwd` reads the **last** `cwd` the transcript
  records, so a session resumed in a second directory attributes its earlier no-`cd` spawns
  against the later cwd and misses them. And it reads only the last 512 KB, so a transcript that
  records `cwd` once at the top and then grows past that window resolves to `null` and gets no
  fallback at all — which is **Pi**, whose `session_start` entry is the only one carrying `cwd`.
  Both are stated rather than fixed: the alternative is a per-entry cwd on every interaction, which is #97/#138 territory
  and costs a field on every line.

**A folded session is counted once, by its own share.** Every level of the recursion now resolves
a real directory, so one turn's discovery returns the child AND the grandchild the child already
folded — they share a project dir and a window. The fold loop therefore accounts per session id,
adding each fold's OWN share rather than each file's inclusive total, which is the same number when
nothing overlaps and the right one when something does.

**A session never folds itself, or a session that folded it.** A real session's own transcript
lives in the very directory the fallback searches, and discovery matches on a timestamp window, so
a session that spawns within 15s of its own start is a candidate for folding itself — and two
sessions in one directory are candidates for folding each other, forever. `parseSessionFile` now
carries the set of transcripts it is already inside, and the FOLD pass skips every one of them.
Discovery itself still returns them: it answers "what is in this directory in this window", and
every caller that folds what it gets adds its own guard — the daemon's is a path comparison
against the session it watches, and it also hands that path to `parseSessionFile` as an ancestor,
so a child cannot fold the session that spawned it.

**A transcript the caller already lists is never folded into a sibling.** The one-shot CLI and
the widget parse a list of a session's children — its Task subagents and its Pi siblings — and
append every one of them, so a sibling that one of them folds is that sibling's cost twice.
`loadSubagentInteractionsChecked` therefore hands every path in the list to every parse as
`doNotFold`, which is the same rule the daemon states as one child, one holder, in the one place
where a single call can see the whole list.

**A turn whose spawns yield no directory at all waits out its window, then is dropped** — an
expandable `cd` target (`cd $(mktemp -d)`), a bare `cd` (the shell went to `$HOME`, which the
transcript does not name), a launcher with no `cd` of its own, or a direct spawn whose session cwd
is unreadable. A launcher that does `cd` first is searched under that target like any other
command — what the fallback withholds is the session's cwd, not the one the command named. Only the
last of those can change on a later poll, which is why the wait is the window rather than a single
try; the others are settled at the first look and simply cost their window. Once it closes the turn
is gone, and it is one of the reasons #128 (P6) will report as `unrecorded`.

## The shape

`extensions/lib/wtft-parser.ts`:

- **`claudeSpawnCwds(commands, ownCwd): string[]`** replaces `cwdForClaudeSpawn(commands)`. One
  entry per spawning segment — the `cd` standing when the shell reached it, or `ownCwd` when no
  `cd` preceded it — deduped, in command order. Empty when nothing spawns, or when every spawn's
  directory is unknown.
  `cwdForClaudeSpawn` is **deleted**: returning a single cwd is finding B.
  - **Only a direct run inherits the session's cwd.** `commandSpawnsAgent` also fires on a launcher
    that merely names claude in a flag (`herdr agent start … --kind claude`), and that child starts
    in a worktree or a sandbox, so the shell's cwd says nothing about where its transcript landed.
    The fallback therefore applies only when the shell itself runs `claude`, after prefixes like
    `timeout 180` are stripped. This is what keeps #116's control — a launcher-spawned session is
    still invisible to the parser, and the spawn ledger is still its only route.
  - **An unknowable `cd` target does not fall back either.** `cd $(mktemp -d) && claude -p` ran
    somewhere the transcript does not name; the session's own cwd would be a wrong guess, not a
    missing one.
- **`discoverClaudeSubAgentFilesForTurn(commands, parentTimestamp, ownCwd, windowMs?)`** runs one
  `discoverClaudeSubAgentSessionFiles` per entry and unions the results: files deduped by path,
  the first `unreadable` kept, and `searched` naming how many directories were looked in — 0 is
  the "nothing to search" case a caller must not mistake for "looked and found nothing". A
  directory-level throw is caught per directory and becomes that `unreadable`, so one unreadable
  directory reports itself without discarding what the turn's other directories found.
- **`discoverClaudeSubAgentSessionFiles(cwd, ts, windowMs?)` keeps its signature.** It is the
  per-directory scan, and three test suites and `bin/wtft.mjs` re-export it.
- **`attributeClaudeSubAgentCosts(interactions, ownCwd?, ancestors?)`** takes the fallback cwd and
  the transcripts the parse is already inside, and uses the per-turn discovery. `parseSessionFile`
  passes `resolveLastCwd(filePath)`, so a nested child's own grandchildren resolve against the
  child's cwd, not the root session's, and adds its own path to `ancestors` before recursing. The
  guard lives in the FOLD pass, not in discovery: discovery still returns the transcript, and each
  caller decides. Identity is the canonical path (`canonicalTranscriptPath`, a `realpathSync` that
  falls back to `resolve`), because discovery builds its paths by joining and a symlinked
  transcript or project dir would otherwise reach the guard spelled differently. `loadSubagentInteractionsChecked` — the CLI and widget's reader for Task-tool
  children — takes the root session as `rootFile` for the same reason: a Task child that runs a
  bare `claude -p` searches the root's own project dir. The daemon's own caller drops a discovered file whose path is the session it is
  watching, for the same reason and by a different route.
- **`claudeSpawnWindowClosesAt(interactions, ownCwd?)`** filters on `claudeSpawnCwds(...).length > 0`
  rather than on a single non-null cwd, so P4's discovery window opens for a no-`cd` spawn too.

`bin/wtft-daemon.ts`: the `pendingClaudeCommands` drain calls the per-turn discovery with
`resolveLastCwd(sessionPath)`. It also has to undo one consequence of per-command discovery: one
turn's window now returns both a child and the grandchild that child folds, and the daemon syncs
each discovered transcript in its own `parseSessionFile` call, so the fold pass's within-one-call
accounting cannot see across them. So a transcript some other synced transcript folds is skipped,
and one already synced before that fold was seen has its source retired with a generation record
(#114) — P4's mechanism, used here for what it was built for.

That skip set is **derived from current fold state every poll, never accumulated**: it is rebuilt
from each synced transcript's `foldStamps`, so when a folder rotates and its new parse no longer
folds the child, the child is synced under its own source again on the next poll rather than
staying suppressed for the daemon's life.

**One child, one holder.** Two in-window transcripts in a shared project dir each discover the
other's children, and each parse bakes what it folds into its own turns — so the same child's cost
lands in both, and retiring the child's own source does not remove either copy. The daemon
therefore names an owner for every folded transcript, the lexicographically first holder, and hands
every other holder that child in its `doNotFold` set. The set is part of the change gate, so a
transcript re-parses when what it may fold changes (pinned by D8).

**A mutual fold keeps exactly one of the pair, chosen by path.** Two children of one turn in the
shared project dir each fold the other, so a rule that retired everything folded elsewhere would
retire both — and the poll after, with nothing left folding either, would re-sync both. The total
would alternate between double and none forever. The tie-break is the canonical path, which cannot
flip between polls. It converges rather than being instantaneous: both children are synced before
either parse reveals the fold, so the tag passes through the doubled total and is corrected by the
generation record that retires the loser (pinned by D7). Identity throughout is the canonical path —
`syncSubagentTranscript` canonicalises the path it is handed, so one transcript has one state
entry and one source however the path that reached it was spelled. Its `if (!cwd) continue` — which dropped the item **without
re-queueing it**, so the turn was never retried — becomes a `searched === 0` check that keeps the
item pending while its window is open. The arm beside it is unchanged and is NOT window-bounded:
a turn that searched and found nothing stays pending with no time bound, which is a property #128
(P6) has to report on rather than one this change touches.

**The residual this leaves: a sibling, not a child.** Discovery's rule is "a session that started
in that directory within ±15s of the spawning turn", and the directory the fallback searches also
holds the session's own siblings — every other session started in that repo. A sibling that starts
inside the window is folded as though it were the child. That hazard is not new (a `cd`-target
directory has the same rule) but the fallback raises how often the searched directory is a busy
one. It is not narrowed here: the honest fix is a spawn-time edge, which is #116's ledger, and
reporting the uncertainty is #128 (P6). A child cannot start before the command that spawned it, so
a one-sided window would halve the hazard — a road not taken here, because it changes the discovery
contract for every spawn rather than for the case #107 adds.

## What it costs

One `readdirSync` per additional distinct directory per turn — distinct, so two spawns into one
directory search it once. A turn with one spawn and a `cd` searches exactly what it searches today.
A no-`cd` spawn adds one directory the poll did not otherwise touch: the daemon stats the session
transcript every poll, never its project dir.

The bound is the pending queue's, not this change's, and it is not uniform: a turn that searched
and found nothing is re-discovered every 667ms for the daemon's life, while one that found
something, and one that had nowhere to look, stop at the window plus the settle margin. So a
no-`cd` spawn that never produces a child costs one extra `readdirSync` per poll, indefinitely —
the same shape the `cd` arm already had, now reachable by more turns. Bounding that arm is #128's
(P6) to do, since the bound and the `unrecorded[]` report are the same decision.

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
- a launcher that only names claude in a flag yields nothing, while `timeout 180 claude -p` still
  inherits the cwd
- two spawns either side of a `cd` in ONE command yield both directories, a `cd` after a launcher
  yields nothing, and a `cd` after a bare spawn moves only the spawn that follows it
- a sibling in the caller's own parse list is billed once, not once on its own and once folded
- a session whose own transcript sits in the directory it searches does not fold itself, and two
  such sessions fold each other exactly once rather than forever

End to end, against a sandboxed projects root (`WTFT_CLAUDE_PROJECTS_DIR`, the seam #129 gave
discovery — not a fake `HOME`, which bun captures once at process start, so the in-process parses
would read the real one):

- **A closer:** a session whose only spawn is a bare `claude -p` reports that child's tokens.
  Fails against `main`, which reports zero.
- **B closer:** one turn with two spawns in two directories attributes both children. Fails
  against `main`, which attributes one.
- **Daemon:** the same bare-spawn session, run through the daemon, puts the child's cost in the tag
  file — the path that also proves the pending item is retried rather than dropped.

`tests/wtft-106-other-reclaim.test.ts` (cwd extraction) and `tests/wtft-116-spawn-ledger.test.ts`
(the launcher control) keep their assertions and are rewritten to the new call. Unchanged:
`tests/wtft-129-projects-root.test.ts` (slug variants), `tests/wtft-420-subagent-call-site.test.ts`
(one production call site), `tests/wtft-114-generation-records.test.ts` (P4's windows).

## Not in this change

- **#107 C** — an injectable projects root for `research/other-corpus/before-after.ts`. P9.
- **#116's launcher-spawned sessions.** All three of that spec's reasons still hold for a
  launcher, and reason 2 is now held by this change rather than by an accident: the no-`cd`
  fallback deliberately withholds itself from a command whose shell does not run `claude`. A
  launcher-spawned child stays invisible to the parser, and the spawn ledger remains its only
  route.
- **#128's `unrecorded[]` reasons** (P6). This change reduces the set; it does not report it.

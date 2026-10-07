# Spec 442 — the daemon roster: Token Budget reads what the daemons publish, never walks the session trees

Issue: https://github.com/princess-pi/wtft/issues/442. Direction A, chosen by Duppy on 2026-10-06.
Status: **Spec Approved** (Duppy, 2026-10-06).

Module: `extensions/lib/daemon-roster.ts` · Seam: `decideActive`, tested in `tests/wtft-442-daemon-roster.test.ts`
Also: `bin/wtft-daemon.ts` — publishes this process's roster. `extensions/token-budget.ts` — reads the roster in place of the walk.

## 1. Problem, measured

Before this change, every Token Budget widget update that draws and every provider request called
`findActiveSessionFiles`, which `readdirSync`ed and `statSync`ed every entry under
`~/.pi/agent/sessions` and the Claude projects root, looking for `wtft-tags/*.jsonl` files touched
in the last 2 minutes. On Duppy's host on 2026-10-06 that walk covered about 72,000 entries and
3,459 `wtft-tags/` directories. An idle Pi with only `pi/token-budget.js` loaded measured **20.6%**
of one core in the first run (0.0% with no extensions) and 51.3% in the V6 run later that night;
the walk's cost moves with the host's load and the size of the trees.

Only the daemon writes a tag file (appends, the in-place heartbeat, and the truncations when a daemon
starts serving a session, all in `bin/wtft-daemon.ts`). So a tag file touched in the last 2 minutes was touched by a daemon
that was alive within the last 2 minutes, and that daemon knew the path. The walk re-derives a fact the
writer already held (spec-270 §2's shape).

## 2. The roster

**Daemon roster**: one file per daemon process, `$XDG_STATE_HOME/wtft/roster/<pid>.json`
(default `~/.local/state/wtft/roster/`), naming the tag file of every session that process
serves:

```json
{"v":1,"pid":12345,"tags":["/home/u/.claude/projects/-p/wtft-tags/<id>.jsonl.wtft-tag.v2.14.0.jsonl"]}
```

- `tags` holds absolute paths, sorted, without duplicates.
- Written as `<pid>.json.tmp` then renamed, so a reader never sees a partial file.
- The directory is created private (mode 0700), as `daemonStdio` creates the daemon log's.
- `$XDG_STATE_HOME` is per suite under `bun run test`, so fixture daemons never reach the host's
  roster.

### 2a. Writers (`bin/wtft-daemon.ts`)

| Daemon | When it publishes | What |
|---|---|---|
| per-session | each poll in `loop` that keeps serving (not the one that stops it) | `[slot.state.tagPath]` |
| harness | the end of each `sweepIdleSlots` (250 ms) that keeps the harness running, beside `persistHandOff` | the `state.tagPath` of every record in `registry.served` |

`publishRoster` keeps the last text it wrote in memory and writes only when the text differs or
the file is gone, so a steady daemon writes the file once and a roster deleted under it comes back
on its next publish. An empty list removes the file: a harness serving nothing has none. A failed
write warns on the daemon's stderr when its message differs from the last one warned, and the
daemon keeps serving.

**A dropped session leaves the roster.** When a harness stops serving a session, its roster
stops listing that tag, so that session's last turns can stop counting toward Token Budget.

**At exit, a daemon leaves its file.** Its turns from the last minute still count toward TPM, and
the roster is how a reader finds them. Readers keep a stopped daemon's file while one of its tags
was written in the last 2 minutes, then delete it (§2c). A daemon start that gets past its lease or root claim runs the same prune.

### 2b. Interface (`extensions/lib/daemon-roster.ts`)

```ts
export const ACTIVE_WINDOW_MS = 120_000;
export function rosterDir(env?: NodeJS.ProcessEnv): string;
export function publishRoster(tagPaths: string[]): void;         // this process's file, write-on-change
export interface RosterEntry {
  file: string;                       // the roster file
  holder: HolderKind;                 // classifyPid(pid), extensions/lib/holder.ts
  tags: { path: string; mtimeMs: number | null }[];  // null: stat failed
}
export function decideActive(entries: RosterEntry[], now: number): { active: FileInfo[]; prune: string[] };
export function activeTagFiles(now: number): FileInfo[];        // read, decide, prune, return
export function pruneRoster(now: number): void;                 // daemon start
```

`FileInfo` is Token Budget's existing `{ path, mtime }`, now exported from this module.
`decideActive` is pure. `activeTagFiles` is the adapter:

- It lists `rosterDir()`; a directory that is missing or cannot be listed yields no tags.
- It reads only names of the form `<pid>.json` and `<pid>.json.tmp`. Any other file there is left
  alone.
- It parses each `<pid>.json`, classifies its pid, and stats each listed tag. Entries of `tags`
  that are not strings are ignored. The reader trusts the writer's absolute paths.
- A `<pid>.json.tmp` left by a write that died mid-way is an entry with no tags, so it is deleted
  once its pid has stopped (§2c) and kept while any process holds that pid and is not classed
  `gone` or `other`.
- It calls `decideActive`, deletes `prune` and every `<pid>.json` it could not read as a roster,
  and returns `active`. A delete that fails is skipped: the read still answers, and a reader
  allowed to delete the file does so later.

### 2c. The decision (`decideActive`)

| Roster file | Outcome |
|---|---|
| holder `daemon`, `harness` or `unverified` | kept; its tags are candidates |
| holder `gone` or `other` (stopped, or its pid reused by a program whose command line reads as not a daemon), with at least one active tag | kept; its tags are candidates |
| holder `gone` or `other`, with no active tag | pruned |
| unreadable, not JSON, `v` not 1, the file name's pid not the content's, or `tags` not a list | deleted by the adapter, never seen by `decideActive` |

A candidate tag is **active** when its `mtimeMs` is not null and `now - mtimeMs < ACTIVE_WINDOW_MS`,
the rule the deleted walk applied. A path listed by two rosters (a hand-over between daemons) is
returned once, with the mtime of its first in-window listing. A tag that vanished or cannot be stat'd is
skipped and the rest continue, which also ends #432's first half (one vanished tag file ending the
scan).

### 2d. Reader (`extensions/token-budget.ts`)

`findActiveSessionFiles` and its two tree walks are deleted. Both callers, the widget update and
`before_provider_request`, take `activeTagFiles(Date.now())`. `PI_DIR` and the `projectsDir` import
went with them, so `WTFT_CLAUDE_PROJECTS_DIR` no longer affects Token Budget.
`aggregateActiveTpm`, the stats cache and the tick are unchanged.

## 3. What does not change

- TPM, session TPM, the cooldown, and the widget's text: the tag files found are read the same way.
  The files found are the ones daemon rosters list, which is not the walk's set: a daemon that
  publishes no roster under the reader's `$XDG_STATE_HOME` is not counted, and a listed tag
  outside the two trees now is.
- The tag-file format, leases, the harness hand-off (`.served`) and every `wtft` CLI surface.
  `wtft-daemon --help` gains its `XDG_STATE_HOME` and `TMPDIR` lines, and the daemon's stderr a
  roster-publish warning.
- The 1 s default tick. Even with the roster, an idle widget re-renders every second; whether
  that default should move is a separate question, not this issue.
- Reading active tag files in full. A live per-session daemon's heartbeat keeps its tag active
  while idle, so Token Budget keeps re-reading it (#451).

## 4. Roads not taken

- **B. Cache the `wtft-tags/` directory list** and rescan rarely: no new contract, but still
  O(tag directories) stats per tick, about 3,459 today and growing.
- **C. Recursive `fs.watch` in the extension:** near-zero idle cost, but it duplicates the watching
  the daemon already does, at one inotify watch per directory.
- **Reuse the harness `.served` file:** it is the hand-off to the next harness, rename-claimed at
  start, lives beside a hashed root file in `$TMPDIR` (whose listing is about 9 MB on this host), and
  per-session daemons have none.
- **Delete the roster at exit:** loses up to a minute of a just-stopped session's TPM, for example
  across every `bin/install-wtft` restart.
- **Prune by directory mtime:** appending to a tag file does not change its directory's mtime.

## 5. Verification

| # | Check | How |
|---|---|---|
| V1 | `decideActive`'s three rows of §2c, plus duplicate paths, a null mtime and a tag outside the window | `tests/wtft-442-daemon-roster.test.ts`, in memory |
| V2 | `publishRoster` writes once for unchanged input, rewrites on change, re-creates a deleted roster, removes on an empty list; `activeTagFiles` keeps a stopped daemon's roster with a recent tag, deletes a stopped daemon's quiet roster, each unreadable kind of §2c's last row, and a stopped daemon's `.tmp`; keeps a live daemon's `.tmp` and a file that is not a roster; creates the directory 0700; still answers when a delete is refused | same suite, temp `XDG_STATE_HOME` |
| V3 | a per-session fixture daemon publishes a roster naming its tag path; a harness fixture daemon's roster lists every served session's tag path | same suite, real daemon under the test runner's isolation |
| V4 | Token Budget counts a session's TPM from a tag file reachable **only** through the roster: the Pi sessions dir and the projects root are empty | same suite, through the extension's `turn_start` handler and its widget text |
| V5 | the existing Token Budget suites pass unchanged | `bun run test` |
| V6 | **Closer:** idle Pi with only `pi/token-budget.js` uses under 1% of one core over 20 s on this host | the #442 repro script, main's bundle against this branch's: 51.3% → 0.3% on 2026-10-06 |

## 6. Glossary

`CONTEXT.md` gains **Daemon roster**: the per-process file above, its writer and its reader. It is
not the **Lease** (per session, who serves it) and not the harness hand-off `.served` (per harness
root, what the next harness adopts).

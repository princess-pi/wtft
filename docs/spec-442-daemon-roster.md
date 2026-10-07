# Spec 442 — the daemon roster: Token Budget asks the daemons, never walks the session trees

Issue: https://github.com/princess-pi/wtft/issues/442. Direction A, chosen by Duppy on 2026-10-06.
Status: **Spec Approved** (Duppy, 2026-10-06).

Module: `extensions/lib/daemon-roster.ts` · Seam: `decideActive`, tested in `tests/wtft-442-daemon-roster.test.ts`
Also: `bin/wtft-daemon.ts` — publishes this process's roster. `extensions/token-budget.ts` — reads the roster in place of the walk.

## 1. Problem, measured

Every Token Budget tick (default 1 s) calls `findActiveSessionFiles`, which `readdirSync`s and
`statSync`s every entry under `~/.pi/agent/sessions` and the Claude projects root, looking for
`wtft-tags/*.jsonl` files touched in the last 2 minutes. On Duppy's host on 2026-10-06 that walk
covers about 72,000 entries and 3,459 `wtft-tags/` directories, and an idle Pi with only
`pi/token-budget.js` loaded measured **20.6%** of one core (0.0% with no extensions).

Only the daemon writes a tag file (`appendTagFile`, `upsertHeartbeat` and `initClassified`, all in
`bin/wtft-daemon.ts`). So a tag file touched in the last 2 minutes was touched by a daemon that was
alive within the last 2 minutes, and that daemon knew the path. The walk re-derives a fact the
writer already held (spec-270 §2's shape).

## 2. The roster

**Daemon roster**: one file per daemon process, `$XDG_STATE_HOME/wtft/roster/<pid>.json`
(default `~/.local/state/wtft/roster/`), naming every tag file that process writes:

```json
{"v":1,"pid":12345,"tags":["/home/u/.claude/projects/-p/wtft-tags/<id>.jsonl.wtft-tag.v2.14.0.jsonl"]}
```

- `tags` holds absolute paths, sorted, without duplicates.
- Written as `<pid>.json.tmp` then renamed, so a reader never sees a partial file.
- `$XDG_STATE_HOME` is per suite under `bun run test`, so fixture daemons never reach the host's
  roster.

### 2a. Writers (`bin/wtft-daemon.ts`)

| Daemon | When it publishes | What |
|---|---|---|
| per-session | every poll in `loop` | `[slot.state.tagPath]` |
| harness | end of every `sweepIdleSlots` (250 ms), beside `persistHandOff` | the `state.tagPath` of every record in `registry.served` |

`publishRoster` keeps the last text it wrote in memory and writes only when the text differs, so
a steady daemon writes the file once. A harness serving nothing removes its file.

**At exit, a daemon leaves its file.** Its turns from the last minute still count toward TPM, and
the roster is how a reader finds them. Readers keep a dead daemon's file for 2 minutes after its
last write, then delete it (§2c). A daemon start runs the same prune, so files from crashed daemons
stay bounded even when no Token Budget runs.

### 2b. Interface (`extensions/lib/daemon-roster.ts`)

```ts
export const ACTIVE_WINDOW_MS = 120_000;
export function rosterDir(env?: NodeJS.ProcessEnv): string;
export function publishRoster(tagPaths: string[]): void;         // this process's file, write-on-change
export interface RosterEntry {
  file: string;                       // the roster file
  holder: HolderKind;                 // classifyPid(pid), extensions/lib/holder.ts
  writtenMs: number;                  // the roster file's mtime
  tags: { path: string; mtimeMs: number | null }[];  // null: stat failed
}
export function decideActive(entries: RosterEntry[], now: number): { active: FileInfo[]; prune: string[] };
export function activeTagFiles(now: number): FileInfo[];        // read, decide, prune, return
export function pruneRoster(now: number): void;                 // daemon start
```

`FileInfo` is Token Budget's existing `{ path, mtime }`. `decideActive` is pure. `activeTagFiles`
is the adapter: it lists `rosterDir()`, reads and parses each file, classifies its pid, stats each
listed tag, calls `decideActive`, unlinks `prune`, and returns `active`.

### 2c. The decision (`decideActive`)

| Roster file | Outcome |
|---|---|
| holder `daemon`, `harness` or `unverified` | kept; its tags are candidates |
| holder `gone` or `other`, written less than `ACTIVE_WINDOW_MS` ago | kept; its tags are candidates |
| holder `gone` or `other`, written `ACTIVE_WINDOW_MS` ago or more | pruned |
| unreadable, not JSON, `v` not 1, or the file name's pid not the content's | pruned |

A candidate tag is **active** when its `mtimeMs` is not null and `now - mtimeMs < ACTIVE_WINDOW_MS`,
the same rule `findActiveSessionFiles` applies today. A path listed by two rosters (a hand-over
between daemons) is returned once, with its one mtime. A tag that vanished or cannot be stat'd is
skipped and the rest continue, which also ends #432's first half (one vanished tag file ending the
scan).

### 2d. Reader (`extensions/token-budget.ts`)

`findActiveSessionFiles` and its two tree walks are deleted. Every caller takes
`activeTagFiles(Date.now())`. `PI_DIR` and the `projectsDir` import go with them if nothing else
uses them. `aggregateActiveTpm`, the stats cache and the tick are unchanged.

## 3. What does not change

- TPM, session TPM, the cooldown, and the widget's text: the same tag files are read the same way.
- The tag-file format, leases, the harness hand-off (`.served`) and every CLI surface.
- The 1 s default tick. Even with the roster, an idle widget re-renders every second; whether
  that default should move is a separate question, not this issue.
- Reading an *active* tag file in full on each uncached tick. That cost exists only while tokens
  are being spent, so it is not the idle bug; it stays as is.

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
| V1 | `decideActive` rules of §2c, each row, plus duplicate paths, a null mtime and a tag outside the window | `tests/wtft-442-daemon-roster.test.ts`, in memory |
| V2 | `publishRoster` writes once for unchanged input, rewrites on change, removes on an empty harness list; `activeTagFiles` prunes a dead, old roster from disk | same suite, temp `XDG_STATE_HOME` |
| V3 | a per-session fixture daemon publishes a roster naming its tag path; a harness fixture daemon's roster lists every served session's tag path | same suite, real daemon under the test runner's isolation |
| V4 | Token Budget counts a session's TPM from a tag file reachable **only** through the roster: the Pi sessions dir and the projects root are empty | same suite, through the extension's exported reader |
| V5 | the existing Token Budget suites pass unchanged | `bun run test` |
| V6 | **Closer:** idle Pi with only `pi/token-budget.js` uses under 1% of one core over 20 s on this host | the #442 repro script, before and after `bin/install-wtft` |

## 6. Glossary

`CONTEXT.md` gains **Daemon roster**: the per-process file above, its writer and its reader. It is
not the **Lease** (per session, who serves it) and not the harness hand-off `.served` (per harness
root, what the next harness adopts).

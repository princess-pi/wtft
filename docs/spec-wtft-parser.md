# Discovery — which child transcripts a session's total takes in

The live spec for the discovery functions of `extensions/lib/wtft-parser.ts`. A behaviour change
in them edits this file. Its change records are in §8. Its scope is discovery only: the rest of the module (parsing,
classification, `claude -p` attribution) is still described by its per-issue specs. Vocabulary:
`CONTEXT.md` (Session, Subagent session, Subagent meta, Provisional).

Module: `extensions/lib/wtft-parser.ts` · Seam: `discoverSubagentSessionFiles`, tested in `tests/wtft-146-149-subagent-discovery.test.ts`

Discovery finds a session's child transcripts, so their spend folds into the parent: Task
subagents under the session's `subagents/` directory, Pi sibling sessions, and `claude -p` spawns
matched by cwd and time. It lists files. Reading and pricing them is the caller's.

## 1. Interface

| Export | What it is |
|---|---|
| `discoverSubagentSessionFiles(sessionPath, { quietSession? }) → { files, unreadable, sessionUnreadable }` | Task subagents and Pi siblings of one session (§2) |
| `discoverClaudeSubAgentSessionFiles(cwd, parentTimestamp, windowMs?) → string[]` | `claude -p` sessions in one cwd's project directories whose first timestamp falls in the window (§3) |
| `discoverClaudeSubAgentFilesForTurn(commands, parentTimestamp, ownCwd, windowMs?) → { files, unreadable, searched }` | The above, once per directory one turn's spawns name (§3) |
| `readSubagentMetaChecked(transcriptPath) → { meta, error, metaPath }` | The `.meta.json` beside a Task transcript (§4). `readSubagentMeta` returns its `meta` only |

## 2. Task subagents and Pi siblings — `discoverSubagentSessionFiles`

**What it lists.**
- **The walk.** `<session-dir>/<session-id>/subagents/` and every real directory under it, except
  one named `wtft-tags` (wtft's own output). A symlink to a directory below `subagents/` is never
  entered. Every
  other entry named `agent-*.jsonl` that is not a directory is listed. The walk stats entries and
  reads no file, so a listed transcript may still fail to read; its reader reports that.
- **The Pi sibling scan.** Only when the session transcript's first line is a session header with
  an `id`. Lists each other `.jsonl` in the session's directory whose first line is a session
  header naming that `id` as `parentSession`.
- **Once each.** Each real directory is walked once and each transcript listed once, by real
  path, across both halves.
- Where discovery reads a file, it reads only its first lines.

**Skipped silently** — no warning, nothing in the result:
- `subagents/` absent (ENOENT, or ENOTDIR from a path through a file), or not a directory.
- A walk entry whose stat finds nothing (ENOENT: gone, or a dangling symlink) or meets a symlink
  loop (ELOOP).
- The session transcript not written yet (ENOENT): no sibling scan, and the walk still runs
  (`docs/spec-479-pi-discovery-enoent.md`).
- A session transcript whose first line does not parse or is not a session header: no sibling scan.
- A sibling whose first-line read fails for any reason, or whose first line does not parse: a
  non-match (`docs/spec-369-skip-unreadable-discovery.md`).

**Warned and reported** — the files found are still returned, and `unreadable` holds the first
failure:
- A walk entry whose stat fails any other way. It is not listed.
- The session transcript's first-line read fails for any reason but ENOENT. The failure is also
  returned as `sessionUnreadable`. With `quietSession`, discovery leaves that warning to the
  caller; the log parser daemon's tagger passes it and warns once itself.
- Warnings are latched per path for the life of the process.

**Thrown**, after a warning latched per directory:
- `subagents/` cannot be stat'd for any reason but ENOENT or ENOTDIR.
- `subagents/`, or any directory under it, cannot be listed.
- The session's own directory cannot be listed for the sibling scan.

A throw returns no files: the caller has nothing from that call.

**EISDIR, half by half.**
- **The walk** reads no file, so it never meets EISDIR. A real directory named
  `agent-*.jsonl` is walked into like any other. A symlink to a directory is skipped by its stat type.
- **The sibling scan** skips a real directory by its entry type. A symlink to a directory fails its
  first-line read with EISDIR and is skipped like any sibling it cannot read.
- **The session transcript** that is a directory fails its first-line read with EISDIR, and is
  warned and reported like any other session transcript that cannot be read.

## 3. `claude -p` spawns

**`discoverClaudeSubAgentSessionFiles`** looks in the project directory of every slug the cwd may
be filed under, and lists each `.jsonl` there that is not a directory and whose first timestamp,
from its first lines, falls within `windowMs` of the parent's timestamp (default
`CLAUDE_SUBAGENT_WINDOW_MS`).
- **Skipped silently:** a project directory that is absent (ENOENT) or not a directory; a candidate whose
  first-line read fails for any reason (EISDIR from a symlink to a directory included), or that
  carries no parseable timestamp.
- **Thrown**, after a warning latched per directory: a project directory whose stat fails for any
  reason but ENOENT, or that cannot be listed.

**`discoverClaudeSubAgentFilesForTurn`** runs that once per distinct directory the turn's spawns
name (`docs/spec-107-spawn-discovery.md`). It does not throw for a directory: the first directory's
failure is returned as `unreadable`, and the files the other directories found are still
returned. `searched` is how many directories it looked in; 0 means there was nothing to look in,
never "looked and found nothing".

## 4. Subagent meta — `readSubagentMetaChecked`

Never throws.
- **Absent** (the file or a directory on its path is missing): `meta` and `error` null.
- **Reads but does not parse**, or lacks a required field: `meta` null, `error` null — the same as
  absent.
- **Exists and its read fails:** `meta` null, `error` set. The CLI turns it into a
  `subagent-meta-unreadable` notice (`docs/spec-146-147-148-subagent-discovery.md`).
- A transcript path not ending `.jsonl` has no meta: all three null.

## 5. What a report or a throw costs each caller

- **The log parser daemon's tagger** fails the poll, so the swept marker is withheld and the next
  poll retries (`docs/spec-session-tagger.md` §2).
- **The CLI report**, where it runs discovery, marks the total provisional with reason
  `subagent-unreadable`, and omits `subagents[]` from `--json` (`docs/spec-26-json.md`).
- **The Pi widget** keeps the session's own turns and prints its provisional line
  (`docs/spec-165-widget-provisional.md`).
- **The spawn walk** marks the descendant's edge `unreadable`
  (`docs/spec-230-231-232-spawn-tree-gaps.md`).

## 6. Tests

- `tests/wtft-146-149-subagent-discovery.test.ts` — the seam: bounded first-line reads; unbounded
  depth; a symlink cycle listed once; a symlinked directory not walked; a symlink whose target
  cannot be stat'd reported; real-path dedup across the halves; a directory, or a symlink to one,
  named `*.jsonl` skipped silently in the `claude -p` scan; a symlink to one skipped in the sibling
  scan; the meta notice.
- `tests/wtft-457-unreadable-transcript.test.ts` (Part C) — a walk entry that cannot be stat'd
  reported, not thrown; an unreadable `subagents/` or project directory warned and thrown;
  ENOTDIR read as absent; the session transcript's read failure reported.
- `tests/wtft-369-skip-unreadable-discovery.test.ts` — an unreadable `claude -p` candidate and an
  unreadable Pi sibling skipped silently.
- `tests/wtft-479-pi-discovery-enoent.test.ts` — a session transcript not written yet is silent;
  one that exists and cannot be read is warned and reported.
- `tests/wtft-issue-82.test.ts`, `tests/wtft-issue-141-workflow-discovery.test.ts` — nested
  subagents and workflow children listed; `wtft-tags` skipped.
- `tests/wtft-107-spawn-discovery.test.ts`, `tests/wtft-129-projects-root.test.ts` — `claude -p`
  discovery per spawn directory and per slug.
- `tests/wtft-137-subagent-meta.test.ts` — the meta reader.

A session path that is a directory, and a real directory named `*.jsonl` in the sibling scan, have
no test of their own.

## 7. Related

These cover discovery and more besides, so they stay live for their other parts. Where one
disagrees with this file about discovery, this file is current.

- `docs/spec-369-skip-unreadable-discovery.md` — a candidate discovery cannot read is a non-match.
- `docs/spec-107-spawn-discovery.md` — one `claude -p` discovery per spawn directory.

## 8. Change records

These describe how discovery got here, and each says so in its header. Where one disagrees with
this file, this file is current.

- `docs/spec-146-147-148-subagent-discovery.md` — meta read errors, first-line reads, no depth cap.
- `docs/spec-479-pi-discovery-enoent.md` — a session transcript not written yet is not a failure.

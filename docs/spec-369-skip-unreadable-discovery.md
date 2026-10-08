# Spec 369 — discovery skips a transcript it cannot read

Issue: https://github.com/princess-pi/wtft/issues/369.
Status: **Spec Approved** (Duppy, 2026-09-28: option C, "keep it minimal and trust the file system";
2026-10-07: "go E").

Module: `extensions/lib/wtft-parser.ts` · Seam: `discoverClaudeSubAgentSessionFiles`, tested in `tests/wtft-369-skip-unreadable-discovery.test.ts`
Also: `extensions/lib/harness/claude-code/discovery.ts` — the unrecorded-spawn scan reads the same project directories, and threw on the same file.

## 1. Problem

`claude -p` discovery reads the head of every `.jsonl` in the project directory it searches, to
learn its first timestamp. One file there it cannot read — any session, in the window or not —
made the whole discovery `unreadable`. `attributeClaudeSubAgentCosts` then threw, so the parent's
fold failed, and the spawn walk marked the whole edge `unreadable`. The Pi sibling scan in
`discoverSubagentSessionFiles` had the same shape: one sibling `.jsonl` it could not read made its
result `unreadable`. The unrecorded-spawn scan (#128) reads the head of every recent transcript
under the projects root, and threw on one it could not read, so the report exited 1.

The one discovery-read warning in this host's daemon log came from a test fixture that vanished
mid-run, not from a real session.

## 2. Behaviour

Discovery folds only files it can read that match its pattern.

- **A file discovery cannot read is a non-match.** In `claude -p` discovery, the Pi sibling scan,
  and the unrecorded-spawn scan, a transcript whose read fails is skipped the same as a file that
  does not match: no warning, no `unreadable`, no throw.
- **What a skipped file costs.** A `claude -p` child or Pi sibling discovery cannot read is not
  folded or listed by that discovery, and discovery does not report it. Nothing retries it: the
  turn's discovery window closes and the tag reads settled. In the unrecorded-spawn scan, an older copy of a session may be listed when its newest
  copy cannot be read.
- **`discoverClaudeSubAgentSessionFiles` returns the files it found** (`string[]`); it has no
  unreadable result left to report.
- **Unchanged:**
  - A directory discovery searches that is absent reads as "none here".
  - A directory it finds but cannot read is still a failure, not a skip.
  - The walk of a session's own `subagents/` directory is unchanged: every file it lists is this
    session's own cost, not another session's transcript.
  - The session transcript's own read failure is still reported as `unreadable` /
    `sessionUnreadable`, when the transcript exists. One not written yet is no failure:
    `docs/spec-479-pi-discovery-enoent.md`.
  - A discovered file that then fails to parse is still reported by the parse.

## 3. Test

`tests/wtft-369-skip-unreadable-discovery.test.ts`, skipped when run as root (root reads a mode-000
file):

- **Claude, the seam:** a project directory holds one readable in-window child and one mode-000
  unrelated transcript. `discoverClaudeSubAgentSessionFiles` returns exactly the child and writes
  nothing to stderr.
- **Claude, the report (the issue's Closer):** the tagger sweeps the parent, and
  `wtft -s <parent> --json` folds the child and exits 0. Neither the tagger's log, its stderr, nor
  the report's stdout or stderr names the unreadable file.
- **Pi siblings:** a session directory holds one readable child sibling and one mode-000 sibling.
  `discoverSubagentSessionFiles` returns the child with `unreadable: null`, and writes nothing to
  stderr.
- **Unrecorded-spawn scan:** `tests/wtft-128-unrecorded-spawns.test.ts` L4/L5b — a mode-000
  transcript, and a symlink to it, are not listed and do not throw; `--json` exits 0, lists
  neither, and names neither path on stdout or stderr.
- **Precondition, each case:** opening the mode-000 file fails.

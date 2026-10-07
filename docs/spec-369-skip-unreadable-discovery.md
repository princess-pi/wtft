# Spec 369 — discovery skips a transcript it cannot read

Issue: https://github.com/princess-pi/wtft/issues/369.
Status: **Spec Approved** (Duppy, 2026-09-28: option C, "keep it minimal and trust the file system";
2026-10-07: "go E").

Module: `extensions/lib/wtft-parser.ts` · Seam: `discoverClaudeSubAgentSessionFiles`, tested in `tests/wtft-369-skip-unreadable-discovery.test.ts`

## 1. Problem

`claude -p` discovery reads the head of every `.jsonl` in the project directory it searches, to
learn its first timestamp. One file there it cannot read — any session, in the window or not —
made the whole discovery `unreadable`. `attributeClaudeSubAgentCosts` then threw, so the parent's
fold failed, and the spawn walk marked the whole edge `unreadable`. The Pi sibling scan in
`discoverSubagentSessionFiles` had the same shape: one sibling `.jsonl` it could not read made its
result `unreadable`.

The one discovery-read warning in this host's daemon log came from a test fixture that vanished
mid-run, not from a real session.

## 2. Behaviour

Discovery folds only files it can read that match its pattern.

- **A file discovery cannot read is a non-match.** In `claude -p` discovery, the Pi sibling scan,
  and the walk of a session's own `subagents/` directory, a file whose head read (or, in the walk,
  whose stat) fails is skipped the same as a file that does not match: no warning, no
  `unreadable`, no throw.
- **`discoverClaudeSubAgentSessionFiles` returns the files it found** (`string[]`); it has no
  unreadable result left to report.
- **Unchanged:**
  - A directory discovery searches that is absent reads as "none here".
  - A directory it finds but cannot list still warns and throws.
  - The session transcript's own read failure is still reported as `unreadable` /
    `sessionUnreadable`.
  - A discovered file that then fails to parse is still reported by the parse.

## 3. Test

`tests/wtft-369-skip-unreadable-discovery.test.ts`, skipped when run as root (root reads a mode-000
file):

- **Claude, the seam:** a project directory holds one readable in-window child and one mode-000
  unrelated transcript. `discoverClaudeSubAgentSessionFiles` returns exactly the child and writes
  nothing to stderr.
- **Claude, the report (the issue's Closer):** `wtft -s <parent> --json` folds the child, exits 0,
  and its stderr does not name the unreadable file.
- **Pi siblings:** a session directory holds one readable child sibling and one mode-000 sibling.
  `discoverSubagentSessionFiles` returns the child with `unreadable: null`, and writes nothing to
  stderr.
- **Own `subagents/` walk:** `subagents/` holds one readable `agent-*.jsonl` and a mode-444
  subdirectory with another. `discoverSubagentSessionFiles` returns the readable one with
  `unreadable: null`, and writes nothing to stderr.
- **Precondition, each case:** opening the mode-000 file fails; stat-ing the file in the mode-444
  directory fails.

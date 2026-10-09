# Spec 479 — a session transcript not written yet is not unreadable at discovery

**Superseded by `docs/spec-wtft-parser.md`**, the live spec for discovery. Read this file as the record of the change, not as current behaviour.

Issue: https://github.com/princess-pi/wtft/issues/479.
Status: **Spec Approved** (Duppy, 2026-10-08: "start 479").

Module: `extensions/lib/wtft-parser.ts` · Seam: `discoverSubagentSessionFiles`, tested in `tests/wtft-479-pi-discovery-enoent.test.ts`

## 1. Problem

At `session_start` pi has not written the session `.jsonl` yet. The Pi widget runs subagent
discovery on that path, the head read of the session transcript fails with `ENOENT`, and discovery
warns that the transcript "could not be read at discovery, so its cost may be missing", reports the
result `unreadable`, and the widget adds its "some transcripts could not be counted — total is
provisional" line. Every `pi -p` run prints the warning. No cost is missing: none exists yet.

The contract is the principle `docs/spec-308-lagging-session.md` states: a session `.jsonl` that
is not written *yet* is not "not found". Discovery applies it here.

## 2. Behaviour

- **A session transcript not written yet is not a read failure.** When the head read of the
  session's own transcript fails with `ENOENT`, `discoverSubagentSessionFiles` writes nothing to
  stderr and returns `unreadable: null` and `sessionUnreadable: null`. With no header there is no
  session id, so no Pi sibling is listed; the session's own `subagents/` walk runs as before.
- **What follows from that.** The Pi widget shows no provisional line for it, and the log parser
  daemon's tagger neither warns nor fails the poll for it.
- **Unchanged:** a session transcript that exists and cannot be read is still warned and
  reported as `unreadable` / `sessionUnreadable` (`docs/spec-369-skip-unreadable-discovery.md`).

## 3. Test

`tests/wtft-479-pi-discovery-enoent.test.ts`:

- **The seam:** `discoverSubagentSessionFiles` on a session path that does not exist returns no
  files, `unreadable: null` and `sessionUnreadable: null`, and writes nothing to stderr.
  Precondition: the path does not exist. With the session's own `subagents/` present, its
  transcript is still listed.
- **The tagger:** `stepTagger` on a session whose transcript does not exist logs no warning and
  does not fail the poll.
- **The widget (the issue's Closer, in process):** the built `pi/wtft.js`, its daemon a stand-in,
  renders a session whose transcript does not exist; stderr holds no line matching
  `could not be read at discovery`, and the widget no provisional line.
- **Control, the inverse case:** a session transcript that exists at mode 000 is still warned, and
  reported as `sessionUnreadable`. Skipped as root, which reads a mode-000 file.

The Closer on a real pi: `pi --model google/gemini-2.5-flash-lite --no-extensions -e
<worktree>/pi/wtft.js -p "reply with exactly: ok"` prints 0 lines matching
`could not be read at discovery`.

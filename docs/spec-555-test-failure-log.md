# Spec 555 — a host-wide log of local test runs

Every `bun run test` appends one line to a log outside every checkout. `bun run test-failures` counts
from it how often each suite failed per day. The log outlives the worktree that ran the tests, so a
flake's daily rate can be counted after `pr-cleanup` has deleted its branch's worktree. This is a
repo tool. It is not shipped or installed.

## 1. The log

`$XDG_STATE_HOME/wtft-tests/failures.jsonl`, with `$XDG_STATE_HOME` defaulting to `~/.local/state`.
`tests/run.ts` reads the variable before it gives each suite its own, so the log is the developer's.

One JSON object per run, written once every suite has finished, failing or not, so a day's run count
can stand beside its failure count:

```json
{"utc":"2026-10-19T19:12:10.000Z","branch":"555-keep-a-host-wide-log","checkout":"/abs/path","suites":183,
 "failures":[{"suite":"wtft-259-daemon-correctness","timedOut":true,"line":"…"}]}
```

- `suites`: how many suites the run ran. A filtered run counts too.
- `line`: the suite's first failing check, with colour codes removed: the first line that holds
  `❌`, or opens with `FAIL` or `(fail)`. With no such line, the suite's last non-empty line. Cut to
  300 characters.

A run never fails because the log could not be written. The runner says so on stderr.

## 2. The count

```
bun run test-failures [--days <n>] [--json]
```

- `--days`: the last n UTC days, today included. Default 7.
- Prints one block per day with a run: the date (UTC), the run count, then each failing suite with
  its failure count, most first.
- `--json`: `{"schema":"wtft-test-failures@1","log":<path>,"days":[{"day":"YYYY-MM-DD","runs":n,
  "failures":{"<suite>":n}}],"unreadableLines":n}`. `days` is newest first and holds only days
  with a run. With no log yet, `days` is empty.

Exit codes:
- **0:** the count was printed.
- **2:** a bad call: an unknown flag, or `--days` that is not a whole number above 0.

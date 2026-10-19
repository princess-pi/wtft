# Spec 555 — a host-wide log of local test runs

Every `bun run test` that runs its suites appends one line to a log outside every checkout. `bun run
test-failures` counts from it the runs per UTC day and how often each suite failed. The log outlives the worktree that ran the tests, so a
flake's daily rate can be counted after `pr-cleanup` has deleted its branch's worktree. This is a
repo tool. It is not shipped or installed.

## 1. The log

`$XDG_STATE_HOME/wtft-tests/failures.jsonl`, with `$XDG_STATE_HOME` defaulting to `~/.local/state`.
The `XDG_STATE_HOME` each suite is given does not move it.

One JSON object per run, written once every suite has finished, failing or not, so a day's run count
can stand beside its failure count:

```json
{"utc":"2026-10-19T19:12:10.000Z","branch":"555-keep-a-host-wide-log","checkout":"/abs/path","suites":183,
 "failures":[{"suite":"wtft-259-daemon-correctness","timedOut":true,"line":"…"}]}
```

- `branch`: empty when git cannot name it.
- `suites`: how many suites the run ran. A filtered run counts too.
- `line`: the suite's first failing check, with colour codes removed: the first line that opens,
  past its indent, with `❌`, the word `FAIL` or `(fail)`. With no such line, the suite's last non-empty line. Cut to
  300 characters.

A run never fails because the log could not be written. The runner says so on stderr.

## 2. The count

```
bun run test-failures [--days <n>] [--json]
```

- `--days`: records from the UTC day n − 1 days before today onward. Default 7.
- Prints one block per day with a run: the date (UTC), the run count, then each failing suite with
  its failure count, most first.
- `--json`: `{"schema":"wtft-test-failures@1","log":<path>,"days":[{"day":"YYYY-MM-DD","runs":n,
  "failures":{"<suite>":n}}],"unreadableLines":n}`. `days` is newest first and holds only days
  with a run. `unreadableLines` counts the whole log; a line whose `utc` does not parse as a date is one. A run's day is its `utc` in UTC. With no log yet, `days` is empty.

Exit codes:
- **0:** the count was printed.
- **2:** a bad call: an unknown argument, or `--days` that is not a whole number from 1 to 9999.
- **Any other code:** the log exists but could not be read. The OS's message says why.

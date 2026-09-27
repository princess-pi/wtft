# Spec 279: suites that check a tagging decision run it in process

Before this spec, a suite that checked how a session is tagged started the real log parser daemon,
waited on the tag file with `sleep`, and killed the daemon afterwards. Those suites are slow, and
they are the ones that fail only under full-suite load. The daemon's tagging is
`stepTagger` (`extensions/lib/session-tagger.ts`, spec-270-session-tagger), so a suite can call it
directly.

## 1. The counting method

`debug/count-daemon-spawners.sh [jobs]` runs every `tests/*.test.ts` and `tests/*.test.sh` under
`strace -f -e trace=execve`. A suite counts when any process it starts, at any depth, execs an argv
that names `bin/wtft-daemon`, bare or with `.mjs`, `.ts` or `.js`. It prints one suite per line,
then `spawners: <n> of <total>`.

- **Why runtime, not a grep:** a grep of the source counts a suite that names the daemon's path
  and misses one that reaches it through the `wtft` CLI, which starts a daemon on every report
  (`runReport` in `extensions/lib/cli/report.ts`).
- **Stand-ins do not count:** `tests/lib/stand-in-daemon.ts`, and the stand-ins 179 and 281 write,
  live outside any `bin/` directory. The CLI harness's stand-in has to sit in a `bin/` (§ 4), so a
  path under a `wtft-cli-harness-` dir is skipped.
- **Each suite gets its own config, state and tmp roots,** as `tests/run.ts` gives it.
- **The runner's solo suites run alone here too,** after the pool. The list is read from `SOLO` in
  `tests/run.ts`.
- **Each suite runs as `tests/run.ts` runs it,** with `bun test`.
- **A suite is stopped when it returns.** strace follows every daemon a suite leaves running, so it
  is sent SIGTERM then, which `-I 1` lets through: it detaches, flushes the trace and exits, and
  those daemons run on as they would untraced. A suite still running after 300 s is unfinished, and it is killed with its process group.
- **Only an exec that succeeded counts.** An exec of a `bin/wtft-daemon` path that returned -1 (a
  PATH search) started nothing.
- **No count rather than a low one:** when a suite is unfinished, or its trace does not show the
  suite itself starting, the script names it on stderr and exits 3 without a count.
- **A failed suite that started no daemon is named:** it may have failed before reaching one. The
  count is printed, the suites are named on stderr, and the exit is 4. The #214 suites fail on
  this host, so read that list before trusting the count. Exit 2 is a setup failure.

## 2. The harness

`tests/lib/tagger-harness.ts` exports `tagSession(sessionPath)`. It returns one session's tagger on
a clock the test advances:

- `poll()`: one `stepTagger` call with `flush: true`, its records appended to the tag, then the
  clock moves on by the daemon's poll interval (667 ms).
- `until(done, max = 12)`: polls until `done()` holds.
- `log`: every poll's log lines, which the daemon prints under `WTFT_DAEMON_DEBUG`.

A suite that waited for the daemon with `sleep` now waits with `until`, and a fixed wait of *n* ms
becomes ⌈*n* / 667⌉ polls.

## 3. Slice 1: the tagging suites

**Moved to the tagger harness:** the five `wtft-270-subagent-*` suites, 97, 107 (part D), 114
(parts D and N), 115 (the daemon section), 220, 241 (the daemon section), 443 swept marker, cost
cross-validation, and tree navigation. 114's restart case (D5) moved into the tag-file staleness
suite, which already restarts a daemon. After slice 1, 43 of 123 suites counted.

## 4. Slice 2: the CLI suites

Every `wtft` report starts a daemon (`runReport` in `extensions/lib/cli/report.ts`), so every
suite that ran the CLI counted, although it checks rendering, `--json` and exit codes, not
tagging. The CLI finds its daemon beside itself (`daemonDir` in `bin/wtft.ts`), and the Pi widget
finds it in `../bin` (`extensions/wtft.ts`). `tests/lib/cli-harness.ts` uses that, with no change
to product code:

- `cliWithoutDaemon()` and `widgetWithoutDaemon()` return copies of `bin/wtft.mjs` and
  `pi/wtft.js` in a `wtft-cli-harness-*` temp dir, whose `bin/wtft-daemon.mjs` is a stand-in.
- `tagForCli(session)` tags the session in process until the tag holds data and reads swept, and
  throws if it does not.
- The stand-in exits at once. `WTFT_STAND_IN=alive` keeps it up for 3 s and writing nothing, which
  the CLI reads as "no data yet" on a session with nothing tagged. `WTFT_STAND_IN=heartbeat` also
  heartbeats into the session's tag, which is what the CLI waits for on a session whose log is not
  written yet.
- The counter skips a daemon path under a `wtft-cli-harness-` dir (§ 1).

**Moved:** config persistence, 26 json, 35, 90, 119, 133, 138, 153 pager, 176, 443 CLI exit 9,
513, auto-fit, CLI e2e cost parity, phase 3 overhead, title layout.

**Stays on the real daemon, and why.** After slice 2, 28 of 123 suites count:
- **A restart or a start-up read, 4:** tag-file staleness, 130 line-safe writes, 457, 512 fatal
  replay. What a new daemon does with a tag an earlier one wrote is `initClassified` in
  `bin/wtft-daemon.ts`, which is not in the tagger.
- **The process itself, 16:** daemon lifecycle, the shell suite, golden tags, pack-and-smoke, 46
  install, 96, 155, 205, 239, 240, 248, 259, 262, 281, 297 daemon holders, 308.
- **`--watch`, 2:** watch smoke and watch-vs-non-watch parity, the end-to-end smoke of the live
  view.
- **Not moved yet, 6:** 116, 128, 137 subagent block, 137 subagent meta, 146-149, 178. Each also
  starts the daemon directly or depends on what it writes over time.

## 5. Verification

- Each moved suite passes and asserts the same outcomes as before, with "the daemon" now "the
  tagger" in its labels. One thing is no longer asserted by them: that a debug line reaches stderr
  under `WTFT_DAEMON_DEBUG`. 97 and the truncate diagnostic now read the tagger's log lines, and the
  printing is `printLog` in `bin/wtft-daemon.ts`.
- The truncate diagnostic was checked by mutation: renaming the rotation log line fails it.
- The count, before and after each slice, is in its PR body.

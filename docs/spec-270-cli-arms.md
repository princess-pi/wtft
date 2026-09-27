# Spec 270 S6 — the CLI arms

Slice S6 of the daemon ownership refactor (`docs/spec-270-daemon-ownership.md` §3a CLI arms row, §3b S6 row). `bin/wtft.ts`
`main` becomes a dispatcher; what it did after argument parsing moves, unchanged, into
`extensions/lib/cli/`.

## 1. The shape

| Arm | File | What it does |
|---|---|---|
| `runDaemonCommand(opts, daemonDir)` | `daemon-command.ts` | `--list`, `--cleanup`, `--restart`, `--stop`: passthrough to `wtft-daemon` |
| `selectSession(opts) → path` | `session.ts` | `-s` (a file, a pending path, or a substring), else the picker; exit 10 with no terminal, exit 1 on no match |
| `runForceRebuild(path, daemonDir)` | `force-rebuild.ts` | `-F`, including the wait for a harness to adopt a `rebuild` lease; exits 1 when nothing was rebuilt |
| `runWatch(opts, path, daemonDir, unit)` | `watch.ts` | `--watch` |
| `runReport(opts, path, daemonDir, unit)` | `report.ts` | the one-shot report: chart, `--tokens`, `--json`, the pending and no-data arms, and exit 9 |

`exit-codes.ts` holds `EXIT_PROVISIONAL` (9) and `EXIT_SESSION_AMBIGUOUS` (10); `bin/wtft.ts`
re-exports both, so importers of the bundle are unchanged.

`main` keeps what is not an arm: pricing and harness registration, `--help`/`--why`/`--version`,
and the `-p` refusal. It is 38 lines.

## 2. Behaviour

None changes. The code moved byte for byte; a function's parameters replace the module-level
`opts`, `daemonDir` and `unit` it read before.

## 3. Closer

- `tests/wtft-270-cli-arms.test.ts`: `main` is under 80 lines, and each arm's file exports it and
  `main` calls it.
- The existing CLI suites pass unchanged. Two source-scanning suites widen their file list to
  `extensions/lib/cli/`, since the code they scan moved there: `wtft-26-json` (every exit code the
  CLI can return is documented) and `wtft-179-daemon-health-reason` V1 (no reason sentence is
  compared as a token).

## 4. Decisions

- **Five arms, not four.** The §3a row named four; session selection is a fifth, since it is
  about 90 lines of `main` that every non-daemon arm needs first. *Road not taken:* folding it
  into `runReport` and `runWatch`, which would have copied it.
- **A move, not a rewrite.** `runReport` is still about 340 lines. Splitting it is a behaviour
  risk this slice does not take; `runReport` takes the CLI `main`'s place in the refactor's closer
  (`docs/spec-270-daemon-ownership.md` §3d), so that closer stays unmet until it is split.

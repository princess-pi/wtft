# spec-439-443 — whom `--restart` reaches, and how long `wtft --restart` waits for it

Issues: https://github.com/princess-pi/wtft/issues/439, https://github.com/princess-pi/wtft/issues/443 ·
Module: `bin/wtft-daemon.ts` (the `--restart` pass) · Also: `bin/install-wtft`, `extensions/lib/cli/daemon-command.ts` ·
Tests: `tests/wtft-274-restart.test.ts` (P1–P3), `tests/wtft-46-install-wtft.test.ts` (V11h), `tests/wtft-443-cli-restart-wait.test.ts`

## Behaviour

- **P1. `--pid <pid>` scopes `--restart`.** It may be given more than once. With any `--pid`,
  `--restart` handles only the holders, found through a lease or a harness root pid file, whose
  pid is named. Every other holder is handled as if `--restart` were not given: listed under
  `--list`, cleaned under `--cleanup`, and otherwise left as it was, lease and root pid file
  included. Without `--pid`, `--restart` reaches every holder, as before.
- **P2. A named pid that holds no lease and no root pid file here** prints
  `Not found: PID n — holds no lease or root pid file here` and makes the command exit 1.
- **P3. `--pid` without `--restart`, or a value that is not a whole number above 0,** is a usage
  error: exit 2.
- **`install-wtft` passes one `--pid` per process it counted on an older build.** A daemon it did
  not count keeps its pid and its lease, whatever `TMPDIR` the install runs under.
- **`wtft --restart` waits for `wtft-daemon --restart` with no time limit.** That run is bounded by
  its own steps: per holder SIGTERM, up to 2 s, SIGKILL, up to 2 s, then one
  `WTFT_RESPAWN_SETTLE_MS` wait for all respawns. `--list`, `--cleanup` and `--stop` keep the
  10 s limit.

## Roads not taken

- **A larger fixed limit for `--restart`:** any fixed number is passed by enough holders that
  ignore SIGTERM.
- **`install-wtft` stopping the counted pids itself:** it would need its own copy of the respawn.

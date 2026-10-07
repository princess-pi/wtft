# spec-159-pack-and-smoke

**Status:** Active · **Issue:** princess-pi/wtft#51 (decision 3 — the orphaned guard) · **Test:** `tests/pack-and-smoke.test.ts`

## What it proves

The tarball install channel ships a **self-contained artifact**: `npm
pack` the repo, install the tarball into a fresh dir with plain node/npm (bun
excluded from PATH), then run real commands. Green here means the tarball
carries exactly the four-entry `files` allowlist — the CLI bundles
`bin/wtft.mjs` and `bin/wtft-daemon.mjs`, and the Pi-extension bundles
`pi/wtft.js` and `pi/token-budget.js` (#60) — and that the two CLI bundles run
on stock node outside the repo with no bun.

That is a narrower claim than "every install channel is green". The git-URL
channel runs `prepare` and therefore needs bun on PATH; bun-on-PATH is permitted
for git-URL installs only, never for the registry channel (Node Toolchain
Standard).

The Pi extension SOURCES (`extensions/wtft.ts`, `extensions/token-budget.ts`)
are not in the tarball; their BUILT bundles `pi/wtft.js` and
`pi/token-budget.js` are, since #60, and the exact-allowlist check asserts it.
This suite does not load the Pi bundles into Pi; it proves they ship. Running the extensions
from a source checkout needs `bun install` (dev) to make `@princess-pi/libs`
and `wcwidth` — both devDependencies — resolvable; the bundles vendor both at
build time (#36), so a consumer needs neither. The extensions' import
resolution under a dev install is exercised by
`tests/config-persistence.test.ts`, which imports both extensions and drives
their writes.

## What it caught on arrival

The first run of the suite was red, and the reason was a real packaging defect,
not a test bug: `@princess-pi/libs` and `wcwidth` sat in `dependencies`. The
bundles vendor both (#36), so a consumer needs neither at runtime — but npm
installs `dependencies`, which re-ran `@princess-pi/libs`'s `prepare` (bun) on a
bun-free PATH and failed with exit 127. The fix moved both to
`devDependencies`, matching "bun is internal only — never a consumer
requirement". This is the same class of gap the sister suite caught in
princess-pi-tools (`docs/manifests/` missing from the `files` allowlist).

## Shape of the guard

- **Pre-flight** — refuses to run if a tracked file `prepare` can rewrite
  (`extensions/lib/harness/builtins.generated.ts`, and `bun.lock` when it runs
  `bun install`) has uncommitted changes. The gitignored bundles it rebuilds are not
  guarded.
- **Pack** — `npm pack`, with bun on PATH for `prepare`; then assert those tracked
  files are unchanged.
- **Allowlist** — the tarball holds exactly `package.json`'s `files` entries plus
  npm's mandatory `package.json`/`LICENSE`/`README.md`, each of those present, and
  every `bin` target is among them.
- **Install** — plain node/npm with bun absent from PATH. node is the first
  `node` on the suite's own PATH whose real path is named `node`, and `npm` must
  sit beside it. No login shell, so no
  profile is read.
- **Environment** — install and run see only `PATH` (a directory holding `node`
  and `npm` links, then `/usr/bin:/bin`), the real `HOME`, the suite's private
  `TMPDIR`, and one fresh `XDG_STATE_HOME` for the whole suite, so the installed
  daemon's log, reap log, spawn ledger and daemon roster stay off the host. Each
  installed run also gets its own fresh `XDG_CONFIG_HOME`, `COLUMNS=250`, and the
  consumer directory, outside the checkout, as its cwd. Every one but the
  precondition run below also gets `PRINCESS_PI_CONFIG_NO_WALKUP=1`. A check plants
  a `.wtft/config.json` above the consumer: with walk-up on it changes the render
  (the precondition), and with walk-up off the render is still cumulative with
  `$4.50`.
- **Run** — `wtft --version`'s first line is `wtft <package.json version>`, `wtft-daemon
  --help` exits 0, and a synthesized session rendered through
  `wtft -s <fixture> --cost --no-emoji --pad 0` shows the deterministic `$4.50`
  with no `❌` line on stdout or stderr (parse → interaction → rendered cost,
  not just argument handling).

## Disposition of the third decision-3 guard

Issue #51 decision 3 named three guards. Two land here and in
`tests/config-persistence.test.ts`. The third is actually two distinct
spec-reconcile backtest drift gates, disposed of differently by their kind:

- `buildTimelineString` — positional: its docstring had drifted four
  declarations above the function (misbinding to `MOON_PHASES`). Closed, per
  Duppy's "too specific" ruling — where a docstring sits is code
  organization, not a behavior contract.
- `parseInterval` — content-misattribution: its docstring had come to
  describe the `.jsonl` parser instead of interval parsing. That is a
  content-truth concern, not mere organization. It is still closed, for a
  different stated reason: parseInterval's accepted units are already pinned
  *behaviorally* by `tests/wtft-spec-alignment.test.ts`, which probes the real
  function (every single-char unit, every turn spelling) and asserts each
  accepted unit is mentioned in the manifest — a one-way check, not a claim
  that the manifest lists nothing extra. A source-text gate over the
  docstring's prose would still be redundant with that behavioral pin and
  brittle to any legitimate reword.

The drift both gates caught was fixed in `wtft-renderer.ts` before the move.
The ruling is recorded on the #51 thread, not reconstructed here.

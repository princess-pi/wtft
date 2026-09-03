# spec-159-pack-and-smoke

**Status:** Active · **Issue:** princess-pi/wtft#51 (decision 3 — the orphaned guard) · **Test:** `tests/pack-and-smoke.test.ts`

## What it proves

The registry/tarball install channel ships a **self-contained artifact**: `npm
pack` the repo, install the tarball into a fresh dir with plain node/npm (bun
excluded from PATH), then run real commands. Green here means the two bundles
`bin/wtft.mjs` and `bin/wtft-daemon.mjs` — the whole `files` allowlist — run on
stock node with no repo and no bun.

That is a narrower claim than "every install channel is green". The git-URL
channel runs `prepare` and therefore needs bun on PATH; bun-on-PATH is permitted
for git-URL installs only, never for the registry channel (Node Toolchain
Standard).

The Pi extensions (`extensions/wtft.ts`, `extensions/token-budget.ts`) are NOT
in the tarball and are NOT delivered by any npm channel (neither the registry
tarball nor an npm git-URL install — the `files` allowlist ships only the two
bundles, and npm git installs do not retain a dependency's devDependencies).
They load from a SOURCE CHECKOUT of this repo, where `bun install` (dev) makes
`@princess-pi/libs` and `wcwidth` — both devDependencies — resolvable; the
dev install is the only place those are needed, because the bundles vendor
them at build time (#36). The extensions' import resolution under a dev
install is exercised by `tests/config-persistence.test.ts`, which imports both
extensions and drives their writes.

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

- **Pre-flight** — refuses to run if `bin/` has uncommitted changes, because
  `npm pack` fires `prepare`, which rebuilds that path and would clobber WIP.
- **Pack** — `npm pack`, then restore `bin/` and assert it is clean again.
- **Allowlist** — the tarball carries the `bin/*.mjs` bundles plus npm's
  mandatory `package.json`/`LICENSE`/`README`, and nothing else.
- **Install** — plain node/npm with bun absent from PATH (the real node binary
  is resolved and verified not to be bun, since this suite itself runs under
  bun and `process.execPath` would lie).
- **Run** — `wtft --version`, `wtft-daemon --help`, and a synthesized
  Claude-Code-shaped session rendered through `wtft -s <fixture> --cost`
  (parse → interaction → rendered cost, not just argument handling).

## Disposition of the third decision-3 guard

Issue #51 decision 3 named three guards. Two land here and in
`tests/config-persistence.test.ts`. The third — spec-reconcile backtest
drift gates pinned to `parseInterval`'s and `buildTimelineString`'s
docstrings — is closed without a gate: Duppy ruled those docstring
placements "too specific" to pin a backtest against. Recorded here so the
#51 closer's "all three guards land or are disposed of" condition is met
explicitly, rather than left implicit.

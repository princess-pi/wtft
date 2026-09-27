# wtft

Where The F'ing Tokens: live token-spend tracker for Claude Code and Pi sessions, as a CLI, a log
parser daemon, and Pi widgets. Public, `@princess-pi/wtft`, not on npm yet (#29).

## Hard gates

- **Never edit build output.** `bin/*.mjs` and `pi/*.js` are gitignored bundles, and
  `extensions/lib/harness/builtins.generated.ts` is a tracked one. Edit the `.ts`, run
  `bun run build`, then `bin/install-wtft` — otherwise `~/bin` keeps running the old build.
- **Bundles import only `node:` builtins.** bun builds them; stock node runs them. The relocatable-build
  test fails on any other import.
- **The README is tested.** `tests/wtft-75-doc-claims.test.ts` checks README flags against the
  parser and the manifest, and `install-wtft` exit codes against the script, so a README edit can
  fail the suite. It pins `CONTEXT.md`, `docs/adding-a-harness.md` and this file's seam list too,
  so an edit there can fail it as well.
- **Shared code goes in `@princess-pi/libs`**, never copied in.
- **Spec-reconcile does not treat comments as spec.** Reconcile: manifests,
  `--help`, README flags/exit codes, JSON schema, tag-format, `CONTEXT.md`,
  module specs (`docs/spec-<module>.md`),
  `docs/wtft-incremental-render-spec.md`, user-facing strings.
  Not banner comments, not test-header novels, not glossary provenance, not counts
  in prose. A stale comment is deleted, never reworded.

## One module, one seam per feature

- **A feature lands in one module, behind one interface, with one in-memory test seam.** The
  seams that exist: `decideHealth` (`extensions/lib/daemon-health.ts`), `stepTagger`
  (`extensions/lib/session-tagger.ts`), the registry functions
  (`extensions/lib/harness-registry.ts`), and `classifyPid` over a fake process table
  (`extensions/lib/holder.ts`, `tests/lib/fake-process-table.ts`), and `rotateDaemonLog`
  (`extensions/lib/daemon-log.ts`).
- **Every feature PR body carries one line:** `Module: <file> · Seam: <function>, tested in <suite>`.
  A PR that touches a second module adds `Also: <file> — <why>` for each one.
- *Why:* before the daemon ownership refactor (spec-270), one daemon feature touched state spread across `bin/wtft-daemon.ts` and
  several readers. That spread is where the fix-spawns-fix chains came from.

## Commands

| Purpose | Command |
|---|---|
| Install deps | `bun install` |
| Build | `bun run build` |
| Test | `bun run test` — each suite in its own process, 2 × CPUs at a time (`WTFT_TEST_JOBS=1` for serial); skips shell suites |
| Shell suite | `bash tests/wtft-daemon.test.sh` |
| Typecheck | `bun run typecheck` |
| Pricing manifest | `bun run manifest` |
| Install on this host | `bin/install-wtft` · `--check` for drift (exit codes in README) |
| PR cost record | `bun run pr-cost --write-pr` in the branch's worktree, just before `pr-offer-merge` (`docs/spec-277-pr-cost.md`) |
| After every merge | `pr-cleanup <branch>` → `git pull --ff-only` → `bin/install-wtft`, from the main clone. Run the full install, not `--check`: it compares `~/bin` to the clone's built bundles, so after a merge both are stale together and it reports in sync while `~/bin` runs old code (#85). The install stops any daemon on an older build (restarting per-session ones; a harness returns on the next wtft) and says so |

## Shape

- `bin/wtft.ts` — the CLI's entry; its arms are in `extensions/lib/cli/`. `bin/wtft-daemon.ts` — the log parser daemon.
- `extensions/wtft.ts`, `extensions/token-budget.ts` — Pi widgets, built to `pi/`.
- `docs/manifests/wtft-cmd.json` — single source for `--help` / `--why` and EXT_WTFT.html's flags, exit codes and why section.
- `docs/manifests/wtft-status.json` — EXT_WTFT.html's daemon status list, pinned to `renderDaemonStatus`.
- `docs/adding-a-harness.md` — how a new harness's session logs get read.

## Read first

- `CONTEXT.md` — vocabulary, including the two-register rule: "log parser daemon" to explain,
  "daemon" to refer.
- `docs/spec-<module>.md` with a `Module:` line — the live spec for that file in `extensions/lib/`;
  a behaviour change there edits it. `ls docs/spec-[a-z]*.md` lists them. A module without one is
  still described by its per-issue specs.
- `docs/spec-<issue>-*.md` — the spec behind each numbered change. One whose header says
  "Superseded by" is a change record, not current behaviour.

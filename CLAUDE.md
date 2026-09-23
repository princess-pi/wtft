# wtft

Where The F'ing Tokens: live token-spend tracker for Claude Code and Pi sessions, as a CLI, a log
parser daemon, and Pi widgets. Public, `@princess-pi/wtft`, not on npm yet (#29). Origin: btw#63.

## Hard gates

- **Never edit build output.** `bin/*.mjs` and `pi/*.js` are gitignored bundles, and
  `extensions/lib/harness/builtins.generated.ts` is a tracked one. Edit the `.ts`, run
  `bun run build`, then `bin/install-wtft` — otherwise `~/bin` keeps running the old build.
- **Bundles import only `node:` builtins.** bun builds them; stock node runs them. The relocatable-build
  test fails on any other import.
- **The README is tested.** `tests/wtft-75-doc-claims.test.ts` checks README flags against the
  parser and the manifest, and `install-wtft` exit codes against the script, so a README edit can
  fail the suite. It pins `CONTEXT.md` and `docs/adding-a-harness.md` too, so an edit there can
  fail it as well.
- **Shared code goes in `@princess-pi/libs`**, never copied in.
- **Spec-reconcile does not treat comments as spec** (#183). Reconcile: manifests,
  `--help`, README flags/exit codes, JSON schema, tag-format, `CONTEXT.md`,
  `docs/wtft-incremental-render-spec.md`, user-facing strings.
  Not banner comments, not test-header novels, not glossary provenance, not counts
  in prose. A stale comment is deleted, never reworded.

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
| After every merge | `pr-cleanup <branch>` → `git pull --ff-only` → `bin/install-wtft`, from the main clone. Run the full install, not `--check`: it compares `~/bin` to the clone's built bundles, so after a merge both are stale together and it reports in sync while `~/bin` runs old code (#85) |

## Shape

- `bin/wtft.ts` — the CLI. `bin/wtft-daemon.ts` — the log parser daemon.
- `extensions/wtft.ts`, `extensions/token-budget.ts` — Pi widgets, built to `pi/`.
- `docs/manifests/wtft-cmd.json` — single source for `--help` / `--why`.
- `docs/adding-a-harness.md` — how a new harness's session logs get read.

## Read first

- `CONTEXT.md` — vocabulary, including the two-register rule: "log parser daemon" to explain,
  "daemon" to refer.
- `docs/spec-<issue>-*.md` — the spec behind each numbered change.

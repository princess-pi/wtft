# spec-89 — the scoped session picker, plus #119's `total.untaggedCostUsd`

**Issues:** [#89](https://github.com/princess-pi/wtft/issues/89) (session picker
redesign) and [#119](https://github.com/princess-pi/wtft/issues/119) (the untagged
cost field), landing together inside one schema bump: `wtft/session@3` → `@4`.

**Decision basis:** #89's "Decision — scoped picker (Duppy, 2026-09-18)" issue-body
block, which replaces every earlier direction in that issue. #119's "Decision: B"
comment block, answer Y (any new key — nested included — bumps `schema`).

## Interpretation notes (not ambiguities — reasoned choices, recorded so a future
reader does not re-litigate them)

- **Library default vs. CLI default.** The decision's "every launch starts at
  20 min" and "default scope: the current worktree" describe what `wtft` (the CLI)
  does when a human runs it, not a mandate that `discoverSessions()`'s own
  parameter defaults change for every caller. `discoverSessions()` keeps its
  pre-#89 default behaviour (fan-out across worktrees, the #156 union arm,
  unbounded time) when called with no scope options — this is what
  `tests/wtft-issue-144-145-164-session-discovery.test.ts` and
  `tests/wtft-issue-156-harness-seam.test.ts` already exercise, and neither
  needed to change. `bin/wtft.ts` is the one caller that opts into the new
  policy explicitly, passing `{ scope: "worktree", windowMs: TIME_WINDOW_MS["20m"] }`
  as the picker's starting state.
- **`Ctrl+B` (current branch), mechanism.** The decision names the key and its
  intent ("current git branch") but not its mechanics against a folder-only
  scope. Implemented as: resolve the cwd's current branch
  (`git rev-parse --abbrev-ref HEAD`, bounded timeout, same pattern as
  `worktrees.ts`), then from the repo's fanned-out checkouts pick the one
  `git worktree list --porcelain` reports checked out to that branch, and apply
  `"worktree"`-style folder matching to it alone. If git is unusable or the
  branch can't be resolved, it is a documented no-op, LABEL INCLUDED —
  `resolveBranchCheckout` returns null, and both the candidate population
  (discovery folder-matches the bare target directory, the same set
  `"worktree"` scope would return) AND the picker's displayed "scope:" label
  fall back to `"worktree"`, never leaving them disagreeing. `applyKey` itself
  is pure and has no git awareness, so it always sets `state.scope` to
  `"branch"` on the key press; `selectSessionPrompt`'s rescope handler in
  `session-selector.ts` — the one place with both git access and the state —
  is what corrects `state.scope` back to `"worktree"` before ever rendering
  or re-discovering, so nothing downstream ever sees the two disagree (fixed
  in pr-review round 2, after round 1 shipped the label/population split this
  paragraph used to describe as intentional).
- **How the union (last-cwd) arm and the time window compose.** The decision
  specifies the time window as a first-class, always-on primitive but does not
  restate the mechanics of the #156/#164 union arm under the new scopes. The
  2026-09-18 measurement comment's superseded proposal ("the wandered-in arm
  runs only inside the time window") is carried forward as the mechanism:
  `"worktree"` scope runs folder matching only, no union arm, ever — this is
  what makes the default ~7 ms. `"worktrees"` scope ALSO runs the union arm
  (correction, pr-review round 2: an earlier draft of this note said `"all"`
  did too — it does not, and cannot need to: `"all"` skips folder matching
  entirely, so there is no non-matching population left for a union arm to
  search, and `discoverScoped` returns before reaching one on that path;
  S3/S6, `session-cwd.ts`'s own header and `docs/EXT_WTFT.html` all already
  said "worktrees" only, and this note is what's being brought into line with
  them), bounded to transcripts whose mtime falls inside the active time
  window — so the arm's cost is bounded by the window the human is already
  looking through, and reverts to today's full cost only when a human cycles
  `Ctrl+T` all the way to "all" (an explicit, deliberate choice, per the
  decision's "a window with no sessions says so … rather than widening on its
  own").
- **Unseen-harness ordering, plural — and it is two tiers, not one.** "An
  unseen harness goes last" pins single membership; when *two or more*
  harnesses are unseen in the sticky order (a fresh install, or config
  wiped), the ones the caller's registered-harness list names are emitted in
  that list's order (`getHarnesses()`'s stable id order), for determinism
  independent of file-system iteration order. A harness present in the
  discovered candidates but absent from BOTH the sticky order AND the
  registered-harness list — a caller that forgot to pass one, or a genuinely
  unregistered id — falls to a second, lower tier: `Map` insertion order,
  which IS candidate-discovery order. `orderByHarness`'s own docstring in
  `extensions/lib/harness-order.ts` names this as the one tier the function
  cannot make deterministic; it exists so an unexpected harness id is never
  silently dropped, only ordered less predictably.

## Behaviour list — named, testable checks

### Discovery scope (`extensions/lib/harness/types.ts`, `session-cwd.ts`,
`claude-code/discovery.ts`, `pi/discovery.ts`, `session-selector.ts`)

- **S1 — default scope is folder-name-only, single directory.** `discover(cwd,
  { scope: "worktree" })` returns only sessions whose project-dir slug (any
  known encoding, #144) matches `cwd` exactly. No fan-out, no union arm. Zero
  tail reads, zero `getCwdBytesRead()` movement.
- **S2 — `Ctrl+W`/`"worktrees"` scope fans out.** Folder match against every
  checkout `fanOutCwd(cwd)` returns, **plus** the union arm (a session whose
  last recorded cwd resolves to one of those checkouts), bounded by the active
  time window.
- **S3 — `Ctrl+A`/`Tab`/`"all"` scope ignores cwd.** Every session for the
  harness, bounded only by the active time window. `Tab` and `Ctrl+A` produce
  the identical scope value.
- **S4 — `Ctrl+B`/`"branch"` scope.** As described in Interpretation notes
  above: the single checkout matching the cwd's current branch, folder-matched
  only (no union arm) — a no-op when git or the branch can't be resolved.
- **S5 — time window always applies, cycles on `Ctrl+T`.** Every scope is
  additionally bounded by `windowMs`; the CLI's initial state is always `20m`
  (`T1`), regardless of which scope key was used to get there. `Ctrl+T` cycles
  `20m → 1h → 1d → 1w → all → 20m`. **One exception:** a picker opened because
  `-s` matched several sessions starts at scope `all`, window `all`, because its
  rows are every match with no scope or time bound, and the header must describe
  them. Its first `Ctrl+T` moves to `20m`, like any other `all`.
- **S6 — an empty window says so, never widens itself.** Zero rows after a
  (re)discovery is a distinct render state (a message naming `Ctrl+T`), not an
  automatic scope or window change.
- **S7 — Pi worktree/branch derivation.** Corrected from the first draft
  (pr-review, Low): nothing reads a Pi transcript's header `cwd` for this.
  Pi's worktree/branch label is derived from its DIRECTORY SLUG, by the same
  shared, harness-agnostic `buildDisplayPath`/`compactWorktreeProject`
  (`@princess-pi/libs/session-path-shortener`) that already renders Claude
  Code's `<repo>/w/<branch>` rows (S1's own display path is the same
  function) — no new code was needed for #89, since the marker it looks for
  (`--claude-worktrees-`) survives Pi's `--`-wrapping unchanged. A Pi session
  recorded from a main clone (no such marker in its slug) shows no branch —
  never a guessed one.

### Sticky harness order (`extensions/lib/harness-order.ts`, new)

- **H1 — read via `mainCloneDir`, the same resolution the write uses.**
  Corrected (pr-review round 3, Medium): the shipped code resolves the main
  clone through `mainCloneDir` (`git worktree list`-based) and reads its
  `.wtft/config.json` directly — the SAME mechanism H2 already uses to
  write — not the plain `loadConfig` walk-up an earlier draft of this bullet
  described. The walk-up survives only as a fallback for when there is no
  repo/git to resolve a main clone from at all (a hand-placed
  `.wtft/config.json` outside any repository). `harness-order.ts`'s own
  module header and `readHarnessOrder`'s docstring carry the full story,
  including why the walk-up alone was wrong: it only reaches an IN-TREE
  worktree, never the out-of-tree layout `worktrees.ts` documents.
- **H2 — write targets the main clone, not cwd.** Opening a session writes
  `harnessOrder` to `<main clone>/.wtft/config.json`, resolved via
  `git worktree list --porcelain`'s first entry (the main working tree) from
  the repo root found by `findRepoRoot(cwd)`. When git can't answer (no repo,
  no git, or the worktree list is empty), the write is skipped — best-effort,
  matching every other config write in this codebase, and consistent with
  "Nothing here should block wtft from producing a report."
- **H3 — MRU, opened only.** Opening (selecting, Enter) a session moves its
  harness to the front of the order; browsing (arrow keys) never writes
  anything.
- **H4 — unseen harness goes last.** A harness with no entry in the sticky
  order sorts after every harness the order names, in harness-registry order
  among themselves when it's a registered harness, else by candidate-discovery
  order as the lowest tier (Interpretation notes, above).
- **H5 — empty harness group is skipped**, not rendered as a zero-row heading.

### The pure key-handling state machine (`extensions/lib/picker-state.ts`, new)

- **K1 — `applyKey` is pure.** No I/O, no clock reads, no globals; every
  transition is `(PickerState, key) => PickerAction` and is exercised by
  feeding key strings, never a real keypress.
- **K2 — navigation wraps the WHOLE logical list**, not just the visible
  window (`j`/`k`/arrows).
- **K3 — Enter selects the row under the cursor**; a no-op when `rows` is
  empty.
- **K4 — `q`/Ctrl+C quit.**
- **K5 — `Ctrl+A`/`Tab`/`Ctrl+W`/`Ctrl+B` set an absolute scope** (not a
  toggle) and request a rescope; **`Ctrl+T` cycles the time window** and also
  requests a rescope. Both leave `cursor`/`windowTop` for the caller to reset
  once new rows arrive via `setRows`.
- **K6 — 12-row windowing is a pure function of `(rows.length, cursor, windowTop)`.**
  `rows.length <= 12` → every row shown (12 exactly included), no position line.
  `rows.length > 12` → an 11-row sliding window plus a position line reading
  `"<start>-<end> of <total>"` (1-based, inclusive), which always contains
  `cursor`. `windowTop` is carried in `PickerState`, not derived from
  `(rows.length, cursor)` alone: a cursor move slides it from its prior value
  (scroll hysteresis), while `setRows` always recomputes it from 0 — the same
  `(rows.length, cursor)` pair can render two different windows depending on
  which path produced it.
- **K7 — cursor ALWAYS resets to the top row after `setRows`**, on every
  rescope — not only one that shrinks the list. A rescope changes what the
  rows ARE, not just how many; leaving the cursor at its old index would let
  a quick rescope-then-Enter open a session the human never looked at
  (pr-review round 2, Low — the first draft only clamped into range, which
  left a growing or same-size rescope's cursor exactly where it was).

### No-TTY `-s` and the new exit code (`bin/wtft.ts`)

- **E1 — an interactive terminal gets the picker**, `--json` included; the
  picker draws to a stream that is never mixed into the `--json` document's
  stdout bytes (`process.stderr` under `--json`, `process.stdout` otherwise).
  **Corrected (pr-review round 2, Low): the precondition is `process.stdin
  .isTTY` AND the picker's OWN output stream's `.isTTY` — stdout under a plain
  launch, stderr under `--json` — not stdout alone.** An earlier draft of this
  bullet said stdout being a TTY was the precondition and called a TTY-stdin/
  non-TTY-stdout combination "not a shape this repo's own tooling produces" —
  that combination is exactly `wtft --tokens | less -R`, a flow the README's
  own Usage section recommends, and stdin stays on the terminal while stdout
  is the pipe. `wtft --json 2>/dev/null` is the same shape under `--json`. The
  `canShowPicker` check in `bin/wtft.ts` is what actually guards this.
- **E2 — no TTY, `-s` matches exactly one → selects it silently**, same as
  today.
- **E3 — no TTY, `-s` matches zero or several → new exit code, lists matches.**
  `EXIT_SESSION_AMBIGUOUS = 10`. Stderr names every match (path + name); under
  `--json`, stdout carries nothing (matching the existing exit-1 contract:
  "under `--json`, stdout carries nothing" for an error).
- **E4 — no TTY, no `-s` at all → same new exit code**, not the old
  auto-pick-newest. This is the contract change the decision names explicitly:
  "This replaces the documented no-prompt `--json` auto-pick of the newest
  session (`auto-selected-session` notice)." The `auto-selected-session`
  notice code and the "Defaulting to newest session" non-interactive fallback
  text are retired.
- **E5 — README's exit-code table and `docs/manifests/wtft-cmd.json`'s
  `exitCodes` both carry `10`.**

### #119 — `total.untaggedCostUsd` (`extensions/lib/wtft-renderer.ts`,
`extensions/lib/wtft-json.ts`)

- **U1 — a new field, not a new type shared with `models[]`/`categories[]`.**
  `SessionSummary.total` gains `untaggedCostUsd` on a type distinct from the
  plain `TokenTotals` interface `ModelTotals`/`CategoryTotals`/`tree` reuse — an
  untagged interaction has no model or category to attach a row to, so nothing
  else in the document should be typed as if it might carry this field.
- **U2 — sourced from the same per-interaction figures the chart bins**, for
  every untagged interaction: `i.cost` (the tag file's `c`) plus
  `i.serverToolCost` when present. `#119`'s decision names `c` as the source
  because every untagged line measured on the real corpus carries `c: 0`; this
  spec adds `serverToolCost` too so the closer's exact-equality assertion holds
  structurally rather than only-because-measured-zero-today.
- **U3 — closer: `chart total === total.costUsd + total.untaggedCostUsd`,
  to half a cent** (the tolerance `tests/wtft-90-…`'s own chart/TOTAL
  comparisons already use, since both scrape a two-decimal display — the
  underlying arithmetic itself is exact), on a fixture with one `<synthetic>`
  turn among tagged ones (the shape
  `tests/wtft-90-total-includes-server-tool-cost.test.ts` TEST 5 built and
  could not yet assert).
- **U4 — schema bump.** `WTFT_JSON_SCHEMA` becomes `wtft/session@4`.
  `docs/spec-26-json.md` gets Amendment 3 recording both #89's `-s`
  contract change (E3/E4 above) and #119's new field, per Amendment 1's own
  precedent ("adding keys is the documented bump condition").

## Verification

- `bun run test` — new suites, named as actually shipped (not as first
  drafted — see below): `tests/wtft-89-scoped-discovery.test.ts` (S1–S7),
  `tests/wtft-89-harness-order.test.ts` (H1–H5),
  `tests/wtft-89-picker-state.test.ts` (K1–K7, pure, no fixtures),
  `tests/wtft-119-untagged-cost.test.ts` (U1–U4). Existing suites
  (`wtft-issue-144-145-164-session-discovery`, `wtft-issue-156-harness-seam`,
  `wtft-35-explicit-session-skips-discovery`,
  `wtft-90-total-includes-server-tool-cost`) stay green, per the
  library-default interpretation note above — `wtft-35` needed one assertion
  updated for E3's new exit code, not a behavioural regression.
- **E2–E4's exit-10 contract**: `tests/wtft-89-no-tty-exit.test.ts` (added in
  pr-review round 2, closing the gap round 1 could only name — real CLI
  subprocesses, non-TTY by construction) covers SEVERAL `-s` matches (not
  zero — corrected, pr-review round 3: an earlier draft of this bullet
  overclaimed zero-`-s`-match coverage here too), zero and several
  default-scoped candidates with no `-s`, and the `--json` empty-stdout
  guarantee on the same exit.
  `tests/wtft-35-explicit-session-skips-discovery.test.ts` covers the
  zero-`-s`-match case as a side effect of its own #35 cost
  assertion. E1 (interactive terminal still shows the picker) has no
  automated coverage — the interactive TTY render loop itself is not unit
  tested anywhere in this codebase, before or after #89; `canShowPicker`'s
  logic (the dual stdin/output-stream TTY check) is exercised only by code
  review and manual verification.
- `bun run typecheck`, `bun run build`, `bash tests/wtft-daemon.test.sh`.
- Regression closer carried forward from #89's own issue body: a fixture with
  many stranded cwds under `"worktrees"` scope does bounded reads (the existing
  V11f-shaped assertion, now exercised through the scope option explicitly
  rather than implicitly through the removed default).

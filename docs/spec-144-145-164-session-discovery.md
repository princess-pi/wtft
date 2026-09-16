# Spec — Three ways a Claude session goes missing from `wtft` (#144, #145, #164)

Three issues, one branch, one seam. They are bundled because they are three *independent*
failure modes of the same question — **"which transcripts belong to this directory?"** — and
each one alone leaves the other two broken. #164 says so explicitly: neither it nor #145
subsumes the other.

| Issue | What is wrong | Where the answer comes from |
|---|---|---|
| #144 | The cwd→slug encoding is wrong for any cwd containing a `.` | the encoding function |
| #164 | A session stranded in a **removed** directory matches nothing | the transcript's own relocation history |
| #145 | A session in a **live sibling** worktree is out of scope | `git worktree list` |

All three extend #156's **union** rule (`docs/spec-156-155-harness-seam-and-daemon-follow.md`):
every change below only ever *adds* matches. Nothing the current selector finds may stop being
found. That is the single invariant this branch is measured against.

---

# #144 — The slug encoding drops a character class Claude Code munges

## Evidence

`extensions/lib/harness/session-cwd.ts:135-137`, the whole of today's encoder:

```ts
/** Encode a directory the way the harnesses do: every separator becomes a dash. */
export function cwdToSlug(cwd: string): string {
	return cwd.replace(/[/\\]/g, "-");
}
```

`extensions/lib/harness/claude-code/discovery.ts:87` uses it as the physical-match key:

```ts
const targetSlug = cwdToSlug(target);
```

Ground truth, read off `~/.claude/projects/` on this machine (2026-08-10, 14 dirs):

```
-home-princess-pi-git-projects-princess-pi-packages--claude-worktrees-139-wtft-pricing-workflows
-home-princess-pi-git-projects-princess-pi-packages--claude-worktrees-146-wtft-cw1h-rate
-tmp-claude-1000--home-princess-pi-git-projects-btw-b3df8f20-…-scratchpad
```

The first two are `…/princess-pi-packages/.claude/worktrees/<branch>`. The `/` before `.claude`
became a dash and **the dot became a dash too** → `--claude-`. `cwdToSlug` would produce
`…-packages-.claude-worktrees-…`, a directory that does not exist, so Claude discovery yields
nothing and the picker shows Pi rows only. The third dir confirms the inverse: a literal `-`
inside a path segment survives unchanged, so the encoding is not "collapse runs of punctuation".

**Verified:** `/` → `-`, `.` → `-`, `[a-z0-9-]` → itself.
**Not verified, and not verifiable from this disk:** `_`, `~`, spaces, `+`, non-ASCII. No project
dir on this machine has ever had one in its cwd.

## Direction — a union of encodings, not a guess at the character class

Pinning `replace(/[^a-zA-Z0-9]/g, "-")` (what #144's body proposes) is right under the
"everything non-alphanumeric munges" hypothesis and **wrong** under "only separators and dots
munge" — a cwd like `/home/u/my_repo` would then be looked up as `-home-u-my-repo` while Claude
Code wrote `-home-u-my_repo`. That trades one silent miss for another.

So: **a candidate project dir matches a target cwd when it equals _either_ encoding.**

```
strict(cwd)  = cwd.replace(/[^a-zA-Z0-9]/g, "-")     // everything munges
legacy(cwd)  = cwd.replace(/[/\\]/g, "-")            // only separators munge (today)
matches(slug, cwd) = slug === strict(cwd) || slug === legacy(cwd)
```

For every path whose punctuation is only `/` and `.`, the two agree except on the dot — so the
union is exactly "today's rule, plus the dot case", which is the only case with evidence. For a
path containing `_`, the union covers **both** hypotheses at the cost of one extra string
compare. It is right whichever way Claude Code actually behaves, and it stays right if a future
version changes its mind.

This commits the codebase to: *slug encoding is a matcher, not a function.* Anywhere a single
slug string is still needed (display), the legacy encoding stays the canonical one, because it
is lossless for the path shapes we render.

## Roads not taken

- **Pin the strict class and be done.** Shortest diff, and it fixes the observed case. Sets aside
  the `_` hypothesis on no evidence; the failure mode when wrong is silent (empty picker), which
  is the exact failure this issue exists to remove.
- **Invert the slug back to a path and compare paths.** The encoding is lossy and not invertible
  (`-` is both a literal and a separator). Would need a filesystem probe per candidate.
- **Ask Claude Code.** No documented or stable interface exposes the encoder.
- **Change Pi's encoding to strict.** Pi dirs on this machine (`~/.pi/agent/sessions/`, 24 dirs)
  contain no dot-derived name at all, so Pi's behaviour is *unverified in the same way*. Pi's
  match is containment, not equality, so the union applies there too — and is likewise additive.
  Replacing Pi's encoder outright is the road not taken.

---

# #164 — A session stranded in a REMOVED directory matches nothing

> **SUPERSEDED by Amendment 1 (#89) — read that first, at the end of this file.**
> The rule this section specifies was built and shipped, and then deleted: measured 2026-09-16 over
> 7,287 real transcripts the whole-file relocation arm returned **0** extra candidates for 6,952
> whole-file reads per launch. Everything below is accurate about what was built and why, and the
> probe numbers are still the honest cost of the design — it is the *conclusion* that did not
> survive a second measurement. Amendment 1 carries the rule in force, the measurement that
> replaced this one, and the one shape that is no longer found.

## Evidence

`extensions/lib/harness/claude-code/discovery.ts:113` — the union filter:

```ts
if (!physicalMatch && resolveLastCwd(file) !== target) continue;
```

and `extensions/lib/harness/session-cwd.ts:79`, what `resolveLastCwd` will look at:

```ts
if (entry && typeof entry.cwd === "string" && entry.cwd) return entry.cwd;
```

Both arms are *correct* and both fail when the directory a session last occupied has been
deleted: the physical slug names the removed worktree, and the resolved last-cwd **is** the
removed worktree. #156 is not at fault — it answers "where does this session live now?", and
"now" was nowhere.

The transcripts already carry the missing information. Measured on this machine:

```
$ rg --no-filename -o '"relocatedCwd":"[^"]*"' …/ee53e779-…-4a28074e5e9e.jsonl | sort | uniq -c
      7 "relocatedCwd":"/home/princess-pi/git-projects/princess-pi-packages"
     41 "relocatedCwd":"/home/princess-pi/git-projects/worktrees/princess-pi-packages/158-one-test-runner"
```

Full entry shape (field order is not stable — two orderings appear in the same file):

```json
{"type":"relocated","sessionId":"ee53e779-…","relocatedCwd":"/home/…/worktrees/princess-pi-packages/158-one-test-runner"}
```

**The ordering subtlety matters.** The *latest* relocation in that file points at the worktree.
Honouring only the latest would not have fixed the reported failure. The **set** is what
matters — and the set contains the main clone, which is where the user was looking from.

## Cost — measured before choosing, because the naive rule is not free

`research/164-relocation-scan-probe.mjs`, over every Claude transcript on this machine:

```json
{ "files": 40, "mb": 68.5, "filesWithRelocated": 3, "relocatedEntries": 136, "fullScanMs": 314.6 }
```

and where the entries sit inside each file, as a fraction of file size:

```
9890440e  size 2702303  first@0.358  last@0.995  within-last-8KB? false
b1f54c2f  size 3102927  first@0.509  last@0.988  within-last-8KB? false
ee53e779  size 2062164  first@0.140  last@0.990  within-last-8KB? false
```

Two things follow. First, **a tail window cannot collect the history** — the earliest relocation
sits at 14–51 % of the file, and even the *last* one falls outside the 8 KB tail on a 2 MB file.
So the history scan is a whole-file scan. Second, **doing it unconditionally costs ~315 ms** on
every `wtft` invocation, against the 11 ms that #156's spec measured and the `< 500 ms` ceiling
that `tests/wtft-issue-156-harness-seam.test.ts:216` already asserts. Unacceptable as a default.

## Direction — a third arm, opened only when the cheap answer is "nowhere"

The gate is not a hack; it is the semantics restated:

> **When a session's current location no longer exists, fall back to everywhere it has ever
> lived.**

Per transcript, in order, stopping at the first hit:

1. **physical slug** matches a target (#144's union of encodings) — free, already computed.
2. **`resolveLastCwd(file)`** equals a target — the 8 KB tail scan, already memoised.
3. **the last cwd is a directory that no longer exists** → read the whole file, collect every
   `relocatedCwd` plus the last `cwd`, and match if *any* of them is a target.

Arm 3 fires only for genuinely stranded transcripts, so the common case pays one extra
`fs.existsSync` per file. A transcript with **no** `cwd` at all (Pi's shape — `resolveLastCwd`
returns `null`) never reaches arm 3, so Pi is untouched, exactly as in #156.

`relocated` is treated as an **optimisation, never a dependency**: a transcript with no
`relocated` entries simply yields a one-element history (its last `cwd`), and arms 1–2 remain the
whole rule. If a future Claude Code drops the entry type, discovery degrades to today's
behaviour rather than breaking. A transcript with no `cwd` *and* no `relocated` yields the empty
history — not a one-element one — which is the shape V8 asserts for Pi transcripts.

The history is **most-recent-first and deduplicated**: index 0 is the last recorded `cwd`, then
relocations walked newest-backwards, with repeats collapsed. Order is what makes "prefer a live
path" mean "the most recent one that still exists"; dedup is because a session that bounces
between two checkouts records the same pair many times.

**Display prefers a live path.** When a session *is* stranded, the picker should not show a
directory that no longer exists. `displayPath` is built from the first still-existing directory
in the history; when the last cwd exists (the overwhelmingly common case) the physical project
slug is used exactly as today, so no currently-rendered row changes. When *no* directory in the
history still exists — every checkout it ever occupied is gone — the physical project slug is
kept rather than inventing a label: the row is then honest about naming somewhere unreachable,
because there is nowhere reachable to name.

Memoisation mirrors `resolveLastCwd`: keyed on `(path, mtimeMs, size)`, so a repeated
`discoverSessions` in one process re-reads nothing. That memo is load-bearing for the cost
argument, not just an optimisation: a stranded transcript is asked for its history twice per
discovery — once to match, once to choose a display path — and the second ask is a cache hit.

`resolveSessionById` is **deliberately unchanged**: it already scans every project dir for a
matching session id, so it was never cwd-scoped and has nothing to fan out over.

## Roads not taken

- **Scan every transcript unconditionally.** The purest reading of #164's proposal, and the one
  that needs no existence gate. 315 ms measured, on every invocation, to serve 3 files of 40.
- **Cap the scan at the last 1 MB.** Cheaper, but the probe shows the earliest relocation at 14 %
  of a 2 MB file — the cap would drop precisely the main-clone entry that makes the match work.
- **`git rev-parse --git-common-dir` as a repo identity** (#145's first comment, retracted by its
  second and by #164). You cannot run git inside a directory that does not exist, and the nearest
  surviving ancestor of an out-of-tree worktree is `~/git-projects/worktrees/`, a plain container
  that identifies no repo. **Not implemented on this branch, deliberately.**
- **Hook `git worktree remove` to move transcripts back.** Fixes the cause, not the class:
  process discipline decays, and discovery should not depend on it. It also cannot help a
  session already stranded.
- **Write a sidecar relocation index.** Needs a cooperating writer running at the moment of the
  move — the same objection #156 raised against a pointer file.

---

# #145 — Live sibling worktrees are out of scope

## Evidence

`discovery.ts:86` resolves the target to exactly one directory:

```ts
const target = path.resolve(targetCwd || process.cwd());
```

and every match is against that one value. `git worktree list --porcelain` in this repo right
now returns **7** checkouts (1 main clone + 6 worktrees). Six sevenths of this repo's session
history is invisible from wherever you happen to be standing. #164's history rule does not help:
a session that has only ever lived in a sibling worktree has never occupied the main clone.

## Direction — fan the target out over the repo's checkouts

`discover(targetCwd)` resolves a **set** of directories, not one:

1. Find the repo root by walking up for a `.git` entry (**file or directory** — a worktree's
   `.git` is a file; verified: `…/144-145-164-session-discovery/.git` is a 105-byte regular
   file). **No `.git` found → no fan-out**, so a non-repo cwd such as `~` behaves exactly as
   today. This is a filesystem check, not a git invocation, so it is also the fallback's gate.
2. Inside a repo: `git worktree list --porcelain`, take every `worktree <path>` line. Exact, no
   false positives, and symmetric — it answers the same from the main clone and from any
   worktree, which is what "and vice versa" in the acceptance criteria requires. The subprocess
   sits on the interactive path, so it is bounded at **3 s** and its stderr is discarded; any
   breach of that bound is a fallback, not a hang.
3. Git absent, erroring, timing out, or answering with no `worktree` lines at all: fall back to
   **slug prefix matching** — `slug.startsWith(targetSlug + "-")` for either encoding. This
   catches the in-tree layout (`<mainSlug>--claude-worktrees-<branch>`) from the main clone only.
   It cannot catch the out-of-tree layout (`…-worktrees-<repo>-<branch>` is not prefixed by the
   main slug) or the reverse direction; that is a known limit of the fallback, called out in #145
   itself. Gated on step 1, so `~` still does not fan out even when git is missing. "Answered
   with nothing" folds into the fallback because a real repo always reports at least itself, so
   an empty list can only mean git did not really answer.

`--dir <path>` keeps meaning "this specific cwd" and fans out over **that** path's repo — the
flag selects the anchor, not the policy. That sentence is also the `--dir/--cwd` line in
`docs/manifests/wtft-cmd.json`, which drives `--help`: a reader who is told only "working
directory for discovery" would conclude the fan-out does not exist.

Scope of the **fan-out**: **Claude discovery only.** Pi's match is already containment
(`extensions/lib/harness/pi/discovery.ts`: `slug.includes(targetSlug)`), which by accident
already fans out over the in-tree worktree layout, and Pi has no worktree-switch mechanism that
rewrites its slug. Fanning Pi out as well is deferred, not forgotten. Pi *is* touched on this
branch, but only by #144's slug union — containment is evaluated against every encoding variant
rather than one — which is additive and changes no Pi row that resolves today.

## Display — worktree rows must be distinguishable

`buildDisplayPath` renders both worktree layouts as one long project name today:

```
~/g-p/worktrees-princess-pi-packages-158-one-test-runner
~/g-p/princess-pi-packages--claude-worktrees-139-wtft-pricing-workflows
```

Both compact to `~/g-p/<repo>/w/<branch>`:

- `<repo>--claude-worktrees-<branch>` — split on the literal marker, unambiguous.
- `worktrees-<repo>-<branch>` — the slug is lossy, so split at the **first all-digit segment**,
  which is the `<issue#>` that opens every branch name under this repo's naming standard. When
  no digit segment exists the string is left alone and rendering is exactly as today. This is a
  display heuristic and is documented as one: being wrong costs a slightly uglier row, never a
  missing session.

## Roads not taken

- **Prefix matching alone, no git.** Cheapest and dependency-free, but one-directional (main →
  worktree only) and blind to the out-of-tree layout, which is this repo's standard. Kept as the
  fallback, not the rule.
- **Scan `~/git-projects/worktrees/<repo>/` directly.** Encodes one machine's convention into a
  shipped tool.
- **Fan out over the whole repo family unconditionally (drop the `.git` check).** Makes `~` list
  every session on the machine — explicitly excluded by #145's acceptance criteria.
- **Cache `git worktree list` on disk.** ~15 ms per invocation does not justify a cache and its
  invalidation.

---

# Shape of the change

```
extensions/lib/harness/session-cwd.ts        + cwdToStrictSlug, cwdSlugVariants, slugMatchesCwd
                                             + resolveCwdHistory (memoised whole-file scan)
                                             + pathExists (memoised)
extensions/lib/harness/worktrees.ts     NEW  findRepoRoot, listWorktreeDirs, fanOutCwd
extensions/lib/harness/claude-code/discovery.ts   three-arm union + fan-out + live display path
extensions/lib/harness/pi/discovery.ts       containment against the slug-variant union (#144)
extensions/lib/session-path-shortener.ts     worktree compaction → <repo>/w/<branch>
bin/wtft.ts                                  re-export the new seams for tests
docs/manifests/wtft-cmd.json                 --dir/--cwd now documents the fan-out; one new
                                             --why scenario for worktree/stranded discovery
tests/wtft-issue-144-145-164-session-discovery.test.ts   NEW
research/164-relocation-scan-probe.mjs       NEW (the measurement above)
.gitignore                                   + a slash-less `node_modules` line
bin/wtft.mjs, bin/wtft-daemon.mjs, bin/serve.mjs, bin/merge.mjs, bin/yada.mjs   rebuilt
```

The `.gitignore` line is not incidental. `node_modules/` (with the trailing slash) does not match
a **symlinked** `node_modules`, which is what every worktree here has — so a `git add -A` during
Code Draft tracked this worktree's symlink, an absolute machine-local path, mode 120000. Fixed
forward in `53440b7`; the slash-less pattern closes the class, not just the instance.

The rebuilt `bin/*.mjs` carry one cosmetic artefact of being built inside a worktree: esbuild
writes each vendored module's *realpath*-relative source comment, so `// node_modules/clone/…`
becomes `// ../../../princess-pi-packages/node_modules/clone/…`. Comments only, no behavioural
difference, and `bun run build` is reproducible within a given checkout — but it means a build
from a worktree and a build from the main clone are not byte-identical. Tracked as **#172**, not
fixed here (Step 5 forbids production changes, and hand-editing generated `.mjs` is a repo hard
gate).

Test seams: `WTFT_CLAUDE_PROJECTS_DIR` (existing) points discovery at a fixture tree;
`WTFT_PI_SESSIONS_DIR` does the same for the Pi harness, so a suite that pins one root can pin
both; `WTFT_NO_GIT=1` (new) forces the no-git fallback path so it can be exercised without
uninstalling git. Three counters in `extensions/lib/harness/session-cwd.ts` make discovery's cost
observable without a clock — `getCwdReadCount` (tail reads), `getCwdBytesRead` (bytes, which
replaced `getCwdHistoryReadCount` when #89 deleted the arm it counted) and `getDirWalkCount`
(directories read by the tree walk, added for #39's V11e) — all reset together by
`resetCwdCache()`. Both are read at call time, never cached across a process. Neither appears in
`docs/manifests/wtft-cmd.json`, deliberately and consistently with #156: they are test seams, not
user-facing switches — a machine without git already reaches the fallback on its own, because the
`git` subprocess throws.

---

# Verification criteria

Each is a concrete assertion in
`tests/wtft-issue-144-145-164-session-discovery.test.ts` unless stated otherwise, driven through
`WTFT_CLAUDE_PROJECTS_DIR` fixtures and interfaces exported from `bin/wtft.mjs` —
`discoverSessions()`, `resolveLastCwd()`, `buildDisplayPath()`, `fanOutCwd()`, `findRepoRoot()`,
the slug helpers (`cwdToSlug`, `cwdToStrictSlug`, `cwdSlugVariants`, `slugMatchesCwd`) and the read
counters. Never module internals. (`resolveCwdHistory()` was in this list; #89 deleted it.) The one
exception is V22, which reads `session-cwd.ts`'s own SOURCE — deliberately, because the invariant
it guards is "this module has exactly one read call", which no exported interface can express.

**Encoding (#144)**

- **V1** — `slugMatchesCwd("-tmp-x-y-z", "/tmp/x.y/z")` is true, and a session filed in a
  fixture dir named `-tmp-x-y-z` is returned by `discoverSessions("claude-code", "/tmp/x.y/z")`.
- **V2** — the real `.claude/worktrees` shape resolves: a fixture dir named
  `-home-t-g-demo--claude-worktrees-99-branch` is found from cwd
  `/home/t/g/demo/.claude/worktrees/99-branch`.
- **V3** — the legacy arm survives: a fixture dir named `-home-t-my_repo` is found from
  `/home/t/my_repo`, **and** so is one named `-home-t-my-repo`. Both hypotheses hold at once.
- **V4** — no false positive: `/tmp/x.y/z` does not match a dir named `-tmp-x-y-z-w`.

**Stranded sessions (#164, restated by Amendment 1 / #89)**

- **V5** — *restated.* A transcript filed under `slug(<main clone>)` — where the session STARTED —
  whose entries record `cwd = <worktree>` with `<worktree>` **not on disk**, is returned by
  `discoverSessions("claude-code", "<main clone>")`. This is the #158 failure as it actually
  occurs, and the physical arm alone answers it.
- **V6** — *inverted.* A transcript filed under `slug(<worktree>)`, reachable from the main clone
  only through its relocation history, is **NOT** returned. This is the case #89 gave up; 0 exist
  on the 7,287-transcript corpus it was measured against. Asserted as a fact about the build so
  the trade is on the record.
- **V7** — no regression: a session that never left the main clone is still found, and the whole
  of `tests/wtft-issue-156-harness-seam.test.ts` Parts A–C passes unchanged.
- **V8** — Pi shape unaffected: a transcript with no `cwd` resolves to `null` from
  `resolveLastCwd` and contributes nothing to any target. (The history half of this assertion
  went with `resolveCwdHistory`.)
- **V9** — *restated as a bound, not a gate.* There is no longer a gate to hold: a dead cwd costs
  what a live one costs. `getCwdBytesRead() <= getCwdReadCount() * 512 KB` after
  `discoverSessions("claude-code", clone)`, with `getCwdReadCount() > 0` confirming the tail scan
  ran at all. Bytes rather than scans, because a scan counter that can only read 0 guards nothing.
- **V10** — display renders under the **physical** slug, the directory the session started in.
  The "prefer the most recent still-existing directory" rewrite went with the whole-file read that
  produced it.
- **V11 (cost, per #164 — restated per #477, then REPLACED per #39)** — five assertions on a
  corpus the TEST builds, not the live `~/.claude/projects` tree, and every one of them an exact
  integer rather than a duration:

  - **V11a** — *restated in bytes.* 60 transcripts of 256 KB each whose recorded cwd still
    exists: the tail scan runs for every one (`getCwdReadCount() >= 60`) and reads tails rather
    than files. The budget is **derived, not a literal** — `SESSIONS x 16 KB`, two first-windows
    of slack per transcript — against the 60 x 256 KB a whole-file pass costs. The two are orders
    of magnitude apart, so it is a bound a regression crosses rather than a tuned threshold.
  - **V11b** — *inverted, and the #89 assertion.* The same corpus with every cwd DEAD must cost
    the same: the same derived budget, and no more reads than the live arm. Before #89 this corpus
    cost the full 60 x 256 KB.
  - **V11f** — *the contract's own fixture.* 200 transcripts, 150 stranded, built to the closer's
    shape. It asserts what holds — the live half resolves, and the whole pass reads tails — and
    **declares the clause it cannot satisfy as a `skip()`** rather than asserting its negation:
    reads are bounded by the corpus, not by the candidate count. An earlier cut asserted
    `strandedTail >= SESSIONS`, which would have made a future success BREAK the suite. The skip
    is counted and listed by `tests/run.ts` on every run, so the gap is visible rather than
    living in a comment.
  - **V11c** — a second discovery re-reads nothing and re-scans nothing. This replaces
    `warm <= cold + 50`, which **could not fail**: a broken memo inflated `warm` *and* the bound
    it was compared against.
  - **V11d** — the real tree keeps a smoke check only: discovery returns without throwing.
    Skipped when `~/.claude/projects` is absent.
  - **V11e** — the tree walk reads each directory exactly once per call (7 project dirs + one
    nested `sessions/`, with `wtft-tags/` skipped ⇒ exactly 8), and is re-walked in full on a
    second call. The second half pins the *absence* of a walk memo, so adding one trips a test
    rather than leaving this paragraph stale.

  Both harness roots are pinned (`WTFT_CLAUDE_PROJECTS_DIR` **and** `WTFT_PI_SESSIONS_DIR`).
  Only the Claude one is read — `discoverSessions("claude-code", …)` selects exactly one
  discovery, measured identical with the Pi root poisoned and with it unset — but routing is an
  implementation detail these assertions do not state.

  **Why no wall clock at all, after two attempts at one.** The original assertion was
  `cold < 500`: a fixed bound on an input that grows every session, and it rotted. #477 replaced
  it with a ratio against a memoised call, which rotted the opposite way — the memo makes `warm`
  cheaper as it improves, so the divisor shrinks while cold still walks the whole tree. Measured
  on `main` @ `bcedfd8`: **6 failures in 6**, cold ~2.1 s against warm ~37 ms, a ratio of 53-61x
  against a bound of 40x. **A constant multiple of a memoised call cannot bound an unmemoised
  one**, and no choice of multiple repairs it. princess-pi-tools#489 had already named the honest
  fix — "assert on the read counters this suite already exports (V9's idiom), which are
  scale-invariant by construction and need no ceiling, no ratio, and no host calibration" — and
  that is what V11a-e are.

  **And a ratio could never have guarded the walk**, which is the one cost the counters were
  accused of abandoning. The walk is identical in both arms of a live-vs-stranded A/B, so it
  inflates numerator and denominator together: measured on a 200-file corpus, the ratio is
  **3.38x** with no extra directories and **1.21x** with 3,000 empty ones added to *both* sides.
  A `stranded > 2 x live` bound therefore fires red on a harmless walk regression and goes green
  as the walk gets slower. V11e counts it instead.

  **What the counters can still not say** is what the gate was *worth* in time. That lives in
  `research/39-v11-corpus/measure-gate.ts`, a manual probe that gates nothing: 250 files x 256 KB
  measured the `pathExists` gate at a 4.9-5.6x difference. It still RUNS — it builds its own
  fixtures and imports only node builtins, never the helpers #89 deleted — and it is now a record
  of what that arm cost rather than a measurement of live code.

  **The mutation record below is from before #89 and two of its mutations can no longer be
  performed** — `pathExists` and `getCwdHistoryReadCount` do not exist. It is kept as the record
  of what guarded the deleted arm. The mutations that gate the CURRENT assertions are: widening a
  tail window toward the file size fails V11a/V11b on bytes while leaving the read count
  identical; adding an `fs.readFileSync` anywhere in `session-cwd.ts` fails **V22**, which is the
  one guard a byte counter cannot be, and which was mutation-checked when it was written.

  The pre-#89 record: short-circuiting `pathExists` fails V11a at 60 scans over 60 transcripts; disabling the
  `cwdCache` read fails V11c at 60 new tail reads; dropping `wtft-tags` from `SKIP_DIRS` fails
  V11e's first half (9 vs 8) and leaves its second green; memoising the walk fails the second
  (8 vs 16) and leaves the first green.

  `tests/wtft-issue-156-harness-seam.test.ts` Part C carried the same fixed `elapsed < 500`
  ceiling over the same real tree, tracked as **#18** and addressed on its own branch by the
  same technique (not merged as of this branch) — a second
  discovery over the real history re-reads nothing, with the first pass's read count printed
  beside it so the check cannot go vacuous.

  That is a **trade, not a strict superset**, and an earlier draft of this paragraph said
  otherwise. Gained: memo collapse is caught deterministically — disabling the memo fails it at
  2,835 re-reads, while the same broken build ran the timed call in 137 ms and would have passed
  `elapsed < 500`. Given up: a wall-clock blowup that costs no extra *reads* — an O(n²) bug in
  `collect()`, say — is invisible to a read counter, where walk time did count toward `elapsed`.
  What was surrendered is a probabilistic signal on a class the ceiling never reliably held:
  whether it fired depended on the host and the corpus, and on this host it had begun firing with
  no regression behind it. V11e is the instrument that covers the walk properly; once #18 merges,
  its Part C can adopt it against the real tree.

**Sibling worktrees (#145)**

- **V12** — in a real temporary git repo with a real `git worktree add`, a session filed under
  the worktree's slug is returned by `discoverSessions("claude-code", <main clone>)`.
- **V13** — and the reverse: a session filed under the main clone's slug is returned from
  `discoverSessions("claude-code", <worktree>)`.
- **V14** — a repo with **no** worktrees returns exactly the set it returns today.
- **V15** — a non-repo cwd does not fan out: a tmp dir with no `.git` ancestor returns only its
  own sessions, and a sibling dir's sessions are absent.
- **V16** — `WTFT_NO_GIT=1` from the main clone still finds an in-tree
  `<mainSlug>--claude-worktrees-<branch>` session by prefix, and *still* does not fan out from a
  non-repo cwd.
- **V17** — `--dir <worktree>` from the main clone fans out over that worktree's repo (same set
  as V13).

V12–V14, V16 and V17 build a **real** git repo and a **real** `git worktree add` in a temp dir
rather than faking `git worktree list` output — the point of #145 is that git is the source of
truth, so mocking it would test the mock. The consequence is that they self-skip (with a printed
note) on a machine where `git init` fails; V15's non-repo case does not depend on git and always
runs.

**Display (#145)**

- **V18** — `buildDisplayPath("x…5e9e.jsonl", "-home-<user>-git-projects-worktrees-demo-99-branch",
  "claude-code")` renders `~/g-p/demo/w/99-branch/...5e9e`.
- **V19** — `buildDisplayPath(…, "-home-<user>-git-projects-demo--claude-worktrees-99-branch", …)`
  renders `~/g-p/demo/w/99-branch/...5e9e`.
- **V20** — a project name with no digit segment (`worktrees-demo-scratch`) is left exactly as
  today, and a plain repo slug is unchanged.

**Whole-suite invariant**

- **V21** — `bun run test` is green: the pre-branch 43 suites plus this branch's own
  `wtft-issue-144-145-164-session-discovery` = 44, none regressed by this branch. V21 is the only
  criterion with no assertion inside the test file — it *is* the runner's report. The declared
  runner (`bun tests/run.ts`, #158) does not drive the two shell suites
  (`serve-no-sudo-nginx.test.sh`, `wtft-daemon.test.sh`); it names them in its own output, and
  neither touches any file on this branch.

---

# Definition of done

V1–V22 pass and `bin/wtft.mjs` is rebuilt — **not committed**: `bin/*.mjs` is gitignored in this
repo (`.gitignore`), which it was not in the pre-extraction one this line was written in. Build it
with `bun run build` before running the suites, since they import the bundle, and install it with
`bin/install-wtft` before trusting `~/bin`.

The union invariant is the thing to re-check on any later edit: **no arm of this rule may ever be
turned into a replacement** — with the single, measured exception recorded in Amendment 1, where an
arm was deleted outright after it was shown to add nothing.

**`bun run typecheck` is not a gate this branch can meet, and the reason is not this branch.**
An earlier draft of this section demanded a clean typecheck. `tsc --noEmit` is red at the branch
point (`ad91cdc`) and stays red here, with the same two errors both times:

```
bin/serve.ts(21,81):                      error TS7016: … '../extensions/lib/serve/cloudflare.js' implicitly has an 'any' type.
extensions/lib/serve/process.ts(6,59):    error TS7016: … './cloudflare.js' implicitly has an 'any' type.
```

`extensions/lib/serve/cloudflare.js` has no `.ts` source and no declaration file. No file this
branch touches appears in either error, and this branch adds none. Tracked as **#168** ("typecheck
is red on clean main — and nothing gates it"), which is where the fix belongs — fixing it here
would be a production change during Step 5. The honest gate for this branch is: **`bun run test`
green, and `tsc --noEmit` no worse than `ad91cdc`.** Both hold.

---

# Step 5 — reconciliation record

Every readable artifact in this branch's file-level blast radius, checked against the code that
actually shipped (`53440b7`). Rows are the contradictions **found**, not the surfaces inspected —
surfaces that already matched are listed under "Clean on inspection" below. The loop ran until a
fresh pass found nothing new; the pass that produced the last row is the pass that ended it.

| Artifact | Claim it made | Contradicted by | Test-covered? | Action |
|---|---|---|---|---|
| `docs/spec-144-145-164…md` § Definition of done | "`bun run typecheck` is clean" is a gate this branch meets | `tsc --noEmit` is red at branch point `ad91cdc` *and* here, same 2 errors, in `serve/cloudflare.js` — a file this branch never touches | no (nothing gates typecheck — that is #168) | Replaced with the gate the branch can actually meet, errors quoted, deferred to #168 |
| `docs/spec-144-145-164…md` V11 | "`resolveLastCwd` still resolves on a representative sample without widening" | no such assertion exists; Part E asserts cold < 500 ms, no-throw, and warm ≤ cold+50 | yes (V11) | Rewritten to the three assertions the test makes; the `Date.now()` latitude stated and justified |
| `docs/spec-144-145-164…md` V8 | resolves to `null` from `resolveLastCwd` | true but partial — the test also asserts `resolveCwdHistory` returns `[]` | yes (V8) | Added the history half |
| `docs/spec-144-145-164…md` § Verification preamble | tests drive "`discoverSessions()` / `resolveLastCwd()` / `buildDisplayPath()`" | test also drives `resolveCwdHistory`, `fanOutCwd`, `findRepoRoot`, all four slug helpers, both counters | n/a | List completed |
| `docs/spec-144-145-164…md` § #164 Display | `displayPath` "is built from the first still-existing directory in the history" | `displaySlugFor` falls back to the physical slug when *no* directory in the history exists — the spec named no such case | partially (V10 covers the live case only) | Fallback documented; row marked `reconciled-against-untested` |
| `docs/spec-144-145-164…md` § #164 | history described only as a list | `resolveCwdHistory` returns most-recent-first **and deduplicated** (`[...new Set(ordered)]`); empty (not one-element) when there is no `cwd` at all | yes (V6 order, V8 empty); dedup untested | Order + dedup + empty-case documented; dedup `reconciled-against-untested` |
| `docs/spec-144-145-164…md` § #145 step 3 | fallback fires when git is "absent, erroring, or timing out" | `listWorktreeDirs` also returns null when git answers with **no `worktree` lines**, and bounds the subprocess at 3 s | no | Both stated, with why an empty list can only mean "git did not really answer" |
| `docs/spec-144-145-164…md` § #145 Scope | "Claude discovery only" | `pi/discovery.ts` *is* changed on this branch — by #144's slug union | no direct Pi assertion | Scoped to the fan-out; the Pi change stated explicitly |
| `docs/spec-144-145-164…md` § Shape of the change | omitted `.gitignore`, the manifest, and the rebuilt `bin/*.mjs` | `git diff main..HEAD` lists all three | n/a | Added, with the reason `node_modules/` failed to match a symlink, and #172 |
| `docs/spec-144-145-164…md` | silent on `resolveSessionById` | it is unchanged and was never cwd-scoped — a reader could assume the fan-out reaches it | no | One line stating it is deliberately untouched |
| `docs/spec-144-145-164…md` V21 | "43 + 1 = 44 suites" | true, but the runner also *declines* two shell suites and says so in its own output | yes (the runner) | Shell-suite caveat added |
| `docs/manifests/wtft-cmd.json` `--dir/--cwd` | "Working directory for Claude Code session discovery" | `discover()` calls `fanOutCwd(target)` — the flag now anchors a repo-wide fan-out. **An omission: a reader concludes the fan-out does not exist.** Drives `--help`. | yes (V17) | Rewritten; a `--why` scenario added for worktree + stranded discovery |
| `docs/EXT_WTFT.html` § 5 | "the project name is kept in full" | `compactWorktreeProject` rewrites a worktree checkout to `<repo>/w/<branch>` | yes (V18–V20) | Exception documented with a worked example |
| `docs/EXT_WTFT.html` § 5 | sessions "are identified by their parent directory slug" — full stop | four arms now, three of them not the slug | yes (V1–V17) | New § 5b states the union rule and that no arm may become a replacement |
| `docs/spec-156-155…md` § Rule — union | the shipped rule is the two arms stated there | `slug(D)` is now a set (#144), `D` is now a set (#145), and a third arm exists (#164) | yes (V1–V17) | Forward-pointer block; the additive invariant noted as what all three were measured against |
| `docs/spec-156-155…md` § Pi is unaffected | Pi is untouched | true of arms 2–4, false of #144's slug union | no | Qualified per-arm |
| `docs/spec-156-155…md` § Tail-scan | "scan the whole file as a last resort" | **pre-existing, not this branch.** `TAIL_WINDOWS` is `[8 KB, 64 KB, 512 KB]` with no unbounded pass. Probe 2026-08-10: an 851 KB transcript with its only `cwd` on line 1 → `resolveLastCwd` returns `null` | no | Doc corrected to the shipped behaviour with the probe inline; **code** question filed as **#170** |
| `extensions/lib/harness/worktrees.ts` `listWorktreeDirs` | `WTFT_NO_GIT` is "a real escape hatch on machines without git" | a machine without git already reaches the fallback — `execFileSync` throws. The var is a test seam. | yes (V16) | Comment narrowed to what it is |
| `extensions/lib/harness/session-cwd.ts` `getCwdHistoryReadCount` | counter "must stay at zero (spec V9)" | V9 now asserts `<= 1`; zero holds only when *every* last cwd exists | yes (V9) | Docstring states what it counts (scans, not call sites) and both cases |
| `extensions/lib/session-path-shortener.ts` `buildDisplayPath` | "Transformations:" list | omitted the worktree compaction the same function now performs | yes (V18–V20) | Bullet added, with the scope limit (known prefixes only) |
| `tests/wtft-issue-144…test.ts` header | "no test reads the host clock" | Part E calls `Date.now()` twice | — | **The exact failure this repo has shipped before.** Rewritten: no assertion depends on a wall-clock *date*; elapsed time is the quantity under test in V11 and cannot be injected away |
| `tests/wtft-issue-144…test.ts` header | interface list, and "V1–V21" | list omitted six exported helpers; V21 has no assertion in the file | — | List completed; V21 explicitly named as the runner's report |
| `docs/adding-a-harness.md` § 1 | the union rule is two arms, and `resolveLastCwd` is the only helper a harness author needs | three more arms and four more shared helpers now exist. **An omission with teeth: an author following this guide would write a pinned slug encoding — the exact #144 bug.** | yes, for the helpers (V1–V17) | Three arms documented as helpers to reach for, each with its gate and its cost, plus the additive invariant and the note that none of it is required to ship |
| `docs/spec-47-shared-session-utilities.md` § `buildDisplayPath` transformation rules | a table presented as the complete set of transformations | omits the worktree compaction the same function now performs — a table that looks exhaustive and is not | yes (V18–V20) | Three rows added (both layouts + the no-digit case) with the scope limit stated |
| `extensions/lib/session-selector.ts` `discoverSessions` docstring | states the two-arm union rule as *the* rule, on the public entry point every caller reads first | four arms shipped. The file itself is untouched by this branch, which is exactly why it drifted — the neighbour nobody looked at | yes (V1–V17) | All four arms enumerated with their gates, plus the additive invariant and which arms each harness actually uses |

**Clean on inspection** — checked, contradicted nothing, changed nothing: `README.md` (says
nothing about discovery scope); `docs/agents/*.md` (no suite count, no discovery claim);
`bin/wtft.ts` (re-export block only, its comment matches); `extensions/lib/harness/pi/discovery.ts`
(its new header paragraph already states the #144 union and the road not taken);
`extensions/lib/harness/claude-code/discovery.ts` (header enumerates all three issues correctly);
`research/164-relocation-scan-probe.mjs` (header matches what it measures, and the numbers it
produced are the ones quoted above); `docs/EXTENSIONS.html` and `docs/EXT_MV_SESSION.html` (their
"relocation" is `/mv-session` moving a Pi session, an unrelated sense of the word — no wtft
discovery claim); `docs/manifests/{serve,merge,yada}-cmd.json` (no discovery surface); every
error/warning/status string in the touched files — this branch adds none.

The two rows that mattered most were both found this way rather than by following the diff:
`docs/adding-a-harness.md` and `extensions/lib/session-selector.ts` are the two files a reader
meets *before* any file this branch edited, and neither appears in `git diff main..HEAD`. Auditing
by blast radius rather than by changed symbol is what surfaced them.

**Rows marked `reconciled-against-untested`**, i.e. the doc now matches code that no assertion
pins: `listWorktreeDirs` returning null on an empty `worktree` list, and the 3 s git timeout. Each
is a defensive branch that a fixture cannot reach without contriving a broken git. They are
documented as behaviour, not asserted as contract.

Two more rows were on this list and are now moot: the no-live-directory display fallback in
`displaySlugFor`, and the dedup in `resolveCwdHistory`. **#89 deleted both functions** — the
cheapest way an untested branch ever leaves this list.

**Follow-ups filed, not fixed here** (Step 5 permits no production change): **#170** the 512 KB
tail cap, **#171** the leaked `wtft-daemon` child in
`tests/wtft-tree-navigation-cost-divergence.test.ts`, **#172** the worktree-build path leakage in
generated `bin/*.mjs`. **#168** (typecheck red on clean main) predates this branch and stays open.


---

# Amendment 1 (#89) — the relocation arm is deleted

**What it cost.** Every figure below comes from ONE measurement pass, 2026-09-16, so the
denominators reconcile. An earlier draft of this amendment mixed two runs a day apart and its
numbers did not add up — 6,637 against 6,952, and a "6,897 transcripts" that matched neither.

**The corpus** (one walk, `~/.claude/projects`, after `SKIP_DIRS`): **7,287 transcripts · 2.51 GB ·
1,944 project dirs**, of which **42** contain a `"type":"relocated"` record.

**Per launch, before the deletion** (`debug/count-picker.ts`, warm pages, `discoverSessions("auto")`
so both harnesses run):

| cwd | candidates | warm ms | tail reads | whole-file reads |
|---|---:|---:|---:|---:|
| `~/git-projects/wtft` | 10 | 4,276 | 14,443 | **6,952** |
| `~/git-projects/princess-pi-tools` | 88 | 3,901 | 14,421 | **6,952** |
| `~` | 153 | 3,721 | 14,050 | **6,952** |

Cold, on a quiet machine, the same scan measured 34,850 ms.

**What it bought.** Split per candidate, the history arm contributed **0** of them, for all three
cwds. Two facts explain why, and both are structural rather than incidental:

- **Relocations are rare.** **42** of the corpus's 7,287 transcripts carry a `"type":"relocated"`
  record at all. So of the 6,952 whole-file reads a launch performed, **at most 42 could match
  anything** and at least 6,910 were reading files with nothing in them to match against. That is
  the ceiling, not an estimate: a read of a transcript with no relocation record cannot produce a
  directory the tail scan had not already produced.
- **The physical arm already covers the shape — measured, not proved.** Claude Code files a
  transcript under the directory its session STARTED in, and a session *usually* starts in the main
  clone before it enters a worktree, so the physical slug plus the #145 fan-out already reaches it.
  Measured per arm, the history arm contributed **0** candidates for all three cwds; and the
  candidate lists before and after the deletion are **identical** (10 / 88 / 153), which is the
  direct evidence rather than the argument for it.

  **It is not universal, and the exception is conceded below.** A session that started *inside* a
  worktree is filed under that worktree's slug; once the worktree is gone, only its relocation
  history connected it to the clone. The corpus holds 101 `*-claude-worktrees-*` slugs, so the
  shape is reachable — it simply had no member that the physical arm missed on the day this was
  measured. V6 in the suite constructs one and asserts it is not found.

The #158 failure this section was written for is therefore real, and was already fixed by the
physical arm plus the fan-out — the history arm was answering a question nobody was asking.

**What was deleted.** `resolveCwdHistory`, `historyCache`, `pickLiveCwd`, `pathExists`,
`existsCache`, `getCwdHistoryReadCount`, the `RELOCATED_MARKER` pre-filter, the gate in
`matchesRecordedCwd`, and `displaySlugFor` entirely. `matchesRecordedCwd` is now one tail read and
one set lookup. The relocation records are still IN the transcripts; nothing reads them.

**What it bought back.** Same corpus, same probe, after (three runs each, warm):

| cwd | candidates | warm ms | tail reads | bytes read |
|---|---:|---:|---:|---:|
| `~/git-projects/wtft` | 10 | 1,791–1,962 | 14,441 | 580 MB |
| `~/git-projects/princess-pi-tools` | 88 | 1,954–1,992 | 14,344 | 576 MB |
| `~` | 153 | 1,559–1,595 | 14,051 | 519 MB |

14,441 reads over 7,287 transcripts is **~1.9 reads and ~41 KB each** — the tail windows widen far
more often than `TAIL_WINDOWS`'s original "8 KB resolves every transcript here" assumed, and a
transcript with no `cwd` at all (every Pi one) widens through all three and then reads whole, which
is #112. Both figures are now in that module's header, where a reader meets them.

**Where that cost actually sits, which matters for the index that has to remove it**
(`bun debug/count-picker.ts <cwd> --per-harness`, from `~/git-projects/wtft`):

| harness | candidates | ms | reads | bytes | dir walks |
|---|---:|---:|---:|---:|---:|
| `claude-code` | 6 | 1,009 | 9,460 | 281 MB | 2,217 |
| `pi` | 4 | 1,066 | 5,157 | 305 MB | 0 |
| `auto` | 10 | 1,939 | 14,617 | 586 MB | 2,217 |

**Pi is slightly more than half of it and walks no directories at all.** An index built for Claude
discovery alone would leave half the cost in place — worth knowing before direction A is designed,
and the reason the probe grew a `--per-harness` mode.

**The widening loop also stopped re-reading itself** on this branch. It used to read
`[size-window, size)` from scratch on each widening, so a transcript that needed all three windows
cost 8 + 64 + 512 = 584 KB to scan 512 KB. It now reads only the newly exposed prefix and decodes
the accumulated buffer (bytes once, CPU again — and bytes are what is scarce). Modelled over the
real corpus the saving is **~2.8%**, because only 28 of 7,318 transcripts widen that far: a large
per-file win on a rare file, stated at its measured size rather than at its headline ratio.

**Identical candidate counts, ~2.2x faster warm, zero whole-file reads.** No session was lost on
the corpus this was measured against.

**TWO OF #89's ACCEPTANCE CRITERIA ARE NOT MET, and both are recorded rather than quietly
restated.**

1. **≤ 200 ms warm.** This is 1,559–1,962 ms, eight to ten times the ceiling.
2. **Reads bounded by the CANDIDATE count, not the corpus.** They are not, and cannot be while
   every arm must ask each transcript where it lives before ruling it out. V11f asserts this in the
   direction that is true today — zero candidates, still one read per transcript — so the day the
   bound is achievable that line fails and must be rewritten, rather than a comment going stale.

Both are the same cost: what remains scales with the corpus, and only an on-disk index removes it —
`~/.cache/wtft/cwd-index.jsonl` keyed `(path, mtimeMs, size)`, scanning only bytes appended since
the recorded size. That is the issue BODY's direction **A**, and "I" in its 2026-09-15 comment;
the two letter schemes are not the same and this amendment uses both names deliberately, because
the issue does. The decision on record is to build it only if the experience is still slow after
this deletion. It is. **#89 stays open**; this branch does not close it.

**The one shape given up.** A session filed under a project slug that is not a checkout of the
target, reachable only through its relocation history, is no longer listed. Zero such sessions
exist on the development corpus. If one ever appears, the transcript still carries its history —
re-derive it there, ideally inside the index rather than by restoring a per-launch whole-file
scan.

**New instrument.** `getCwdHistoryReadCount()` is replaced by `getCwdBytesRead()`. A counter that
can only ever read 0 is not a guard; bytes is the quantity a reinstated whole-file read moves, and
it also catches the half-measure of a tail window widened to the file size. `debug/count-picker.ts`
reports it, and V9/V11a/V11b assert on it.

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
`WTFT_NO_GIT=1` (new) forces the no-git fallback path so it can be exercised without
uninstalling git. Both are read at call time, never cached across a process. Neither appears in
`docs/manifests/wtft-cmd.json`, deliberately and consistently with #156: they are test seams, not
user-facing switches — a machine without git already reaches the fallback on its own, because the
`git` subprocess throws.

---

# Verification criteria

Each is a concrete assertion in
`tests/wtft-issue-144-145-164-session-discovery.test.ts` unless stated otherwise, driven through
`WTFT_CLAUDE_PROJECTS_DIR` fixtures and interfaces exported from `bin/wtft.mjs` —
`discoverSessions()`, `resolveLastCwd()`, `resolveCwdHistory()`, `buildDisplayPath()`,
`fanOutCwd()`, `findRepoRoot()`, the slug helpers (`cwdToSlug`, `cwdToStrictSlug`,
`cwdSlugVariants`, `slugMatchesCwd`) and the read counters. Never module internals.

**Encoding (#144)**

- **V1** — `slugMatchesCwd("-tmp-x-y-z", "/tmp/x.y/z")` is true, and a session filed in a
  fixture dir named `-tmp-x-y-z` is returned by `discoverSessions("claude-code", "/tmp/x.y/z")`.
- **V2** — the real `.claude/worktrees` shape resolves: a fixture dir named
  `-home-t-g-demo--claude-worktrees-99-branch` is found from cwd
  `/home/t/g/demo/.claude/worktrees/99-branch`.
- **V3** — the legacy arm survives: a fixture dir named `-home-t-my_repo` is found from
  `/home/t/my_repo`, **and** so is one named `-home-t-my-repo`. Both hypotheses hold at once.
- **V4** — no false positive: `/tmp/x.y/z` does not match a dir named `-tmp-x-y-z-w`.

**Stranded sessions (#164)**

- **V5** — a transcript filed under `slug(<worktree>)`, whose entries record `cwd = <worktree>`
  and which carries `{"type":"relocated","relocatedCwd":"<main clone>"}`, where `<worktree>`
  **does not exist on disk**, is returned by `discoverSessions("claude-code", "<main clone>")`.
  This is the #158 failure, reproduced.
- **V6** — ordering: the same fixture with the *latest* relocation pointing at the worktree still
  matches from the main clone. (Asserts the set rule, not last-wins.)
- **V7** — no regression: a session that never left the main clone is still found, and the whole
  of `tests/wtft-issue-156-harness-seam.test.ts` Parts A–C passes unchanged.
- **V8** — Pi shape unaffected: a transcript with no `cwd` and no `relocated` resolves to `null`
  from `resolveLastCwd`, yields the **empty** history from `resolveCwdHistory`, and contributes
  nothing to any target.
- **V9** — the gate holds: in a batch with one stranded transcript (last cwd removed) and one
  live-cwd transcript (`homebody`, last cwd exists), the whole-file history scan fires **at most
  once** — for the stranded one — never for `homebody`. `resolveCwdHistory` is called a second
  time during display (`displaySlugFor`), but the `(path, mtimeMs, size)` memo absorbs it, so the
  read counter still shows one scan, not two. Concretely: `getCwdHistoryReadCount() <= 1` after
  `discoverSessions("claude-code", clone)`, with `getCwdReadCount() > 0` confirming the cheap tail
  scan ran at all.
- **V10** — display prefers a live path: the V5 candidate's `displayPath` names the main clone,
  not the removed worktree.
- **V11 (cost, per #164, restated per #477)** — against the real `~/.claude/projects`, not a
  fixture: `discoverSessions("claude-code", process.cwd())` returns without throwing, and a
  *cold* call stays within a bounded multiple of a second, *memoised* call
  (`cold <= min(40 * max(warm, 5) + 250, 5000)`) rather than under a fixed millisecond ceiling.
  The `max(warm, 5)` floor is not decoration: `Date.now()` resolves to about a millisecond, so on
  a quiet host with little history a warm pass whose real cost is a few ms measures as **0**, and
  the bound would collapse to its bare 250 ms additive term — tight enough to fail a legitimately
  larger `cold` with no regression behind it. The floor holds the bound's minimum at
  `40 * 5 + 250 = 450 ms`. Skipped
  when `~/.claude/projects` is absent. This is the one criterion measured in wall-clock time; it
  reads `Date.now()` for *elapsed* time only — never a date — which is the same latitude #156's
  ceiling test takes, because a duration is the quantity under test and cannot be injected away.

  **Why a ratio, not a ceiling (#477):** the original assertion was `cold < 500`, a fixed bound
  on reading the *live* `~/.claude/projects` tree. That directory grows every session — this host
  runs 5+ concurrent sessions, including the one running the suite — so the measurement's input
  grew monotonically while its 500 ms budget never moved. Not flaky in the random sense: drifting
  toward *always*-failing, and failing in part *because* it ran. #477's own repro needed
  concurrent load to tip it over (`bun run test` hit 519 ms under contention from other sessions);
  by the time of this fix the same host's history had grown enough that cold discovery breaches
  500 ms even with **no concurrency at all** (measured standalone: 400-650 ms) — concurrency
  made the ceiling fail sooner, but growth alone was enough on its own a few weeks later. Two
  roads not taken: bound the input with a fixture tree
  of fixed size (loses the "against the real history" property the check exists for), or raise
  the ceiling (buys months, costs the same conversation again, weakens the check without saying
  so). The ratio taken instead mirrors the sibling assertion three lines below
  (`warm <= cold + 50`), which was never flaky for the same reason: bounding cold against warm's
  `40 * warm` term scales with the input on its own. It still tests something real, at two cost
  tiers. `matchesRecordedCwd` (`extensions/lib/harness/claude-code/discovery.ts`) does a bounded
  tail read via `resolveLastCwd` for every transcript across the whole `~/.claude/projects` tree
  whose slug doesn't physically match the target — not just stranded ones — and, for whichever of
  those are *additionally* stranded (their last-cwd directory no longer exists), an expensive
  whole-file scan via `resolveCwdHistory`, gated on `pathExists`
  (`extensions/lib/harness/session-cwd.ts`). Both tiers are cache misses on cold and cache hits on
  warm, so either one regressing — the cheap tier running unconditionally, or the expensive tier's
  gate failing to gate — still shows up as cold ballooning relative to warm. The expensive tier is
  documented as rare in general (`session-cwd.ts`: "~3 transcripts in 40"), but on *this*
  measurement host it dominates: the #477 mutation probe counted 1496 whole-file scans out of
  1803 tail reads (~83%) — this repo's own workflow creates and destroys worktrees constantly, so
  most sessions here really are stranded. Proved by mutation during #477: a forced 1.5 ms stall on
  every cache-miss resolve — hitting both tiers — pushed the measured ratio from ~10-30x to
  ~130-175x on this machine, comfortably clearing the bound in one direction and tripping it in
  the other.

  A pure ratio has one blind spot: cold and warm degrading *together* — the memo itself breaking,
  so the "warm" pass re-scans too — inflates the allowed bound right along with warm, so both this
  check and the untouched `warm <= cold + 50` sibling would pass no matter how slow either call
  got. `min(…, 5000)` **narrows** that gap; it does not close it, and an earlier draft of this
  section said "closes" — corrected here, because a run falsifies it. Measured 2026-08-24 by
  disabling the `cwdCache` read outright: cold=597 ms, warm=85 ms, and **both V11 checks passed**,
  since 597 is under `min(3650, 5000)` and 85 is under `cold + 50`. Total memo collapse costs the
  *warm* pass, and 85 ms is well short of the ~119 ms warm needs before the cap becomes the
  binding constraint at all. **princess-pi-packages#489 tracks the gap**, and proposes the honest
  fix: assert on the read counters this suite already exports (V9's idiom), which are
  scale-invariant by construction and need no ceiling, no ratio, and no host calibration.

  This is **not a regression the ratio introduced** — the fixed 500 ms ceiling never caught memo
  collapse either, because nothing in this suite has ever bounded *warm* in absolute terms. The
  failure mode was always untested; the ratio only makes it sayable.

  The backstop is also **not free — a real, stated exception to "the fix scales with input," not
  an unconditional one.** 5000 ms is a deliberately loose bound, ~8-12x today's measured cold
  time, that becomes the binding constraint only once warm itself has grown past ~119 ms — call
  it an order of magnitude further growth of this host's history — at which point the check *does*
  degenerate back into
  a fixed ceiling against a growing input, the same failure mode #477 exists to eliminate. The
  trade accepted here is buying roughly a decade's worth of the growth rate observed so far, in
  exchange for closing the co-degrade blind spot; it is not immune to the same drift indefinitely,
  only to a much larger multiple of it. Caught a first-draft mistake during review
  (princess-pi-packages#477): the natural-looking `Math.max(40 * warm + 250, 5000)` does the
  opposite of what's wanted — it can only *raise* the bound, so a 10000 ms cold / 9800 ms warm
  co-degrade would still pass at `max(392250, 5000) = 392250`. `Math.min` caps it at
  `min(392250, 5000) = 5000` and correctly fails.

  `tests/wtft-issue-156-harness-seam.test.ts` Part C asserts the same fixed `elapsed < 500`
  ceiling over the same real tree — on a call that is already warm by the time it's timed, so it
  currently has far more headroom (measured warm cost: ~20-40 ms) than V11's old cold-based
  check ever did. It was out of scope for #477 and was left unchanged; it shares the same defect
  class and can drift the same way as the live tree keeps growing. Tracked as **#487**, with a
  pointer comment in the sibling test file itself.

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

V1–V21 pass and `bin/wtft.mjs` is rebuilt and committed with its `.ts` sources. The union
invariant is the thing to re-check on any later edit: **no arm of this rule may ever be turned
into a replacement.**

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
pins: the no-live-directory display fallback in `displaySlugFor`; the dedup in
`resolveCwdHistory`; `listWorktreeDirs` returning null on an empty `worktree` list; the 3 s git
timeout. Each is a defensive branch that a fixture cannot reach without contriving a broken git
or a fully-deleted repo history. They are documented as behaviour, not asserted as contract.

**Follow-ups filed, not fixed here** (Step 5 permits no production change): **#170** the 512 KB
tail cap, **#171** the leaked `wtft-daemon` child in
`tests/wtft-tree-navigation-cost-divergence.test.ts`, **#172** the worktree-build path leakage in
generated `bin/*.mjs`. **#168** (typecheck red on clean main) predates this branch and stays open.

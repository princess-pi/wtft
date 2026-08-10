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
behaviour rather than breaking.

**Display prefers a live path.** When a session *is* stranded, the picker should not show a
directory that no longer exists. `displayPath` is built from the first still-existing directory
in the history; when the last cwd exists (the overwhelmingly common case) the physical project
slug is used exactly as today, so no currently-rendered row changes.

Memoisation mirrors `resolveLastCwd`: keyed on `(path, mtimeMs, size)`, so a repeated
`discoverSessions` in one process re-reads nothing.

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
   worktree, which is what "and vice versa" in the acceptance criteria requires.
3. Git absent, erroring, or timing out: fall back to **slug prefix matching** —
   `slug.startsWith(targetSlug + "-")` for either encoding. This catches the in-tree layout
   (`<mainSlug>--claude-worktrees-<branch>`) from the main clone only. It cannot catch the
   out-of-tree layout (`…-worktrees-<repo>-<branch>` is not prefixed by the main slug) or the
   reverse direction; that is a known limit of the fallback, called out in #145 itself.
   Gated on step 1, so `~` still does not fan out even when git is missing.

`--dir <path>` keeps meaning "this specific cwd" and fans out over **that** path's repo — the
flag selects the anchor, not the policy.

Scope: **Claude discovery only.** Pi's match is already containment
(`extensions/lib/harness/pi/discovery.ts:100`: `slug.includes(targetSlug)`), which by accident
already fans out over the in-tree worktree layout, and Pi has no worktree-switch mechanism that
rewrites its slug. Fanning Pi out as well is deferred, not forgotten.

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
tests/wtft-issue-144-145-164-session-discovery.test.ts   NEW
research/164-relocation-scan-probe.mjs       NEW (the measurement above)
```

Test seams: `WTFT_CLAUDE_PROJECTS_DIR` (existing) points discovery at a fixture tree;
`WTFT_NO_GIT=1` (new) forces the no-git fallback path so it can be exercised without
uninstalling git. Both are read at call time, never cached across a process.

---

# Verification criteria

Each is a concrete assertion in
`tests/wtft-issue-144-145-164-session-discovery.test.ts` unless stated otherwise, driven through
`WTFT_CLAUDE_PROJECTS_DIR` fixtures and the public `discoverSessions()` / `resolveLastCwd()` /
`buildDisplayPath()` interfaces — never module internals.

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
  from `resolveLastCwd` and contributes nothing to any target.
- **V9** — the gate holds: in a batch with one stranded transcript (last cwd removed) and one
  live-cwd transcript (`homebody`, last cwd exists), the whole-file history scan fires **at most
  once** — for the stranded one — never for `homebody`. `resolveCwdHistory` is called a second
  time during display (`displaySlugFor`), but the `(path, mtimeMs, size)` memo absorbs it, so the
  read counter still shows one scan, not two. Concretely: `getCwdHistoryReadCount() <= 1` after
  `discoverSessions("claude-code", clone)`, with `getCwdReadCount() > 0` confirming the cheap tail
  scan ran at all.
- **V10** — display prefers a live path: the V5 candidate's `displayPath` names the main clone,
  not the removed worktree.
- **V11 (cost, per #164)** — `resolveLastCwd` still resolves on a representative sample without
  widening, and `discoverSessions("claude-code", process.cwd())` over the real
  `~/.claude/projects` stays under the existing 500 ms ceiling. Skipped when
  `~/.claude/projects` is absent.

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

**Display (#145)**

- **V18** — `buildDisplayPath("x…5e9e.jsonl", "-home-<user>-git-projects-worktrees-demo-99-branch",
  "claude-code")` renders `~/g-p/demo/w/99-branch/...5e9e`.
- **V19** — `buildDisplayPath(…, "-home-<user>-git-projects-demo--claude-worktrees-99-branch", …)`
  renders `~/g-p/demo/w/99-branch/...5e9e`.
- **V20** — a project name with no digit segment (`worktrees-demo-scratch`) is left exactly as
  today, and a plain repo slug is unchanged.

**Whole-suite invariant**

- **V21** — `bun run test` is green: the pre-branch 43 suites plus this branch's own
  `wtft-issue-144-145-164-session-discovery` = 44, none regressed by this branch.

---

# Definition of done

V1–V21 pass, `bun run typecheck` is clean, and `bin/wtft.mjs` is rebuilt and committed with its
`.ts` sources. The union invariant is the thing to re-check on any later edit: **no arm of this
rule may ever be turned into a replacement.**

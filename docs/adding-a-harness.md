# Adding a harness to wtft

> **Provenance.** Ported from `princess-pi-tools` (removed there when wtft was
> extracted, #584). Bare issue numbers below (#144, #145, #164, #155, #149, #31)
> refer to **princess-pi-tools** issues; wtft's own issue numbering starts fresh.

Three steps. **No shared file is edited** — not `wtft-renderer.ts`, not `wtft-cost.ts`,
not `wtft-daemon-lib.ts`, not the selector's shared logic. If your harness needs one of
those touched, the seam is in the wrong place; file an issue rather than widening it.

---

## 1. `discovery` — where do this harness's transcripts live?

```ts
interface HarnessDiscovery {
  readonly id: string;     // must equal the directory name
  readonly label: string;  // selector column, e.g. "Codex"
  discover(targetCwd: string | null, scopeOpts?: DiscoverScopeOptions): SessionCandidate[];
  resolveSessionById(sessionId: string): string | null;
}
```

`discover` returns candidates for a target directory. You decide what a `null` target
means for your harness — Claude Code falls back to `process.cwd()`, Pi treats it as "no
filter". Both are policies, and both live inside their own discovery module.

`scopeOpts` is the scoped-picker seam (#89). **Omitted** means the PRE-#89 default —
whatever `discover` already did with just `targetCwd` — and every harness must keep that
behaviour exactly, since `discoverSessions()`'s own callers (tests, and any other tool
consuming this module) still get it that way. When it IS supplied, `scopeOpts.scope` is
one of `"worktree"` (folder match on `targetCwd` alone, no union arm), `"worktrees"`
(fan-out + the union arm, bounded by `scopeOpts.windowMs`), `"all"` (ignore `targetCwd`
entirely), or `"branch"` (the checkout of `targetCwd`'s current git branch — see
`harness/worktrees.ts`'s `resolveBranchCheckout`). `scopeOpts.windowMs` (`number | null`)
bounds every scope uniformly: skip a transcript whose mtime falls outside it, checked with
one `fs.statSync` before any read the union arm would otherwise pay for. **`"branch"`'s
fallback is a documented no-op at the DISCOVERY level, never a silent wrong scope:**
`resolveBranchCheckout` returning `null` (no git, not a repo, detached HEAD, or no checkout
reports that branch) means `discoverScoped` folder-matches the bare `targetCwd` instead —
the exact same population `"worktree"` scope would return. The interactive picker's
`session-selector.ts` also corrects its displayed scope LABEL back to "worktree" in that
case — see `docs/spec-89-scoped-picker.md`'s note on this — so a caller of THIS function
directly (not through the picker) gets the right candidates either way, but only the
picker itself also gets a label that matches them.

Both built-in harnesses split into a `discoverLegacy` function (unchanged from before #89)
plus a new `discoverScoped` function, selected by whether `scopeOpts` was passed — but they
are NOT otherwise identical: Pi's legacy default never fans out across worktrees (see the
`null`-target bullet below), Pi matches by *containment* (`slug.includes(variant)`) where
Claude Code matches by exact Set membership, and only Claude Code's directory walk calls
`countDirRead()` (`session-cwd.ts`'s `getDirWalkCount()` counts Claude Code's tree walk
only — Pi's `collect()` does not call it). A harness with no interest in the new scopes
may simply ignore `scopeOpts` — the seam is additive, and the interactive picker only
reaches the new scopes on an explicit keypress. **`windowMs` is enforced
defensively, `scope`/folder-matching is not (pr-review round 2, Medium).**
`discoverSessions()` in `session-selector.ts` — the ONE place every
`discover()` call is funneled through — post-filters every candidate against
`scopeOpts.windowMs` itself, so an out-of-tree harness that ignores the
option cannot inflate the no-TTY "exactly one candidate" check past what the
active time window actually allows, and the picker's "window: …" header stays
true regardless of that harness's own cooperation. There is no equivalent
backstop for `scope` itself — a harness that returns its full UNSCOPED list
under `"worktree"`/`"branch"` still shows sessions from outside the target
directory, since folder-matching has no single generic rule
`discoverSessions()` could apply on a harness's behalf. Honour `scopeOpts`
when you can; if you cannot yet, say so in your harness's own `discover`
docstring rather than leaving it to be discovered as a bug.

If your harness records a `cwd` on its transcript entries, apply the **union rule**:
include a transcript when its project-dir slug matches the target **or** its own recorded
last-cwd does. `resolveLastCwd()` from `harness/session-cwd.ts` does the tail scan and
memoises it. Union, not replacement — a last-cwd-only rule silently drops sessions whose
directory slug is a parent of their cwd.

The union has grown two more arms (#144/#145), each a shared helper you should reach for
rather than re-derive. Every one is **additive** — that is the invariant the whole rule is
measured against, and the reason none of them may be written as a replacement.

> **A third arm (#164) existed and was deleted by #89.** It matched a session whose last cwd
> had been *deleted* against every directory its transcript had ever recorded, which meant a
> whole-file read. Measured 2026-09-16 over 7,287 transcripts it cost 6,952 whole-file reads
> per launch and returned **0** candidates the physical arm had not. `resolveCwdHistory()`,
> `pickLiveCwd()` and `pathExists()` are **gone from `harness/session-cwd.ts`** — do not write
> a harness against them. If your transcripts record relocations and you find a case the
> physical arm misses, re-derive it from the transcript and say so on #89; the records are
> still there, nothing reads them.

- **Match the slug, do not compute it.** `cwdSlugVariants(cwd)` returns *every* known
  encoding, because what a harness munges beyond `/` is usually only partly evidenced —
  Claude Code turns `.` into `-` as well, which is how `.claude/worktrees` paths went
  missing. Match against ALL of them, not one. `slugMatchesCwd(slug, cwd)` is a ready-made
  exact-equality wrapper over `cwdSlugVariants` for a harness whose own directory name
  equals the encoded cwd outright — write your own membership test with `cwdSlugVariants`
  directly when your harness's naming isn't exact equality (neither built-in calls
  `slugMatchesCwd` itself: Claude Code builds a `Set` of variants and checks membership,
  Pi checks *containment* — `slug.includes(variant)` — because its directory name wraps
  the cwd slug rather than equalling it). If you need a single canonical string for
  *display*, that is `cwdToSlug()`. Pinning one encoding for matching trades a known
  silent miss for an unknown one.
- **"Here" may mean a whole repo.** `fanOutCwd(target)` returns every checkout of the
  target's git repo, so a session recorded in a sibling worktree is still found. It returns
  the target alone when there is no `.git` ancestor, which is what stops `~` from meaning
  the entire machine. Whether this fits your harness is a policy call, exactly like the
  `null`-target question above: Claude Code fans out, Pi does not.

- **Call `countDirRead()` from your own directory walk, if you have one.** It is
  `session-cwd.ts`'s test-seam counter (`getDirWalkCount()`) for how many directories a
  discovery pass reads — Claude Code's `collect()` calls it once per directory visited;
  Pi's own `collect()` does not, so the counter is Claude-Code-only today, not
  cross-harness. Not required, but a harness that skips it makes its own directory-walk
  cost invisible to that instrument.

None of this is required to ship a harness. A harness whose transcripts carry no `cwd`
resolves to `null` from `resolveLastCwd`, contributes nothing to any of these arms, and is
correct — that is Pi's situation when its transcript is large enough that `resolveLastCwd`'s
widening tail read never reaches the `session_start` entry (over roughly 512&nbsp;KB, the
last `TAIL_WINDOWS` step); a Pi transcript **under** that size gets its whole file read by
the same widening loop and DOES resolve its recorded `cwd` — deliberate, not a design gap,
since the union arm is a bonus find either way, but not literally "always null".

`resolveSessionById` is what lets a running daemon follow a session whose transcript moved
(#155). Return the newest match when an id appears more than once.

## 2. `parse` — what does this harness's entry schema mean?

```ts
interface HarnessParseAdapter {
  readonly id: string;
  matchAssistant(entry: any): AssistantTurn | null;
  readBlock(block: any): ParsedBlock | null;
  readControlEntry(entry: any): ControlSignal | null;
  readUncountedBillable?(entry: any): UncountedBillableClass | null;  // optional (#149)
}
```

This is **schema knowledge only**. Translate field locations and field names; do not
compute anything.

- `matchAssistant` — return `null` unless this entry is your harness's assistant turn.
  Fill `usage` with Anthropic-compat names, and set `nativeCost` only if your harness
  records a per-turn cost of its own (Pi does; Claude Code does not). A `nativeCost` you
  set here MUST NOT include server-side tool charges (web search/fetch) — wtft adds
  `serverToolCost` on top of it, so a native figure that already bills those is double
  counted (#118). If your harness's native cost already includes them, zero
  `server_tool_use` in `usage` instead of setting `nativeCost` around it.
- `readBlock` — one content block. Map your tool argument names to `files` / `commands`.
  Set `handled: false` for a tool you did not branch on, so shared category mapping gets a
  shot at it.
- `readControlEntry` — recognize non-assistant entries that change how following turns
  read: model switches, thinking level, compaction markers, interrupts. Every registered
  adapter is consulted for every entry, first match wins.
- `readUncountedBillable` — **optional** (#149). Recognize an entry that stands for an API
  call your harness *bills for* but writes no `usage` object for, and return its class
  (`"compaction"` | `"recap"`). wtft counts these and prints them as an `UNCOUNTED` line
  under `--tokens`; it never prices them, because the dollars reach no file a parser can
  read. Omit the method entirely and your harness simply reports no blind spot — the
  out-of-tree loader does not require it, so an adapter written before #149 stays valid.
  Same first-match-wins consultation order as `readControlEntry`, and for the same reason:
  one entry must not be counted twice. Measured motivation: 4.72% of Claude Code's own
  `total_cost_usd` across seven logged sessions was spend of this kind — see
  `docs/spec-149-compaction-cost-scope.md`.

Cost, cache-miss observation, the meter-split, dedup, classification and every renderer are
inherited. That is the point.

## 3. Register it

**In-repo** — put the two files at `extensions/lib/harness/<id>/discovery.ts` and
`extensions/lib/harness/<id>/parse.ts`, then `bun run build`. `build.ts` scans the
directory and regenerates `harness/builtins.generated.ts`; your harness is in the table.

**Out-of-tree** — ship `.mjs` and point config at it. No rebuild:

```jsonc
// ~/.config/wtft/harnesses.json
{
  "codex": {
    "label": "Codex",
    "discovery": "~/.config/wtft/harness/codex/discovery.mjs",
    "parse":     "~/.config/wtft/harness/codex/parse.mjs"
  }
}
```

`.mjs` only — stock node cannot import `.ts`, and requiring node ≥ 22.6 type-stripping from
a global install was ruled out in #31.

The same file disables a built-in:

```jsonc
{ "pi": { "enabled": false } }
```

---

## The worked example

`research/156-codex-harness-sketch/` is a complete third harness with a schema deliberately
unlike both built-ins — `{kind: "turn"}` assistant entries, `{op: "call"}` tool blocks, and
a third set of usage field names. It is exercised end to end by
`tests/wtft-issue-156-harness-seam.test.ts`, which asserts it discovers, parses, prices and
classifies through the registry with no shared file edited.

That test is the acceptance criterion for the seam. If it ever needs a change in
`extensions/lib/*.ts` to keep passing, the seam moved and the design is not done.

---

*Built by the AI Princess Pi. Inspired by her human, Duppy (github.com/duppypro)*
